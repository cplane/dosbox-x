// Package postgres implements the auth storage interfaces.
//
// Plain database/sql over pgx rather than an ORM: there are two tables, the
// queries are short, and the schema is worth being able to read as SQL. An
// ORM's automigration would also make the schema a side effect of Go struct
// tags, which is harder to review than a migration file.
package postgres

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

//go:embed migration/*.sql
var migrations embed.FS

// Named rather than left to goose's default, because the gateway migrates
// this same database. goose's table name is a package global: whichever
// service set it last would decide where the other reads its version, and a
// service reading someone else's version table concludes it has nothing to
// migrate and comes up against a schema that does not exist.
const versionTable = "auth_db_version"

// Open connects and verifies the connection before returning, so a bad URL
// fails at boot rather than on the first player's sign-in.
func Open(ctx context.Context, url string) (*sql.DB, error) {
	db, err := sql.Open("pgx", url)
	if err != nil {
		return nil, fmt.Errorf("opening postgres: %w", err)
	}

	// The auth service is not a busy one; a small pool avoids holding
	// connections a managed cluster charges for.
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(30 * time.Minute)

	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("connecting to postgres: %w", err)
	}
	return db, nil
}

// Migrate brings the schema up to date on boot.
//
// On boot rather than in an init container or a separate job: there is one
// writer of these tables, the migrations are embedded in the same binary that
// runs them, and a deployment that cannot migrate should not come up serving
// the old schema.
func Migrate(ctx context.Context, db *sql.DB) error {
	goose.SetBaseFS(migrations)
	goose.SetTableName(versionTable)
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("selecting migration dialect: %w", err)
	}
	if err := goose.UpContext(ctx, db, "migration"); err != nil {
		return fmt.Errorf("running migrations: %w", err)
	}
	return nil
}
