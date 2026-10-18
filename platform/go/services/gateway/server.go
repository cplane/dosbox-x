// Package gateway is the dos-box platform's API: it keeps users' boxes
// (Postgres + a folder each on the shared volume), starts and stops a pod
// per running box through the Kubernetes API, proxies the player's
// WebSocket and the box control API to the owner's pod, serves the box's
// C: drive from the volume with a soft disk limit, and stops idle boxes.
package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/sirupsen/logrus"

	"dosbox/core/auth"
)

type Server struct {
	cfg      *Config
	store    Store
	kube     Kube
	verifier auth.Verifier
	now      func() time.Time

	mu      sync.Mutex
	viewers map[uuid.UUID]int       // open player WebSockets per box
	active  map[uuid.UUID]time.Time // last activity not yet written to the store
	startMu sync.Mutex              // start limit checks + pod creation
	boxMu   sync.Map                // per-box *sync.Mutex for file writes
	stopped map[uuid.UUID]string    // why the janitor stopped a box (shown once)

	catalog *Catalog
}

func NewServer(cfg *Config, store Store, kube Kube, verifier auth.Verifier) *Server {
	return &Server{
		cfg: cfg, store: store, kube: kube, verifier: verifier, now: time.Now,
		viewers: map[uuid.UUID]int{}, active: map[uuid.UUID]time.Time{}, stopped: map[uuid.UUID]string{},
		catalog: NewCatalog(cfg.BoxesDir, nil, store, cfg.CatalogMaxItemMB),
	}
}

// Catalog is the server's catalog (cmd uses it for Spaces, sync and seeding).
func (s *Server) Catalog() *Catalog { return s.catalog }

// UseBlob gives the catalog its master copy store (nil: volume only).
func (c *Catalog) UseBlob(b Blob) { c.blob = b }

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok\n")) })
	mux.HandleFunc("GET /api/config", s.handleConfig)
	mux.HandleFunc("GET /api/boxes", s.signedIn(s.handleList))
	mux.HandleFunc("POST /api/boxes", s.signedIn(s.handleCreate))
	mux.HandleFunc("GET /api/boxes/{id}", s.owned(s.handleGet))
	mux.HandleFunc("DELETE /api/boxes/{id}", s.owned(s.handleDelete))
	mux.HandleFunc("POST /api/boxes/{id}/start", s.owned(s.handleStart))
	mux.HandleFunc("POST /api/boxes/{id}/stop", s.owned(s.handleStop))
	mux.HandleFunc("GET /api/boxes/{id}/ws", s.owned(s.handleWS))
	mux.HandleFunc("/api/boxes/{id}/ctl/{op...}", s.owned(s.handleCtl))
	mux.HandleFunc("GET /api/boxes/{id}/files", s.owned(s.handleFileGet))
	mux.HandleFunc("GET /api/boxes/{id}/files/{path...}", s.owned(s.handleFileGet))
	mux.HandleFunc("PUT /api/boxes/{id}/files/{path...}", s.owned(s.handleFilePut))
	mux.HandleFunc("DELETE /api/boxes/{id}/files/{path...}", s.owned(s.handleFileDelete))
	mux.HandleFunc("POST /api/boxes/{id}/attach", s.owned(s.handleAttach))
	mux.HandleFunc("GET /api/catalog", s.signedIn(s.handleCatalogList))
	mux.HandleFunc("POST /api/catalog/import", s.admin(s.handleCatalogImport))
	mux.HandleFunc("PUT /api/catalog/{slug}", s.admin(s.handleCatalogUpload))
	mux.HandleFunc("PATCH /api/catalog/{slug}", s.admin(s.handleCatalogEdit))
	mux.HandleFunc("DELETE /api/catalog/{slug}", s.admin(s.handleCatalogDelete))
	return auth.Middleware(s.verifier)(mux)
}

// ---- helpers

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func httpErr(w http.ResponseWriter, code int, msg string, args ...any) {
	writeJSON(w, code, map[string]string{"error": fmt.Sprintf(msg, args...)})
}

type boxHandler func(w http.ResponseWriter, r *http.Request, id auth.Identity, b *Box)

func (s *Server) signedIn(next func(http.ResponseWriter, *http.Request, auth.Identity)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ident, ok := auth.FromContext(r.Context())
		if !ok {
			httpErr(w, http.StatusUnauthorized, "sign in required")
			return
		}
		next(w, r, ident)
	}
}

