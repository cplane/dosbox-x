package httphandler

import (
	"net/http"
	"time"

	"dosbox/core/auth"
)

// Sessions live in cookies, and the tokens are never returned in the body.
//
// The donor design this follows returns the pair in the JSON body as well,
// because it also serves a Unity client that cannot use cookies. We have only
// a browser, so withholding them is free: script cannot read an httpOnly
// cookie, which means an XSS bug cannot walk away with a 90-day refresh token
// and use it offline. The response body carries who you are and when the
// access token expires — enough for the client to schedule a refresh.
func setSession(w http.ResponseWriter, access, refresh string, accessTTL, refreshTTL time.Duration, secure bool) {
	http.SetCookie(w, sessionCookie(auth.AccessCookie, access, int(accessTTL.Seconds()), secure))
	http.SetCookie(w, sessionCookie(auth.RefreshCookie, refresh, int(refreshTTL.Seconds()), secure))
}

func clearSession(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, sessionCookie(auth.AccessCookie, "", -1, secure))
	http.SetCookie(w, sessionCookie(auth.RefreshCookie, "", -1, secure))
}

// secure decides the cookies' Secure flag: set by configuration, or else
// by what the request says about itself.
//
// The request alone is not enough in production. TLS ends at the
// DigitalOcean load balancer, the ingress controller then rewrites
// X-Forwarded-Proto to the plain-HTTP scheme IT saw, and by the time the
// header reaches this service it says http for every player. Rather than
// teach the ingress to trust the balancer's headers — a cluster-wide
// setting shared with other services — the deployment states the fact it
// knows: this site is only ever served over TLS.
func (h *Handler) secure(r *http.Request) bool {
	return h.cfg.CookieSecure || isSecure(r)
}

func sessionCookie(name, value string, maxAge int, secure bool) *http.Cookie {
	return &http.Cookie{
		Name:  name,
		Value: value,
		Path:  "/",
		// No Domain. That makes the cookie host-only — it goes to
		// dosbox.pocket-maze.app and nowhere else. Setting the parent
		// domain to share a session with a sibling product would hand it to
		// every subdomain that will ever exist under it.
		HttpOnly: true,
		Secure:   secure,
		// Lax, not Strict: the cookie has to survive a top-level navigation
		// into the app, which is exactly how a shared match link is opened.
		// Strict would drop it and show the recipient a signed-out page. Lax
		// still withholds the cookie from cross-site POSTs, which is the CSRF
		// vector that matters for a cookie-authenticated API.
		SameSite: http.SameSiteLaxMode,
		MaxAge:   maxAge,
	}
}

// isSecure reports whether the player's request arrived over HTTPS.
//
// Checking r.TLS is not enough: TLS terminates at the load balancer and the
// pod is reached over plain HTTP, so r.TLS is always nil in production.
// X-Forwarded-Proto is what the ingress passes through. Getting this wrong
// drops the Secure flag on real sessions.
func isSecure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return r.Header.Get("X-Forwarded-Proto") == "https"
}
