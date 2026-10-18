package service

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"

	"dosbox/core/auth"
	"dosbox/services/auth/repository"
)

const googleIssuer = "https://accounts.google.com"

// GoogleClaims is the part of a verified Google ID token we act on.
//
// Subject, never Email, is the identity. An email address can be reassigned
// by whoever owns the domain, and Google itself documents "sub" as the only
// claim guaranteed stable for an account — so it is what the account row is
// keyed on and what survives a player changing their address.
type GoogleClaims struct {
	Subject       string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
}

// GoogleVerifier validates the credential the browser's Google button hands
// us. Nil when no client id is configured, which closes the door rather than
// leaving it ajar.
type GoogleVerifier struct {
	verifier *oidc.IDTokenVerifier
}

func NewGoogleVerifier(ctx context.Context, clientID string) (*GoogleVerifier, error) {
	if clientID == "" {
		return nil, nil
	}
	provider, err := oidc.NewProvider(ctx, googleIssuer)
	if err != nil {
		return nil, fmt.Errorf("discovering google oidc: %w", err)
	}
	// ClientID here is the audience check: a token minted for some other
	// application must not sign anyone in here.
	return &GoogleVerifier{verifier: provider.Verifier(&oidc.Config{ClientID: clientID})}, nil
}

func (g *GoogleVerifier) Verify(ctx context.Context, credential string) (GoogleClaims, error) {
	token, err := g.verifier.Verify(ctx, credential)
	if err != nil {
		return GoogleClaims{}, fmt.Errorf("verifying google id token: %w", err)
	}

	var claims GoogleClaims
	if err := token.Claims(&claims); err != nil {
		return GoogleClaims{}, fmt.Errorf("reading google claims: %w", err)
	}
	if claims.Subject == "" {
		return GoogleClaims{}, errors.New("google id token has no subject")
	}
	return claims, nil
}

// SignInWithGoogle signs in an existing account or creates one.
//
// Three cases, in order. A known subject is simply that player. An unknown
// subject whose VERIFIED email matches an existing account links the two, so
// somebody who signed up with a password keeps their id — and therefore their
// match history — when they later use the Google button. Anything else is a
// new account.
//
// The email match is gated on email_verified for a reason: without it,
// anyone able to mint a token claiming an unverified address of their
// choosing could attach themselves to someone else's account.
func (s *Service) SignInWithGoogle(ctx context.Context, claims GoogleClaims) (TokenPair, auth.Identity, error) {
	identity, err := s.identities.ByGoogleSubject(ctx, claims.Subject)
	if err == nil {
		pair, err := s.issue(ctx, identity)
		return pair, identity.Public(), err
	}
	if !errors.Is(err, repository.ErrNotFound) {
		return TokenPair{}, auth.Identity{}, err
	}

	if claims.EmailVerified && claims.Email != "" {
		existing, err := s.identities.ByEmail(ctx, claims.Email)
		switch {
		case err == nil:
			if err := s.identities.LinkGoogleSubject(ctx, existing.Id, claims.Subject); err != nil {
				return TokenPair{}, auth.Identity{}, err
			}
			pair, err := s.issue(ctx, existing)
			return pair, existing.Public(), err
		case !errors.Is(err, repository.ErrNotFound):
			return TokenPair{}, auth.Identity{}, err
		}
	}

	created := repository.Identity{
		Id:            uuid.New(),
		Username:      s.availableUsername(ctx, claims),
		Email:         claims.Email,
		GoogleSubject: claims.Subject,
		Role:          auth.RolePlayer,
		// No PasswordHash: the password door stays shut for this account
		// rather than open with an empty secret.
	}
	if err := s.identities.Create(ctx, created); err != nil {
		return TokenPair{}, auth.Identity{}, err
	}

	pair, err := s.issue(ctx, created)
	return pair, created.Public(), err
}

// availableUsername derives a display name that nobody else holds.
//
// Federated sign-in has to produce a username without asking, and it has to
// succeed: failing here would mean a player who pressed the Google button
// gets an error they cannot act on.
func (s *Service) availableUsername(ctx context.Context, claims GoogleClaims) string {
	candidate := sanitizeUsername(claims.Name)
	if candidate == "" {
		candidate = sanitizeUsername(strings.SplitN(claims.Email, "@", 2)[0])
	}
	if candidate == "" {
		candidate = "player"
	}

	if _, err := s.identities.ByUsername(ctx, candidate); errors.Is(err, repository.ErrNotFound) {
		return candidate
	}

	// Fall back to a suffix from the provider subject, which is unique per
	// account, rather than a counter that would race with a concurrent signup.
	suffix := claims.Subject
	if len(suffix) > 6 {
		suffix = suffix[len(suffix)-6:]
	}
	combined := candidate + "-" + suffix
	if len([]rune(combined)) > 24 {
		combined = string([]rune(combined)[:24])
	}
	return combined
}

func sanitizeUsername(raw string) string {
	var out []rune
	for _, r := range raw {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			out = append(out, r)
		case r == ' ' || r == '.':
			out = append(out, '-')
		}
		if len(out) >= 24 {
			break
		}
	}
	name := strings.Trim(string(out), "-_")
	if len([]rune(name)) < 3 {
		return ""
	}
	return name
}
