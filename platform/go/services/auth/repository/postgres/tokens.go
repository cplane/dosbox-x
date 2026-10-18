package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"dosbox/services/auth/repository"
)

type RefreshTokens struct{ db *sql.DB }

func NewRefreshTokens(db *sql.DB) *RefreshTokens { return &RefreshTokens{db: db} }

func (r *RefreshTokens) Create(ctx context.Context, token repository.RefreshToken) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO refresh_token (id, identity_id, token_hash, issued_at, expires_at)
		VALUES ($1, $2, $3, $4, $5)`,
		token.Id, token.IdentityId, token.TokenHash, token.IssuedAt, token.ExpiresAt)
	if err != nil {
		return fmt.Errorf("storing refresh token: %w", err)
	}
	return nil
}

func (r *RefreshTokens) ByHash(ctx context.Context, hash string) (repository.RefreshToken, error) {
	var token repository.RefreshToken
	err := r.db.QueryRowContext(ctx, `
		SELECT id, identity_id, token_hash, issued_at, expires_at, revoked_at, replaced_by
		FROM refresh_token WHERE token_hash = $1`, hash).
		Scan(&token.Id, &token.IdentityId, &token.TokenHash, &token.IssuedAt,
			&token.ExpiresAt, &token.RevokedAt, &token.ReplacedBy)
	if errors.Is(err, sql.ErrNoRows) {
		return repository.RefreshToken{}, repository.ErrNotFound
	}
	if err != nil {
		return repository.RefreshToken{}, fmt.Errorf("reading refresh token: %w", err)
	}
	return token, nil
}

// Rotate spends one token and issues its successor in a single transaction.
//
// The two halves must not be separable. Revoke-then-issue leaves a window
// where a crash logs the player out through no fault of their own, and
// issue-then-revoke leaves one where both tokens are live — which is the
// thing rotation exists to prevent.
func (r *RefreshTokens) Rotate(ctx context.Context, spent uuid.UUID, next repository.RefreshToken) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("rotating refresh token: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO refresh_token (id, identity_id, token_hash, issued_at, expires_at)
		VALUES ($1, $2, $3, $4, $5)`,
		next.Id, next.IdentityId, next.TokenHash, next.IssuedAt, next.ExpiresAt); err != nil {
		return fmt.Errorf("rotating refresh token: %w", err)
	}

	// replaced_by is what marks this as spent-by-rotation rather than
	// signed-out, which is the difference the grace window turns on. The
	// revoked_at IS NULL guard makes a replayed token a no-op instead of a
	// second successor.
	result, err := tx.ExecContext(ctx, `
		UPDATE refresh_token SET revoked_at = now(), replaced_by = $2
		WHERE id = $1 AND revoked_at IS NULL`, spent, next.Id)
	if err != nil {
		return fmt.Errorf("rotating refresh token: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("rotating refresh token: %w", err)
	}
	if affected == 0 {
		return repository.ErrNotFound
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("rotating refresh token: %w", err)
	}
	return nil
}

// Revoke marks a token spent with no successor, which is what signing out
// means and what the grace window must never forgive.
func (r *RefreshTokens) Revoke(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE refresh_token SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, id)
	if err != nil {
		return fmt.Errorf("revoking refresh token: %w", err)
	}
	return nil
}

func (r *RefreshTokens) RevokeAllFor(ctx context.Context, identityId uuid.UUID) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE refresh_token SET revoked_at = now() WHERE identity_id = $1 AND revoked_at IS NULL`,
		identityId)
	if err != nil {
		return fmt.Errorf("revoking refresh tokens: %w", err)
	}
	return nil
}

// DeleteExpired keeps the table from growing without bound. Rows are only
// removed well after expiry so a rotation chain stays inspectable for a while
// if a session goes wrong.
func (r *RefreshTokens) DeleteExpired(ctx context.Context, before time.Time) (int64, error) {
	result, err := r.db.ExecContext(ctx, `DELETE FROM refresh_token WHERE expires_at < $1`, before)
	if err != nil {
		return 0, fmt.Errorf("deleting expired refresh tokens: %w", err)
	}
	return result.RowsAffected()
}
