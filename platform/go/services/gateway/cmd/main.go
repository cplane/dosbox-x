// Command gateway runs the dos-box platform API (see package gateway).
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/caarlos0/env"
	"github.com/sirupsen/logrus"

	"dosbox/core/auth"
	"dosbox/services/gateway"
)

func main() {
	logrus.SetOutput(os.Stdout)
	logrus.SetFormatter(&logrus.TextFormatter{DisableTimestamp: true, DisableLevelTruncation: true})
	if err := run(); err != nil {
		logrus.WithError(err).Fatal("gateway")
	}
}

func run() error {
	cfg := &gateway.Config{}
	if err := env.Parse(cfg); err != nil {
		return fmt.Errorf("configuration: %w", err)
	}
	if cfg.PostgresURL == "" {
		return errors.New("GATEWAY_POSTGRES_URL is required")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	bootCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	store, db, err := gateway.OpenStore(bootCtx, cfg.PostgresURL)
	cancel()
	if err != nil {
		return err
	}
	defer db.Close()
	kube, err := gateway.NewInClusterKube(cfg.Namespace)
	if err != nil {
		return err
	}
	verifier, err := auth.NewRemoteVerifier(auth.RemoteConfig{ServerURL: cfg.AuthURL, Issuer: cfg.AuthIssuer})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(cfg.BoxesDir, 0o755); err != nil {
		return err
	}

	srv := gateway.NewServer(cfg, store, kube, verifier)
	go srv.RunJanitor(ctx, 30*time.Second)
	hs := &http.Server{Addr: fmt.Sprintf(":%d", cfg.Port), Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shut, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		hs.Shutdown(shut)
	}()
	logrus.WithField("port", cfg.Port).Info("gateway listening")
	if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
