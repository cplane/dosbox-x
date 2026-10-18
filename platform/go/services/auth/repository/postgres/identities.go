package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"dosbox/core/auth"
	"dosbox/services/auth/repository"
)

type Identities struct{ db *sql.DB }

func NewIdentities(db *sql.DB) *Identities { return &Identities{db: db} }

const identityColumns = `id, username, COALESCE(email, ''), COALESCE(password_hash, ''),
	COALESCE(google_subject, ''), role, created_at, updated_at`

func (r *Identities) Create(ctx context.Context, identity repository.Identity) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO identity (id, username, email, password_hash, google_subject, role)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		identity.Id, identity.Username,
		nullable(identity.Email), nullable(identity.PasswordHash), nullable(identity.GoogleSubject),
		string(identity.Role))
	if err != nil {
		// Any of the three unique indexes: username, email or google_subject.
		// They collapse into one error on purpose — telling a stranger which
		// one they collided with is an account enumeration oracle.
		if isUniqueViolation(err) {
			return repository.ErrTaken
		}
		return fmt.Errorf("creating identity: %w", err)
	}
	return nil
}

func (r *Identities) ById(ctx context.Context, id uuid.UUID) (repository.Identity, error) {
	return r.one(ctx, `SELECT `+identityColumns+` FROM identity WHERE id = $1`, id)
}

func (r *Identities) ByUsername(ctx context.Context, username string) (repository.Identity, error) {
	return r.one(ctx, `SELECT `+identityColumns+` FROM identity WHERE lower(username) = lower($1)`, username)
}

func (r *Identities) ByEmail(ctx context.Context, email string) (repository.Identity, error) {
	return r.one(ctx, `SELECT `+identityColumns+` FROM identity WHERE lower(email) = lower($1)`, email)
}

func (r *Identities) ByGoogleSubject(ctx context.Context, subject string) (repository.Identity, error) {
	return r.one(ctx, `SELECT `+identityColumns+` FROM identity WHERE google_subject = $1`, subject)
}

// LinkGoogleSubject binds a provider to an account that already exists, so
// somebody who signed up with a password can later use the Google button and
// keep the same id — and therefore the same match history.
func (r *Identities) LinkGoogleSubject(ctx context.Context, id uuid.UUID, subject string) error {
	result, err := r.db.ExecContext(ctx, `
		UPDATE identity SET google_subject = $2, updated_at = now()
		WHERE id = $1 AND google_subject IS NULL`, id, subject)
	if err != nil {
		if isUniqueViolation(err) {
			return repository.ErrTaken
		}
		return fmt.Errorf("linking google subject: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("linking google subject: %w", err)
	}
	if affected == 0 {
		return repository.ErrNotFound
	}
	return nil
}

func (r *Identities) one(ctx context.Context, query string, args ...any) (repository.Identity, error) {
	var identity repository.Identity
	var role string

	err := r.db.QueryRowContext(ctx, query, args...).Scan(
		&identity.Id, &identity.Username, &identity.Email, &identity.PasswordHash,
		&identity.GoogleSubject, &role, &identity.CreatedAt, &identity.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return repository.Identity{}, repository.ErrNotFound
	}
	if err != nil {
		return repository.Identity{}, fmt.Errorf("reading identity: %w", err)
	}

	identity.Role = auth.Role(role)
	if !identity.Role.Valid() {
		identity.Role = auth.RolePlayer
	}
	return identity, nil
}

// nullable keeps empty strings out of columns whose partial unique indexes
// depend on null meaning "absent". Two accounts with email ” would collide;
// two with NULL do not.
func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func isUniqueViolation(err error) bool {
	// SQLSTATE 23505. Matching on the text keeps pgx's error types out of the
	// repository's signature for a check this small.
	return err != nil && strings.Contains(err.Error(), "SQLSTATE 23505")
}
