package auth

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"
)

type contextKey struct{}

// FromContext returns the identity Middleware put there, if any. The second
// result is false for an anonymous request, which is an ordinary state and
// not an error.
func FromContext(ctx context.Context) (Identity, bool) {
	identity, ok := ctx.Value(contextKey{}).(Identity)
	return identity, ok
}

// WithIdentity is exported for tests and for the websocket path, which
// authenticates before the HTTP handler chain gets involved.
func WithIdentity(ctx context.Context, identity Identity) context.Context {
	return context.WithValue(ctx, contextKey{}, identity)
}

// AccessCookie is the name of the httpOnly cookie carrying the access token.
//
// The cookie is set with no Domain attribute, which makes it host-only: it
// goes to dosbox.pocket-maze.app and nowhere else. Widening it to the
// parent domain would hand the session to every sibling subdomain, present
// and future, which is why the auth service lives on this host rather than
// being borrowed from another one.
const (
	AccessCookie  = "dbx_access"
	RefreshCookie = "dbx_refresh"
)

// TokenFromRequest finds the access token wherever this client could put it.
//
// The query parameter is not redundant: a browser cannot set headers on a
// WebSocket handshake. The cookie covers it for same-origin sockets, and the
// header covers non-browser clients, but the query string is the fallback
// that makes a socket work from anywhere.
func TokenFromRequest(r *http.Request) string {
	const bearer = "Bearer "
	if header := r.Header.Get("Authorization"); len(header) > len(bearer) && header[:len(bearer)] == bearer {
		return header[len(bearer):]
	}
	if cookie, err := r.Cookie(AccessCookie); err == nil && cookie.Value != "" {
		return cookie.Value
	}
	return r.URL.Query().Get("token")
}

// Middleware attaches an identity to requests that carry a valid token.
//
// It does NOT reject anonymous requests. Some routes are public (the map
// list, a match a spectator is watching) and some are not, so the decision of
// what requires a seat belongs to the handler. Use Require to gate a route.
func Middleware(v Verifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			identity, err := v.Verify(TokenFromRequest(r))
			if err == nil {
				r = r.WithContext(WithIdentity(r.Context(), identity))
			}
			next.ServeHTTP(w, r)
		})
	}
}

// Require rejects a request that Middleware did not authenticate.
//
// 401, never 400 or 500, whatever went wrong with the token: a client can
// only act on "sign in again", and distinguishing expired from malformed for
// the caller tells an attacker more than it tells the user.
func Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := FromContext(r.Context()); !ok {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":"sign in required"}`)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RemoteConfig points a service at the auth service's public key.
type RemoteConfig struct {
	// Base URL of the auth service, cluster-internal.
	ServerURL string
	Issuer    string
}

// NewRemoteVerifier fetches the signing public key once, at startup, and then
// verifies every token locally.
//
// Fetching once is the point: an auth service that had to be consulted per
// request would be in the path of every frame-bearing websocket handshake and
// every order. The cost is that a rotated key needs a restart to be picked
// up, which is acceptable for a key that must not rotate anyway (see
// LoadOrGenerateRSAKeyPair).
func NewRemoteVerifier(cfg RemoteConfig) (Verifier, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	url := cfg.ServerURL + "/publickey"

	var lastErr error
	// The auth service and its dependants start together, so a few seconds of
	// "connection refused" at boot is expected rather than fatal.
	for attempt := 0; attempt < 10; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * time.Second)
		}

		resp, err := client.Get(url)
		if err != nil {
			lastErr = err
			continue
		}
		body, err := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("%s returned %s", url, resp.Status)
			continue
		}

		key, err := ParsePublicKeyPEM(body)
		if err != nil {
			return nil, fmt.Errorf("public key from %s: %w", url, err)
		}
		return NewVerifier(key, cfg.Issuer), nil
	}
	return nil, fmt.Errorf("fetching signing key from %s: %w", url, lastErr)
}
