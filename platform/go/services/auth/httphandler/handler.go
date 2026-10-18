// Package httphandler is the auth service's HTTP surface.
package httphandler

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/gorilla/mux"
	"github.com/sirupsen/logrus"

	"dosbox/core/auth"
	"dosbox/services/auth/service"
)

type Config struct {
	AccessTTL  time.Duration
	RefreshTTL time.Duration
	// GoogleClientID is published to the login page so it can initialise
	// Google's script. A client id is public by design — it appears in the
	// page of every site offering Google sign-in — and the secret half never
	// leaves this service. Empty means the door does not exist.
	GoogleClientID string
	// CookieSecure marks the session cookies Secure regardless of what the
	// request says about its scheme. See Handler.secure.
	CookieSecure bool
}

type Handler struct {
	svc    *service.Service
	google *service.GoogleVerifier
	signer *auth.Signer
	// Used only by /session, to read back the access cookie the browser
	// cannot read for itself. Built from our own public key rather than
	// fetched, since we are the issuer.
	verifier auth.Verifier
	cfg      Config
}

func New(router *mux.Router, svc *service.Service, google *service.GoogleVerifier, signer *auth.Signer, verifier auth.Verifier, cfg Config) *Handler {
	h := &Handler{svc: svc, google: google, signer: signer, verifier: verifier, cfg: cfg}

	// Everything under /auth so one nginx location covers the service and the
	// cookie stays same-origin with the game.
	r := router.PathPrefix("/auth").Subrouter()
	r.HandleFunc("/signup", h.signUp).Methods(http.MethodPost)
	r.HandleFunc("/signin", h.signIn).Methods(http.MethodPost)
	r.HandleFunc("/google", h.signInWithGoogle).Methods(http.MethodPost)
	r.HandleFunc("/refresh", h.refresh).Methods(http.MethodPost)
	r.HandleFunc("/signout", h.signOut).Methods(http.MethodPost)
	r.HandleFunc("/session", h.session).Methods(http.MethodGet)
	r.HandleFunc("/config", h.config).Methods(http.MethodGet)
	r.HandleFunc("/publickey", h.publicKey).Methods(http.MethodGet)
	r.HandleFunc("/health", h.health).Methods(http.MethodGet)

	return h
}

type credentials struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

// sessionResponse is what a successful sign-in returns. Note what is absent:
// the tokens themselves. They are in httpOnly cookies, out of script's reach.
type sessionResponse struct {
	Authenticated bool   `json:"authenticated"`
	Id            string `json:"id,omitempty"`
	Username      string `json:"username,omitempty"`
	Role          string `json:"role,omitempty"`
	// A pointer because omitempty does not suppress a zero time.Time, and
	// /session has no expiry to report — it answers "who am I", not "here is
	// a new session".
	AccessExpiresAt *time.Time `json:"accessExpiresAt,omitempty"`
}

func (h *Handler) signUp(w http.ResponseWriter, r *http.Request) {
	var body credentials
	if !decode(w, r, &body) {
		return
	}

	pair, identity, err := h.svc.SignUp(r.Context(), body.Username, body.Email, body.Password)
	if err != nil {
		h.fail(w, err)
		return
	}
	h.grant(w, r, pair, identity)
}

func (h *Handler) signIn(w http.ResponseWriter, r *http.Request) {
	var body credentials
	if !decode(w, r, &body) {
		return
	}

	pair, identity, err := h.svc.SignIn(r.Context(), body.Username, body.Password)
	if err != nil {
		h.fail(w, err)
		return
	}
	h.grant(w, r, pair, identity)
}

func (h *Handler) signInWithGoogle(w http.ResponseWriter, r *http.Request) {
	if h.google == nil {
		writeError(w, http.StatusNotFound, "google sign-in is not configured")
		return
	}

	var body struct {
		Credential string `json:"credential"`
	}
	if !decode(w, r, &body) {
		return
	}

	claims, err := h.google.Verify(r.Context(), body.Credential)
	if err != nil {
		logrus.WithError(err).Debug("rejected google credential")
		writeError(w, http.StatusUnauthorized, "google sign-in failed")
		return
	}

	pair, identity, err := h.svc.SignInWithGoogle(r.Context(), claims)
	if err != nil {
		h.fail(w, err)
		return
	}
	h.grant(w, r, pair, identity)
}

