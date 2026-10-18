// Package auth wires the authentication service.
package auth

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/caarlos0/env"
	"github.com/gorilla/mux"
	"github.com/sirupsen/logrus"
	"go.uber.org/fx"

	coreauth "dosbox/core/auth"
	"dosbox/services/auth/httphandler"
	"dosbox/services/auth/repository"
	"dosbox/services/auth/repository/postgres"
	"dosbox/services/auth/service"
)

type (
	Config struct {
		HttpServicePort int `env:"HTTP_SERVICE_PORT" envDefault:"8080"`

		// Required. Holds the identity and refresh_token tables; the same
		// database the gateway will use for matches, because this is one
		// product with one deploy.
		PostgresURL string `env:"AUTH_POSTGRES_URL"`

		// The signing key must outlive the pod: regenerating it invalidates
		// every access token in the wild. Hence a volume, and hence a single
		// replica with Recreate.
		PrivateKeyPath string `env:"AUTH_PRIVATE_KEY_PATH" envDefault:"/certs/auth.key"`
		PublicKeyPath  string `env:"AUTH_PUBLIC_KEY_PATH" envDefault:"/certs/auth.pub"`

		TokenIssuer string `env:"AUTH_TOKEN_ISSUER" envDefault:"dosbox-auth"`

		// The access TTL is the only revocation lag in the system: nothing
		// hits the database to validate an access token, which is the point
		// of signing one. Shorten it if revocation ever needs to bite faster.
		AccessTTL  time.Duration `env:"AUTH_ACCESS_TTL" envDefault:"1h"`
		RefreshTTL time.Duration `env:"AUTH_REFRESH_TTL" envDefault:"2160h"`
		// Covers two tabs racing a refresh. See service.Refresh.
		RotationGrace time.Duration `env:"AUTH_ROTATION_GRACE" envDefault:"10s"`

		// Empty disables the Google door entirely, rather than leaving a
		// route that cannot verify anything.
		GoogleClientID string `env:"AUTH_GOOGLE_CLIENT_ID"`

		// Mark session cookies Secure unconditionally. Production sets this
		// because the load balancer terminates TLS and the ingress rewrites
		// X-Forwarded-Proto, so the request never says https by itself.
		CookieSecure bool `env:"AUTH_COOKIE_SECURE" envDefault:"false"`
	}

	ServiceParameters struct {
		fx.In

		Config  *Config
		Router  *mux.Router
		Handler *httphandler.Handler
		DB      *sql.DB
		Tokens  repository.RefreshTokens
	}
)

var Module = fx.Options(
	fx.Provide(
		NewConfig,
		mux.NewRouter,
		NewDatabase,
		NewIdentities,
		NewRefreshTokens,
		NewSigner,
		NewVerifier,
		NewGoogleVerifier,
		NewService,
		NewHandler,
	),
	fx.Invoke(RunService),
)

func NewConfig() (*Config, error) {
	cfg := &Config{}
	if err := env.Parse(cfg); err != nil {
		return nil, fmt.Errorf("parsing configuration: %w", err)
	}
	if cfg.PostgresURL == "" {
		return nil, fmt.Errorf("AUTH_POSTGRES_URL is required")
	}
	return cfg, nil
}

// NewDatabase connects and migrates before anything else is provided, so a
// deployment that cannot reach or migrate its database fails at boot rather
// than at the first player's sign-in.
func NewDatabase(lc fx.Lifecycle, cfg *Config) (*sql.DB, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	db, err := postgres.Open(ctx, cfg.PostgresURL)
	if err != nil {
		return nil, err
	}
	if err := postgres.Migrate(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}

	lc.Append(fx.Hook{OnStop: func(context.Context) error { return db.Close() }})
	return db, nil
}

func NewIdentities(db *sql.DB) repository.Identities {
	return postgres.NewIdentities(db)
}

func NewRefreshTokens(db *sql.DB) repository.RefreshTokens {
	return postgres.NewRefreshTokens(db)
}

func NewSigner(cfg *Config) (*coreauth.Signer, error) {
	key, err := coreauth.LoadOrGenerateRSAKeyPair(cfg.PrivateKeyPath, cfg.PublicKeyPath)
	if err != nil {
		return nil, err
	}
	return coreauth.NewSigner(key, cfg.TokenIssuer), nil
}

// NewVerifier verifies with our own public key. Only /session needs it — the
// gateway fetches the key over HTTP instead, so it does not need the database
// credentials this service has.
func NewVerifier(cfg *Config, signer *coreauth.Signer) (coreauth.Verifier, error) {
	pem, err := signer.PublicKeyPEM()
	if err != nil {
		return nil, err
	}
	key, err := coreauth.ParsePublicKeyPEM(pem)
	if err != nil {
		return nil, err
	}
	return coreauth.NewVerifier(key, cfg.TokenIssuer), nil
}

func NewGoogleVerifier(cfg *Config) (*service.GoogleVerifier, error) {
	verifier, err := service.NewGoogleVerifier(context.Background(), cfg.GoogleClientID)
	if err != nil {
		// A misconfigured provider must not take the whole service down; the
		// password door still works and the login page is told the Google
		// button is unavailable.
		logrus.WithError(err).Error("google sign-in unavailable")
		return nil, nil
	}
	return verifier, nil
}

func NewService(identities repository.Identities, tokens repository.RefreshTokens, signer *coreauth.Signer, cfg *Config) *service.Service {
	return service.New(identities, tokens, signer, service.Config{
		AccessTTL:     cfg.AccessTTL,
		RefreshTTL:    cfg.RefreshTTL,
		RotationGrace: cfg.RotationGrace,
	})
}

func NewHandler(router *mux.Router, svc *service.Service, google *service.GoogleVerifier,
	signer *coreauth.Signer, verifier coreauth.Verifier, cfg *Config) *httphandler.Handler {
	return httphandler.New(router, svc, google, signer, verifier, httphandler.Config{
		AccessTTL:  cfg.AccessTTL,
		RefreshTTL: cfg.RefreshTTL,
		// Empty unless a verifier was actually built: a configured client id
		// that failed OIDC discovery must not advertise a door that cannot
		// verify anything.
		GoogleClientID: googleClientID(google, cfg.GoogleClientID),
		CookieSecure:   cfg.CookieSecure,
	})
}

func RunService(lc fx.Lifecycle, params ServiceParameters) error {
	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", params.Config.HttpServicePort))
	if err != nil {
		return fmt.Errorf("listening: %w", err)
	}
	server := &http.Server{Handler: params.Router}

	sweeper := time.NewTicker(6 * time.Hour)

	lc.Append(fx.Hook{
		OnStart: func(context.Context) error {
			go func() {
				if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
					logrus.WithError(err).Error("auth server stopped")
				}
			}()
			// Expired refresh rows are dead weight; a 90-day TTL means they
			// accumulate for a long time before anyone notices.
			go func() {
				for range sweeper.C {
					removed, err := params.Tokens.DeleteExpired(context.Background(), time.Now())
					if err != nil {
						logrus.WithError(err).Warn("sweeping expired refresh tokens")
						continue
					}
					if removed > 0 {
						logrus.WithField("count", removed).Info("swept expired refresh tokens")
					}
				}
			}()
			logrus.WithField("port", params.Config.HttpServicePort).Info("auth listening")
			return nil
		},
		OnStop: func(ctx context.Context) error {
			sweeper.Stop()
			return server.Shutdown(ctx)
		},
	})
	return nil
}

func googleClientID(verifier *service.GoogleVerifier, configured string) string {
	if verifier == nil {
		return ""
	}
	return configured
}