// owned resolves {id} to a box the caller owns (admins: any box). Other
// people's boxes are reported as missing, not forbidden.
func (s *Server) owned(next boxHandler) http.HandlerFunc {
	return s.signedIn(func(w http.ResponseWriter, r *http.Request, ident auth.Identity) {
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpErr(w, http.StatusNotFound, "no such box")
			return
		}
		b, err := s.store.GetBox(r.Context(), id)
		if errors.Is(err, ErrNotFound) || err == nil && b.Owner != ident.Id && !ident.IsAdmin() {
			httpErr(w, http.StatusNotFound, "no such box")
			return
		} else if err != nil {
			httpErr(w, http.StatusInternalServerError, "%v", err)
			return
		}
		next(w, r, ident, b)
	})
}

func (s *Server) touch(id uuid.UUID) {
	s.mu.Lock()
	s.active[id] = s.now()
	s.mu.Unlock()
}

func (s *Server) lastActive(b *Box) time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := s.active[b.ID]; t.After(b.LastActiveAt) {
		return t
	}
	return b.LastActiveAt
}

func (s *Server) boxDir(id uuid.UUID) string { return filepath.Join(s.cfg.BoxesDir, id.String()) }
func (s *Server) cDir(id uuid.UUID) string   { return filepath.Join(s.boxDir(id), "c") }

func (s *Server) pod(ctx context.Context, id uuid.UUID) (*Pod, error) {
	p, err := s.kube.GetPod(ctx, podName(id))
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	return p, err
}

// ---- boxes

type boxView struct {
	Box
	State   BoxState `json:"state"`
	Reason  string   `json:"reason,omitempty"`
	Viewers int      `json:"viewers"`
}

