// Command gateway runs the dos-box platform API (see package gateway).
//
//	gateway                      serve
//	gateway catalog-put [flags]  add or replace a catalog item from a tar
//	                             on stdin (seeding; run in the gateway pod)
package main

import (
	"context"
	"errors"
	"flag"
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
	run := serve
	if len(os.Args) > 1 && os.Args[1] == "catalog-put" {
		run = catalogPut
	}
	if err := run(); err != nil {
		logrus.WithError(err).Fatal("gateway")
	}
}

func config() (*gateway.Config, error) {
	cfg := &gateway.Config{}
	if err := env.Parse(cfg); err != nil {
		return nil, fmt.Errorf("configuration: %w", err)
	}
	if cfg.PostgresURL == "" {
		return nil, errors.New("GATEWAY_POSTGRES_URL is required")
	}
	return cfg, nil
}

func serve() error {
	cfg, err := config()
	if err != nil {
		return err
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
	blob, err := gateway.NewSpaces(ctx, cfg)
	if err != nil {
		// The catalog still serves from the volume; Sync uploads later.
		logrus.WithError(err).Error("catalog: Spaces unavailable, volume only")
	} else if blob == nil {
		logrus.Warn("catalog: no Spaces configured, volume only")
	}
	if blob != nil {
		srv.Catalog().UseBlob(blob)
	}
	go srv.Catalog().RunSync(ctx, time.Hour)
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

// catalogPut: kubectl exec -i deploy/dosbox-gateway -- /app/gateway catalog-put
// --slug keen1 --title "Commander Keen 1" --dir KEEN1 --run KEEN1.EXE < keen1.tar
// Having the cluster access to run this is the admin credential.
func catalogPut() error {
	fs := flag.NewFlagSet("catalog-put", flag.ContinueOnError)
	var it gateway.CatalogItem
	fs.StringVar(&it.Slug, "slug", "", "item id: a-z, 0-9, - (required)")
	fs.StringVar(&it.Title, "title", "", "display title (required)")
	fs.StringVar(&it.Category, "category", "app", "game, app, dev, util, demo or other")
	fs.StringVar(&it.Description, "description", "", "one or two sentences")
	fs.StringVar(&it.Dir, "dir", "", "folder on C:, DOS 8.3 (required)")
	fs.StringVar(&it.Run, "run", "", `program that starts it, e.g. KEEN1.EXE or BIN\TC.EXE`)
	fs.StringVar(&it.Source, "source", "", "where the files came from")
	fs.StringVar(&it.License, "license", "", "license / redistribution note")
	if err := fs.Parse(os.Args[2:]); err != nil {
		return err
	}
	cfg, err := config()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	store, db, err := gateway.OpenStore(ctx, cfg.PostgresURL)
	if err != nil {
		return err
	}
	defer db.Close()
	blob, err := gateway.NewSpaces(ctx, cfg)
	if err != nil {
		logrus.WithError(err).Warn("Spaces unavailable: the item goes to the volume only (sync uploads it later)")
		blob = nil
	}
	cat := gateway.NewCatalog(cfg.BoxesDir, blob, store, cfg.CatalogMaxItemMB)
	it.CreatedBy, it.CreatedAt = "catalog-put", time.Now().UTC()
	got, err := cat.PutFromTar(ctx, it, os.Stdin)
	if err != nil {
		return err
	}
	fmt.Printf("%s: %d files, %d bytes, ready\n", got.Slug, got.Files, got.SizeBytes)
	return nil
}
