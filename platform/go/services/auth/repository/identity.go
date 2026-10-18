// Package repository is the storage boundary for auth: domain types and the
// interfaces the service talks to, with no SQL in sight.
package repository

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"dosbox/core/auth"
)

var (
	ErrNotFound = errors.New("auth: identity not found")
	// ErrTaken is returned for a username, email or provider subject that
	// already belongs to someone. The service maps it to one message for all
	// three, so signup cannot be used to enumerate who has an account.
	ErrTaken = errors.New("auth: already registered")
)

// Identity is an account as stored. It carries the secret material the domain
// type in core/auth deliberately does not, which is why the two are separate.
type Identity struct {
	Id            uuid.UUID
	Username      string
	Email         string
	PasswordHash  string
	GoogleSubject string
	Role          auth.Role
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// Public strips the stored secrets, producing what a token may carry.
func (i Identity) Public() auth.Identity {
	return auth.Identity{Id: i.Id, Username: i.Username, Role: i.Role}
}

// HasPassword reports whether the password door is open for this account.
// Federated accounts have no hash, and must not be sign-in-able by guessing
// an empty one.
func (i Identity) HasPassword() bool { return i.PasswordHash != "" }

type RefreshToken struct {
	Id         uuid.UUID
	IdentityId uuid.UUID
	TokenHash  string
	IssuedAt   time.Time
	ExpiresAt  time.Time
	RevokedAt  *time.Time
	ReplacedBy *uuid.UUID
}

func (t RefreshToken) Revoked() bool { return t.RevokedAt != nil }

// SpentByRotation reports whether this token was consumed by a refresh rather
// than by signing out. Only the former may be forgiven inside the grace
// window.
func (t RefreshToken) SpentByRotation() bool { return t.Revoked() && t.ReplacedBy != nil }

type Identities interface {
	Create(ctx context.Context, identity Identity) error
	ById(ctx context.Context, id uuid.UUID) (Identity, error)
	ByUsername(ctx context.Context, username string) (Identity, error)
	ByGoogleSubject(ctx context.Context, subject string) (Identity, error)
	ByEmail(ctx context.Context, email string) (Identity, error)
	LinkGoogleSubject(ctx context.Context, id uuid.UUID, subject string) error
}

type RefreshTokens interface {
	Create(ctx context.Context, token RefreshToken) error
	ByHash(ctx context.Context, hash string) (RefreshToken, error)
	// Rotate revokes spent and issues next atomically. Doing it in two calls
	// leaves a window where a crash between them means neither token works
	// and the player is signed out for no reason.
	Rotate(ctx context.Context, spent uuid.UUID, next RefreshToken) error
	Revoke(ctx context.Context, id uuid.UUID) error
	RevokeAllFor(ctx context.Context, identityId uuid.UUID) error
	DeleteExpired(ctx context.Context, before time.Time) (int64, error)
}