func (s *Server) view(b Box, p *Pod) boxView {
	st, reason := podState(p)
	s.mu.Lock()
	v := boxView{Box: b, State: st, Reason: reason, Viewers: s.viewers[b.ID]}
	if st == StateStopped && s.stopped[b.ID] != "" {
		v.Reason = s.stopped[b.ID]
	}
	if t := s.active[b.ID]; t.After(v.LastActiveAt) {
		v.LastActiveAt = t
	}
	s.mu.Unlock()
	return v
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"maxBoxesPerUser": s.cfg.MaxBoxesPerUser, "maxRunningPerUser": s.cfg.MaxRunningPerUser,
		"diskLimitMB": s.cfg.DiskLimitMB, "idleMinutes": s.cfg.IdleMinutes,
	})
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request, ident auth.Identity) {
	boxes, err := s.store.ListBoxes(r.Context(), ident.Id)
	if err != nil {
		httpErr(w, http.StatusInternalServerError, "%v", err)
		return
	}
	pods, err := s.kube.ListPods(r.Context(), ownerLabel+"="+ident.Id.String())
	if err != nil {
		httpErr(w, http.StatusBadGateway, "%v", err)
		return
	}
	byBox := map[string]*Pod{}
	for i := range pods {
		byBox[pods[i].Metadata.Labels[boxLabel]] = &pods[i]
	}
	out := []boxView{}
	for _, b := range boxes {
		out = append(out, s.view(b, byBox[b.ID.String()]))
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleGet(w http.ResponseWriter, r *http.Request, _ auth.Identity, b *Box) {
	p, err := s.pod(r.Context(), b.ID)
	if err != nil {
		httpErr(w, http.StatusBadGateway, "%v", err)
		return
	}
	writeJSON(w, http.StatusOK, s.view(*b, p))
}

func validName(n string) bool {
	if n = strings.TrimSpace(n); n == "" || utf8.RuneCountInString(n) > 40 {
		return false
	}
	for _, c := range n {
		if c < ' ' || c == 0x7f {
			return false
		}
	}
	return true
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request, ident auth.Identity) {
	var req struct {
		Name  string
		Items []string // catalog items to copy onto the new C:
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil || !validName(req.Name) {
		httpErr(w, http.StatusBadRequest, "name: 1-40 printable characters")
		return
	}
	items, err := s.readyItems(r.Context(), req.Items)
	if err != nil {
		httpErr(w, http.StatusBadRequest, "%v", err)
		return
	}
	s.startMu.Lock()
	defer s.startMu.Unlock()
	boxes, err := s.store.ListBoxes(r.Context(), ident.Id)
	if err != nil {
		httpErr(w, http.StatusInternalServerError, "%v", err)
		return
	}
	if len(boxes) >= s.cfg.MaxBoxesPerUser && !ident.IsAdmin() {
		httpErr(w, http.StatusConflict, "you already have %d boxes (the maximum); delete one first", len(boxes))
		return
	}
	if free, ok := volumeFreeBytes(s.cfg.BoxesDir); ok && free < int64(s.cfg.DiskLimitMB)<<20 {
		httpErr(w, http.StatusInsufficientStorage, "the shared volume is full")
		return
	}
	now := s.now().UTC()
	b := &Box{ID: uuid.New(), Owner: ident.Id, OwnerName: ident.Username, Name: strings.TrimSpace(req.Name),
		CreatedAt: now, LastActiveAt: now, DiskLimitMB: s.cfg.DiskLimitMB}
	if err := os.MkdirAll(s.cDir(b.ID), 0o755); err != nil {
		httpErr(w, http.StatusInternalServerError, "creating the box folder: %v", err)
		return
	}
	if err := s.store.CreateBox(r.Context(), b); err != nil {
		os.RemoveAll(s.boxDir(b.ID))
		httpErr(w, http.StatusInternalServerError, "%v", err)
		return
	}
	if err := s.attach(r.Context(), b, items); err != nil {
		s.store.DeleteBox(r.Context(), b.ID)
		os.RemoveAll(s.boxDir(b.ID))
		writeAttachErr(w, err)
		return
	}
	if len(items) > 0 {
		if nb, err := s.store.GetBox(r.Context(), b.ID); err == nil {
			b = nb
		}
	}
	logrus.WithFields(logrus.Fields{"box": b.ID, "owner": ident.Username, "items": len(items)}).Info("box created")
	writeJSON(w, http.StatusCreated, s.view(*b, nil))
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request, ident auth.Identity, b *Box) {
	if err := s.kube.DeletePod(r.Context(), podName(b.ID)); err != nil {
		httpErr(w, http.StatusBadGateway, "%v", err)
		return
	}
	if err := s.store.DeleteBox(r.Context(), b.ID); err != nil {
		httpErr(w, http.StatusInternalServerError, "%v", err)
		return
	}
	if err := os.RemoveAll(s.boxDir(b.ID)); err != nil {
		logrus.WithError(err).WithField("box", b.ID).Warn("removing box folder")
	}
	s.mu.Lock()
	delete(s.active, b.ID)
	delete(s.stopped, b.ID)
	s.mu.Unlock()
	logrus.WithFields(logrus.Fields{"box": b.ID, "by": ident.Username}).Info("box deleted")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleStart(w http.ResponseWriter, r *http.Request, ident auth.Identity, b *Box) {
	s.startMu.Lock()
	defer s.startMu.Unlock()
	ctx := r.Context()
	if p, err := s.pod(ctx, b.ID); err != nil {
		httpErr(w, http.StatusBadGateway, "%v", err)
		return
	} else if p != nil {
		if st, _ := podState(p); st != StateFailed && st != StateStopping {
			writeJSON(w, http.StatusOK, s.view(*b, p)) // already running or starting
			return
		}
		// A failed or terminating pod is cleared out of the way first.
		if err := s.kube.DeletePod(ctx, podName(b.ID)); err != nil {
			httpErr(w, http.StatusBadGateway, "%v", err)
			return
		}
		if !s.waitGone(ctx, b.ID, 30*time.Second) {
			httpErr(w, http.StatusConflict, "the previous instance is still stopping, try again")
			return
		}
	}
	used := dirUsage(s.cDir(b.ID))
	s.store.SetUsage(ctx, b.ID, used)
	if used > int64(b.DiskLimitMB)<<20 {
		httpErr(w, http.StatusConflict, "C: uses %d MB of %d MB; delete files before starting", used>>20, b.DiskLimitMB)
		return
	}
	pods, err := s.kube.ListPods(ctx, appLabel+"="+appBox)
	if err != nil {
		httpErr(w, http.StatusBadGateway, "%v", err)
		return
	}
	mine, total := 0, 0
	for _, p := range pods {
		if p.Metadata.DeletionTimestamp != nil {
			continue
		}
		total++
		if p.Metadata.Labels[ownerLabel] == ident.Id.String() {
			mine++
		}
	}
	if mine >= s.cfg.MaxRunningPerUser && !ident.IsAdmin() {
		httpErr(w, http.StatusConflict, "you can run %d box(es) at a time; stop the other one first", s.cfg.MaxRunningPerUser)
		return
	}
	if total >= s.cfg.MaxRunningTotal {
		httpErr(w, http.StatusServiceUnavailable, "all %d box slots are in use; try again later", s.cfg.MaxRunningTotal)
		return
	}
	if err := os.MkdirAll(s.cDir(b.ID), 0o755); err != nil {
		httpErr(w, http.StatusInternalServerError, "%v", err)
		return
	}
	pod := boxPod(s.cfg, b, b.DiskLimitMB-int(used>>20))
	if err := s.kube.CreatePod(ctx, pod); err != nil {
		httpErr(w, http.StatusBadGateway, "starting the box: %v", err)
		return
	}
	s.touch(b.ID)
	s.mu.Lock()
	delete(s.stopped, b.ID)
	s.mu.Unlock()
	logrus.WithFields(logrus.Fields{"box": b.ID, "owner": b.OwnerName}).Info("box started")
	writeJSON(w, http.StatusAccepted, s.view(*b, pod))
}

func (s *Server) waitGone(ctx context.Context, id uuid.UUID, max time.Duration) bool {
	deadline := s.now().Add(max)
	for s.now().Before(deadline) {
		if p, err := s.pod(ctx, id); err == nil && p == nil {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(time.Second):
		}
	}
	return false
}

func (s *Server) handleStop(w http.ResponseWriter, r *http.Request, ident auth.Identity, b *Box) {
	if err := s.kube.DeletePod(r.Context(), podName(b.ID)); err != nil {
		httpErr(w, http.StatusBadGateway, "%v", err)
		return
	}
	s.persistActive(r.Context(), b.ID)
	logrus.WithFields(logrus.Fields{"box": b.ID, "by": ident.Username}).Info("box stopped")
	p, _ := s.pod(r.Context(), b.ID)
	writeJSON(w, http.StatusOK, s.view(*b, p))
}

func (s *Server) persistActive(ctx context.Context, id uuid.UUID) {
	s.mu.Lock()
	t, ok := s.active[id]
	s.mu.Unlock()
	if ok {
		s.store.Touch(ctx, id, t)
	}
}

// ---- proxying to the box's stream sidecar

func (s *Server) runningPod(w http.ResponseWriter, r *http.Request, b *Box) *Pod {
	p, err := s.pod(r.Context(), b.ID)
	if err != nil {
		httpErr(w, http.StatusBadGateway, "%v", err)
		return nil
	}
	if st, reason := podState(p); st != StateRunning {
		httpErr(w, http.StatusConflict, "box is %s %s", st, reason)
		return nil
	}
	return p
}

func (s *Server) proxyTo(p *Pod, path string) *httputil.ReverseProxy {
	target := &url.URL{Scheme: "http", Host: fmt.Sprintf("%s:%d", p.Status.PodIP, s.cfg.BoxPort)}
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.URL.Path, pr.Out.URL.RawPath = path, ""
			// The sidecar has no auth of its own; never hand it the
			// user's session.
			pr.Out.Header.Del("Cookie")
			pr.Out.Header.Del("Authorization")
			// The sidecar's WebSocket upgrader compares Origin with Host,
			// and Host is now the pod IP, so a browser's Origin would always
			// be refused. The origin is checked here instead (handleWS),
			// where the public host is known.
			pr.Out.Header.Del("Origin")
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			httpErr(w, http.StatusBadGateway, "box unreachable: %v", err)
		},
	}
}

// sameOrigin reports whether a request's Origin (if any) names the host it
// was sent to. Non-browser clients send no Origin and are let through; they
// still need the session like any other API call.
func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && strings.EqualFold(u.Host, r.Host)
}

// GET /api/boxes/{id}/ws: the player's WebSocket (frames out, input in).
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request, _ auth.Identity, b *Box) {
	// WebSockets are not covered by CORS: refuse a page from another site
	// driving the user's box with their cookies.
	if !sameOrigin(r) {
		httpErr(w, http.StatusForbidden, "cross-origin websocket")
		return
	}
	p := s.runningPod(w, r, b)
	if p == nil {
		return
	}
	s.mu.Lock()
	s.viewers[b.ID]++
	s.mu.Unlock()
	s.touch(b.ID)
	defer func() {
		s.mu.Lock()
		if s.viewers[b.ID]--; s.viewers[b.ID] <= 0 {
			delete(s.viewers, b.ID)
		}
		s.mu.Unlock()
		s.touch(b.ID)
		s.persistActive(context.Background(), b.ID)
	}()
	r.URL.RawQuery = ""
	s.proxyTo(p, "/ws").ServeHTTP(w, r) // returns when the WebSocket closes
}

// The sidecar endpoints a box owner may call through the gateway (files go
// through the gateway's own file API, which enforces the disk limit).
var ctlOps = map[string]string{
	"type": "POST", "keys": "POST", "mouse": "POST", "click": "POST", "rescan": "POST",
	"snapshot.png": "GET", "snapshot.jpg": "GET",
}

// /api/boxes/{id}/ctl/<op>: the box control API (see stream/control.go).
func (s *Server) handleCtl(w http.ResponseWriter, r *http.Request, _ auth.Identity, b *Box) {
	op := r.PathValue("op")
	if m, ok := ctlOps[op]; !ok || m != r.Method {
		httpErr(w, http.StatusNotFound, "no such control endpoint")
		return
	}
	p := s.runningPod(w, r, b)
	if p == nil {
		return
	}
	s.touch(b.ID)
	s.proxyTo(p, "/"+op).ServeHTTP(w, r)
}

// rescan asks a running box to re-read its drives after its C: changed.
func (s *Server) rescan(ctx context.Context, id uuid.UUID) bool {
	p, err := s.pod(ctx, id)
	if err != nil || p == nil || p.Status.PodIP == "" {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("http://%s:%d/rescan", p.Status.PodIP, s.cfg.BoxPort), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}
