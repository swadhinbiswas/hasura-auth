import express, {
  NextFunction,
  RequestHandler,
  Response,
  Request,
  Router,
} from 'express';
import passport, { Profile } from 'passport';
import { VerifyCallback } from 'passport-oauth2';
import refresh from 'passport-oauth2-refresh';
import { Strategy } from 'passport';
import { v4 as uuidv4 } from 'uuid';

import { PROVIDERS } from '@config';
import {
  Joi,
  email as emailValidator,
  uuid,
  queryValidator,
  registrationOptions,
} from '@/validation';
import { UserFieldsFragment } from '@/utils/__generated__/graphql-request';
import {
  asyncWrapper,
  getNewRefreshToken,
  gqlSdk,
  getUserByEmail,
  insertUser,
  getGravatarUrl,
  ENV,
} from '@/utils';
import {
  SocialProvider,
  UserRegistrationOptions,
  UserRegistrationOptionsWithRedirect,
} from '@/types';
import { decodeJwt, JWTPayload } from 'jose';

export const providerCallbackQuerySchema = Joi.object({
  state: uuid.required(),
}).unknown(true);

type ProviderCallbackQuery = Record<string, unknown> & {
  state: string;
};

type RequestWithState<Q = {}, B = {}> = Request<
  {},
  {},
  B,
  Q & { state: string }
> & {
  state: string;
};

interface Constructable<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new (...args: any[]): T;
  prototype: T;
}

export type TransformProfileFunction = <T extends Profile>(
  profile: T
) => { id: string; email: string; displayName: string; avatarUrl: string };

interface InitProviderSettings {
  transformProfile: TransformProfileFunction;
  callbackMethod: 'GET' | 'POST';
}

const manageProviderStrategy =
  (provider: string, transformProfile: TransformProfileFunction) =>
  async (
    req: RequestWithState<ProviderCallbackQuery>,
    accessToken: string,
    refreshToken: string,
    profile: Profile,
    done: VerifyCallback
  ): Promise<void> => {
    const state = req.query.state;

    const requestOptions = await gqlSdk
      .providerRequest({
        id: state,
      })
      .then((res) => res.authProviderRequest?.options);

    // find or create the user
    // check if user exists, using profile.id
    const { id, email, displayName, avatarUrl } = transformProfile(profile);

    // check if user already exist with `id` (unique id from provider)
    const userProvider = await gqlSdk
      .authUserProviders({
        provider,
        providerUserId: id.toString(),
      })
      .then((res) => {
        return res.authUserProviders[0];
      });

    // User is already registered
    if (userProvider) {
      await gqlSdk.updateAuthUserprovider({
        id: userProvider.id,
        authUserProvider: {
          accessToken,
          refreshToken,
        },
      });

      return done(null, userProvider.user);
    }

    if (email) {
      try {
        await emailValidator.validateAsync(email);
      } catch {
        return done(new Error('email is not allowed'));
      }

      const user = await getUserByEmail(email);

      if (user) {
        // add this provider to existing user with the same email
        const insertedAuthUserprovider = await gqlSdk
          .insertUserProviderToUser({
            userProvider: {
              userId: user.id,
              providerId: provider,
              providerUserId: id.toString(),
              accessToken,
              refreshToken,
            },
          })
          .then((res) => res.insertAuthUserProvider);

        if (!insertedAuthUserprovider) {
          throw new Error('Could not insert provider to user');
        }

        return done(null, user);
      }
    }

    const {
      defaultRole,
      locale,
      allowedRoles,
      metadata,
    }: UserRegistrationOptions = requestOptions;

    const insertedUser = await insertUser({
      email,
      passwordHash: null,
      emailVerified: !!email,
      defaultRole,
      locale,
      roles: {
        data: allowedRoles.map((role) => ({
          role,
        })),
      },
      displayName: requestOptions.displayName || displayName || email,
      avatarUrl,
      metadata,
      userProviders: {
        data: [
          {
            providerUserId: id.toString(),
            accessToken,
            refreshToken,
            providerId: provider,
          },
        ],
      },
    });

    return done(null, insertedUser);
  };

const providerCallback = asyncWrapper(
  async (req: RequestWithState, res: Response): Promise<void> => {
    // Successful authentication, redirect home.
    // generate tokens and redirect back home

    req.state = req.query.state;

    const requestOptions = await gqlSdk
      .deleteProviderRequest({
        id: req.state,
      })
      .then((res) => res.deleteAuthProviderRequest?.options);

    const user = req.user as UserFieldsFragment;

    const refreshToken = await getNewRefreshToken(user.id);

    // redirect back user to app url
    // ! temparily send the refresh token in both hash and query parameter
    // TODO at a later stage, only send as a query parameter
    res.redirect(
      `${requestOptions.redirectTo}?refreshToken=${refreshToken}#refreshToken=${refreshToken}`
    );
  }
);

