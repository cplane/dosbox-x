// Package service holds the sign-in rules: what a valid account looks like,
// how a password is checked, and how a session is renewed.
package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"

	"dosbox/core/auth"
	"dosbox/services/auth/repository"
)

var (
	// ErrInvalidCredentials is returned for a wrong password AND for a
	// username that does not exist. One message for both, so sign-in cannot
	// be used to discover who has an account.
	ErrInvalidCredentials = errors.New("auth: incorrect username or password")
	ErrTaken              = errors.New("auth: that name is already taken")
	ErrInvalidSession     = errors.New("auth: session is no longer valid")
	ErrWeakPassword       = errors.New("auth: password must be at least 8 characters")
	ErrInvalidUsername    = errors.New("auth: username must be 3-24 characters, letters, digits, - or _")
)

// Usernames are shown to other players on a shared link, so they are kept
// narrow: no spaces to fake a second name, no punctuation to impersonate.
var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{3,24}$`)

const minPasswordLength = 8

// Config is the tuning that deployment owns.
type Config struct {
	AccessTTL  time.Duration
	RefreshTTL time.Duration
	// RotationGrace forgives a refresh token that was spent by rotation
	// moments ago. See Refresh for why this is not optional.
	RotationGrace time.Duration
}

// TokenPair is what a successful sign-in produces.
type TokenPair struct {
	Access           string    `json:"accessToken"`
	AccessExpiresAt  time.Time `json:"accessExpiresAt"`
	Refresh          string    `json:"refreshToken"`
	RefreshExpiresAt time.Time `json:"refreshExpiresAt"`
}

type Service struct {
	identities repository.Identities
	tokens     repository.RefreshTokens
	signer     *auth.Signer
	cfg        Config
}

func New(identities repository.Identities, tokens repository.RefreshTokens, signer *auth.Signer, cfg Config) *Service {
	return &Service{identities: identities, tokens: tokens, signer: signer, cfg: cfg}
}

func (s *Service) SignUp(ctx context.Context, username, email, password string) (TokenPair, auth.Identity, error) {
	username = strings.TrimSpace(username)
	if !usernamePattern.MatchString(username) {
		return TokenPair{}, auth.Identity{}, ErrInvalidUsername
	}
	if len([]rune(password)) < minPasswordLength {
		return TokenPair{}, auth.Identity{}, ErrWeakPassword
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return TokenPair{}, auth.Identity{}, fmt.Errorf("hashing password: %w", err)
	}

	identity := repository.Identity{
		Id:           uuid.New(),
		Username:     username,
		Email:        strings.TrimSpace(email),
		PasswordHash: string(hash),
		Role:         auth.RolePlayer,
	}
	if err := s.identities.Create(ctx, identity); err != nil {
		if errors.Is(err, repository.ErrTaken) {
			return TokenPair{}, auth.Identity{}, ErrTaken
		}
		return TokenPair{}, auth.Identity{}, err
	}

	pair, err := s.issue(ctx, identity)
	return pair, identity.Public(), err
}

func (s *Service) SignIn(ctx context.Context, username, password string) (TokenPair, auth.Identity, error) {
	identity, err := s.identities.ByUsername(ctx, strings.TrimSpace(username))
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			// Hash anyway so a missing account and a wrong password take
			// roughly the same time; otherwise the response time says which
			// usernames exist.
			_, _ = bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
			return TokenPair{}, auth.Identity{}, ErrInvalidCredentials
		}
		return TokenPair{}, auth.Identity{}, err
	}

	// A federated account has no password hash. Without this check bcrypt
	// would be asked to compare against "", which fails — but relying on that
	// leaves the door's state implicit.
	if !identity.HasPassword() {
		return TokenPair{}, auth.Identity{}, ErrInvalidCredentials
	}
	if bcrypt.CompareHashAndPassword([]byte(identity.PasswordHash), []byte(password)) != nil {
		return TokenPair{}, auth.Identity{}, ErrInvalidCredentials
	}

	pair, err := s.issue(ctx, identity)
	return pair, identity.Public(), err
}

// Refresh exchanges a refresh token for a new pair, spending the old one.
//
// Single-use rotation means a stolen token is good for exactly one call. The
// cost is that two requests presenting the SAME token at the same instant
// produce one winner and one player thrown to the login screen — and a
// browser generates precisely that traffic, because two tabs share one cookie
// jar and both notice the expired access token together.
//
// RotationGrace is what covers it: a token spent BY ROTATION moments ago is
// still honoured, and issues a second live chain for the same account, which
// is correct because it is the same person in another tab. A token revoked by
// signing out has no successor and is refused instantly, however recent.
//
// Deliberately NOT done here: treating a late reuse as theft and revoking
// every session for the account. That is the textbook response, but its false
// positive is a stale background tab signing the player out everywhere, and
// this product has no way to tell the two apart.
func (s *Service) Refresh(ctx context.Context, presented string) (TokenPair, auth.Identity, error) {
	stored, err := s.tokens.ByHash(ctx, hashToken(presented))
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return TokenPair{}, auth.Identity{}, ErrInvalidSession
		}
		return TokenPair{}, auth.Identity{}, err
	}

	now := time.Now()
	if now.After(stored.ExpiresAt) {
		return TokenPair{}, auth.Identity{}, ErrInvalidSession
	}
	if stored.Revoked() && !s.withinRotationGrace(stored, now) {
		return TokenPair{}, auth.Identity{}, ErrInvalidSession
	}

	identity, err := s.identities.ById(ctx, stored.IdentityId)
	if err != nil {
		return TokenPair{}, auth.Identity{}, ErrInvalidSession
	}

	next, plaintext, err := s.newRefreshToken(identity.Id, now)
	if err != nil {
		return TokenPair{}, auth.Identity{}, err
	}

	if stored.Revoked() {
		// Already spent, inside the grace window: there is nothing left to
		// revoke, so just start this tab's own chain.
		if err := s.tokens.Create(ctx, next); err != nil {
			return TokenPair{}, auth.Identity{}, err
		}
	} else if err := s.tokens.Rotate(ctx, stored.Id, next); err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			// Lost a race against a concurrent refresh between our read and
			// our write. The other request has already issued a pair.
			return TokenPair{}, auth.Identity{}, ErrInvalidSession
		}
		return TokenPair{}, auth.Identity{}, err
	}

	access, err := s.signer.Sign(identity.Public(), s.cfg.AccessTTL)
	if err != nil {
		return TokenPair{}, auth.Identity{}, err
	}
	return TokenPair{
		Access:           access,
		AccessExpiresAt:  now.Add(s.cfg.AccessTTL),
		Refresh:          plaintext,
		RefreshExpiresAt: next.ExpiresAt,
	}, identity.Public(), nil
}

// SignOut revokes the presented session only. Signing out of a browser must
// not sign the player out of their other devices.
func (s *Service) SignOut(ctx context.Context, presented string) error {
	stored, err := s.tokens.ByHash(ctx, hashToken(presented))
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			// Already gone; signing out twice is not an error worth reporting.
			return nil
		}
		return err
	}
	return s.tokens.Revoke(ctx, stored.Id)
}

func (s *Service) withinRotationGrace(token repository.RefreshToken, now time.Time) bool {
	if !token.SpentByRotation() || token.RevokedAt == nil {
		return false
	}
	return now.Sub(*token.RevokedAt) <= s.cfg.RotationGrace
}

func (s *Service) issue(ctx context.Context, identity repository.Identity) (TokenPair, error) {
	now := time.Now()

	next, plaintext, err := s.newRefreshToken(identity.Id, now)
	if err != nil {
		return TokenPair{}, err
	}
	if err := s.tokens.Create(ctx, next); err != nil {
		return TokenPair{}, err
	}

	access, err := s.signer.Sign(identity.Public(), s.cfg.AccessTTL)
	if err != nil {
		return TokenPair{}, err
	}
	return TokenPair{
		Access:           access,
		AccessExpiresAt:  now.Add(s.cfg.AccessTTL),
		Refresh:          plaintext,
		RefreshExpiresAt: next.ExpiresAt,
	}, nil
}

func (s *Service) newRefreshToken(identityId uuid.UUID, now time.Time) (repository.RefreshToken, string, error) {
	// Opaque and random, not a JWT: a refresh token's whole job is to be
	// revocable, and a self-describing token cannot be taken back.
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return repository.RefreshToken{}, "", fmt.Errorf("generating refresh token: %w", err)
	}
	plaintext := base64.RawURLEncoding.EncodeToString(raw)

	return repository.RefreshToken{
		Id:         uuid.New(),
		IdentityId: identityId,
		TokenHash:  hashToken(plaintext),
		IssuedAt:   now,
		ExpiresAt:  now.Add(s.cfg.RefreshTTL),
	}, plaintext, nil
}

// hashToken is SHA-256, not bcrypt: the input is 256 bits of entropy we
// generated, so there is no dictionary to slow down, and refresh happens on a
// hot path where bcrypt's cost would be felt.
func hashToken(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}