func (h *Handler) refresh(w http.ResponseWriter, r *http.Request) {
	presented := refreshTokenFrom(r)
	if presented == "" {
		// No cookie at all is not a failure worth logging; it is a visitor
		// who has never signed in.
		clearSession(w, h.secure(r))
		writeError(w, http.StatusUnauthorized, "no session")
		return
	}

	pair, identity, err := h.svc.Refresh(r.Context(), presented)
	if err != nil {
		// Clear the cookies on the way out. Leaving a dead refresh token in
		// the jar means the client retries it forever and never recovers.
		clearSession(w, h.secure(r))
		h.fail(w, err)
		return
	}
	h.grant(w, r, pair, identity)
}

func (h *Handler) signOut(w http.ResponseWriter, r *http.Request) {
	if presented := refreshTokenFrom(r); presented != "" {
		if err := h.svc.SignOut(r.Context(), presented); err != nil {
			logrus.WithError(err).Warn("signing out")
		}
	}
	clearSession(w, h.secure(r))
	writeJSON(w, http.StatusOK, sessionResponse{Authenticated: false})
}

// session answers "am I signed in?" for a browser, which cannot read the
// httpOnly cookie holding the answer.
func (h *Handler) session(w http.ResponseWriter, r *http.Request) {
	verified, err := h.verifier.Verify(auth.TokenFromRequest(r))
	if err != nil {
		// Not signed in is an answer, not an error: this endpoint exists so
		// the page can ask, and 200 with authenticated=false is the answer.
		writeJSON(w, http.StatusOK, sessionResponse{Authenticated: false})
		return
	}
	writeJSON(w, http.StatusOK, sessionResponse{
		Authenticated: true,
		Id:            verified.Id.String(),
		Username:      verified.Username,
		Role:          string(verified.Role),
	})
}

// config tells the login page which doors exist, so it does not render a
// Google button a deployment cannot honour.
func (h *Handler) config(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"google":         h.cfg.GoogleClientID != "",
		"googleClientId": h.cfg.GoogleClientID,
	})
}

// publicKey is how other services verify tokens without asking us per
// request. Cluster-internal in practice, but harmless to expose: it is the
// public half.
func (h *Handler) publicKey(w http.ResponseWriter, r *http.Request) {
	pem, err := h.signer.PublicKeyPEM()
	if err != nil {
		logrus.WithError(err).Error("serving public key")
		writeError(w, http.StatusInternalServerError, "unavailable")
		return
	}
	w.Header().Set("Content-Type", "application/x-pem-file")
	_, _ = w.Write(pem)
}

func (h *Handler) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) grant(w http.ResponseWriter, r *http.Request, pair service.TokenPair, identity auth.Identity) {
	setSession(w, pair.Access, pair.Refresh, h.cfg.AccessTTL, h.cfg.RefreshTTL, h.secure(r))
	writeJSON(w, http.StatusOK, sessionResponse{
		Authenticated:   true,
		Id:              identity.Id.String(),
		Username:        identity.Username,
		Role:            string(identity.Role),
		AccessExpiresAt: &pair.AccessExpiresAt,
	})
}

// fail maps a domain error to a status, and says nothing more than it must.
//
// Every credential failure is 401 with one message: a client can only act on
// "sign in again", and distinguishing expired from wrong-password from
// no-such-user for the caller tells an attacker more than it tells the user.
func (h *Handler) fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrInvalidCredentials), errors.Is(err, service.ErrInvalidSession):
		writeError(w, http.StatusUnauthorized, err.Error())
	case errors.Is(err, service.ErrTaken):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, service.ErrWeakPassword), errors.Is(err, service.ErrInvalidUsername):
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		logrus.WithError(err).Error("auth request failed")
		writeError(w, http.StatusInternalServerError, "something went wrong")
	}
}

func refreshTokenFrom(r *http.Request) string {
	if cookie, err := r.Cookie(auth.RefreshCookie); err == nil {
		return cookie.Value
	}
	// Body fallback for a client that is not a browser.
	var body struct {
		RefreshToken string `json:"refreshToken"`
	}
	if json.NewDecoder(r.Body).Decode(&body) == nil {
		return body.RefreshToken
	}
	return ""
}

func decode(w http.ResponseWriter, r *http.Request, into any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(into); err != nil {
		writeError(w, http.StatusBadRequest, "malformed request")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		logrus.WithError(err).Debug("writing response")
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