export const initProvider = <T extends Strategy>(
  router: Router,
  strategyName: SocialProvider,
  strategy: Constructable<T>,
  settings: InitProviderSettings & ConstructorParameters<Constructable<T>>[0], // TODO: Strategy option type is not inferred correctly
  middleware?: RequestHandler
): void => {
  const {
    transformProfile = ({
      id,
      emails,
      displayName,
      photos,
    }: Profile): {
      id: string;
      email?: string;
      displayName: string;
      avatarUrl?: string;
    } => ({
      id,
      email: emails?.[0]?.value,
      displayName: displayName,
      avatarUrl: photos?.[0]?.value || getGravatarUrl(emails?.[0].value),
    }),
    callbackMethod = 'GET',
    ...options
  } = settings;

  const subRouter = Router();

  if (middleware) {
    subRouter.use(middleware);
  }

  if (PROVIDERS[strategyName]) {
    let strategyToUse;

    // Apple is special
    if (strategyName === 'apple') {
      strategyToUse = new strategy(
        {
          ...PROVIDERS[strategyName],
          ...options,
          callbackURL: `${ENV.AUTH_SERVER_URL}/signin/provider/${strategyName}/callback`,
          passReqToCallback: true,
        },
        async (
          req: RequestWithState<ProviderCallbackQuery, { user: string }>,
          accessToken: string,
          refreshToken: string,
          idToken: string,
          _profile: unknown,
          done: VerifyCallback
        ) => {
          const provider = 'apple';
          const state = req.query.state;

          const {
            sub: id,
            email,
            email_verified: emailVerified,
          }: JWTPayload & {
            email?: string;
            email_verified?: boolean;
          } = decodeJwt(idToken);

          if (!id) {
            return done(new Error('no id found in the JWT'));
          }

          const requestOptions = await gqlSdk
            .providerRequest({
              id: state,
            })
            .then((res) => res.authProviderRequest?.options);

          // check if user already exist with `id` (unique id from provider)
          const userProvider = await gqlSdk
            .authUserProviders({
              provider,
              providerUserId: id.toString(),
            })
            .then((res) => {
              return res.authUserProviders[0];
            });

          // User is already registered
          if (userProvider) {
            await gqlSdk.updateAuthUserprovider({
              id: userProvider.id,
              authUserProvider: {
                accessToken,
                refreshToken,
              },
            });

            return done(null, userProvider.user);
          }

          if (email) {
            try {
              await emailValidator.validateAsync(email);
            } catch {
              return done(new Error('email is not allowed'));
            }

            const user = await getUserByEmail(email);

            if (user) {
              // add this provider to existing user with the same email
              const insertedAuthUserprovider = await gqlSdk
                .insertUserProviderToUser({
                  userProvider: {
                    userId: user.id,
                    providerId: provider,
                    providerUserId: id.toString(),
                    accessToken,
                    refreshToken,
                  },
                })
                .then((res) => res.insertAuthUserProvider);

              if (!insertedAuthUserprovider) {
                throw new Error('Could not insert provider to user');
              }

              return done(null, user);
            }
          }

          const {
            defaultRole,
            locale,
            allowedRoles,
            metadata,
          }: UserRegistrationOptions = requestOptions;

          // get user from request
          let user;
          let displayName;
          try {
            user = JSON.parse(req.body.user);
            displayName = `${user.name.firstName} ${user.name.lastName}`;
          } catch (error) {
            // noop
          }

          const insertedUser = await insertUser({
            email,
            passwordHash: null,
            emailVerified,
            defaultRole,
            locale,
            roles: {
              data: allowedRoles.map((role) => ({
                role,
              })),
            },
            displayName: requestOptions.displayName || displayName || email,
            avatarUrl: '',
            metadata,
            userProviders: {
              data: [
                {
                  providerUserId: id.toString(),
                  accessToken,
                  refreshToken,
                  providerId: provider,
                },
              ],
            },
          });

          done(null, insertedUser);
        }
      );
    } else {
      strategyToUse = new strategy(
        {
          ...PROVIDERS[strategyName],
          ...options,
          callbackURL: `${ENV.AUTH_SERVER_URL}/signin/provider/${strategyName}/callback`,
          passReqToCallback: true,
        },
        manageProviderStrategy(strategyName, transformProfile)
      );
    }

    passport.use(strategyName, strategyToUse);
    if (strategyName !== 'workos') {
      // ! provider token rotation does not work with `passport-workos`.
      // ! The only impacted endpoint is /user/provider/tokens
      // @ts-expect-error
      refresh.use(strategyToUse);
    }
  }

  subRouter.get('/', [
    queryValidator(registrationOptions),
    asyncWrapper(
      async (
        req: RequestWithState<UserRegistrationOptionsWithRedirect>,
        res: Response,
        next: NextFunction
      ) => {
        req.state = uuidv4();
        // insert request metadata object with the request state as id
        await gqlSdk.insertProviderRequest({
          providerRequest: {
            id: req.state,
            options: req.query,
          },
        });

        next();
      }
    ),
    (
      req: RequestWithState<UserRegistrationOptionsWithRedirect>,
      ...rest: unknown[]
    ) => {
      return passport.authenticate(strategyName, {
        session: false,
        state: req.state,
        ...options,
      })(req, ...rest);
    },
  ]);

  const handlers = [
    passport.authenticate(strategyName, {
      session: false,
    }),
    queryValidator(providerCallbackQuerySchema),
    providerCallback,
  ];

  if (callbackMethod === 'POST') {
    // The Sign in with Apple auth provider requires a POST route for authentication
    subRouter.post(
      '/callback',
      express.urlencoded({ extended: true }),
      ...handlers
    );
  } else {
    subRouter.get('/callback', ...handlers);
  }

  router.use(`/${strategyName}`, subRouter);
};
