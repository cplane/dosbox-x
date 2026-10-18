// Package auth is the half of authentication that every service needs: the
// shape of a signed-in player, and how to prove a token belongs to one.
//
// It deliberately holds no storage, no password handling and no sign-in
// flows — those belong to services/auth alone. A service that only needs to
// know "who is this request from" imports this package and nothing else, and
// answers the question locally from a public key rather than calling the auth
// service on every request.
package auth

import (
	"errors"

	"github.com/google/uuid"
)

// Role is what an identity is allowed to do. Two levels is all a game needs:
// the donor design this is modelled on carried four plus last-root
// protection, which is machinery for a product with moderation staff.
type Role string

const (
	RolePlayer Role = "player"
	RoleAdmin  Role = "admin"
)

func (r Role) Valid() bool {
	return r == RolePlayer || r == RoleAdmin
}

// Identity is a signed-in player, as recovered from a token. Id is the value
// a match seat is attached to, so it has to stay stable for the life of the
// account — it is never derived from anything mutable like an email address.
type Identity struct {
	Id       uuid.UUID
	Username string
	Role     Role
}

func (i Identity) IsAdmin() bool { return i.Role == RoleAdmin }

var (
	// ErrNoToken means the request carried no credentials at all, which is
	// different from carrying bad ones: it is the ordinary state of a visitor
	// who has not signed in, and handlers may treat it as such.
	ErrNoToken = errors.New("auth: no token presented")
	// ErrInvalidToken covers everything else — malformed, expired, wrong
	// issuer, bad signature. The distinction is deliberately not exposed to
	// the caller, who would only be tempted to report it.
	ErrInvalidToken = errors.New("auth: invalid token")
)
