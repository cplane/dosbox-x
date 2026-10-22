package gateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"dosbox/core/auth"
)

// The box's C: drive is served by the gateway straight from the shared
// volume (not by the box's sidecar), so it works while the box is stopped
// and every write is checked against the box's disk allowance first. This
// is the "soft" limit: DOS programs inside a running box write to the
// folder directly; the janitor stops a box that goes over (see janitor.go)
// and DOS sees the remaining allowance as free space (mount -freesize).

// dirUsage is the total size of the regular files under dir.
func dirUsage(dir string) int64 {
	var n int64
	filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				n += info.Size()
			}
		}
		return nil
	})
	return n
}

// cPath maps a /files/ path onto the box's C: folder, refusing anything
// that would leave it. "" is the folder itself.
func (s *Server) cPath(b *Box, p string) (string, error) {
	p = strings.Trim(strings.ReplaceAll(p, "\\", "/"), "/")
	if p == "" {
		return s.cDir(b.ID), nil
	}
	if !filepath.IsLocal(filepath.FromSlash(p)) {
		return "", fmt.Errorf("bad path %q", p)
	}
	return filepath.Join(s.cDir(b.ID), filepath.FromSlash(p)), nil
}

func (s *Server) lockBox(b *Box) func() {
	m, _ := s.boxMu.LoadOrStore(b.ID, &sync.Mutex{})
	m.(*sync.Mutex).Lock()
	return m.(*sync.Mutex).Unlock
}

type fileEntry struct {
	Name  string    `json:"name"`
	Size  int64     `json:"size"`
	Dir   bool      `json:"dir"`
	MTime time.Time `json:"mtime"`
}

// GET /api/boxes/{id}/files/<path>: JSON listing for a directory, the bytes
// for a file (?download=1 adds Content-Disposition).
func (s *Server) handleFileGet(w http.ResponseWriter, r *http.Request, _ auth.Identity, b *Box) {
	hp, err := s.cPath(b, r.PathValue("path"))
	if err != nil {
		httpErr(w, http.StatusBadRequest, "%v", err)
		return
	}
	st, err := os.Stat(hp)
	if errors.Is(err, fs.ErrNotExist) {
		httpErr(w, http.StatusNotFound, "not found")
		return
	} else if err != nil {
		httpErr(w, http.StatusInternalServerError, "%v", err)
		return
	}
	if !st.IsDir() {
		f, err := os.Open(hp)
		if err != nil {
			httpErr(w, http.StatusInternalServerError, "%v", err)
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", "application/octet-stream")
		if r.URL.Query().Get("download") != "" {
			w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", st.Name()))
		}
		http.ServeContent(w, r, st.Name(), st.ModTime(), f)
		return
	}
	des, err := os.ReadDir(hp)
	if err != nil {
		httpErr(w, http.StatusInternalServerError, "%v", err)
		return
	}
	list := []fileEntry{}
	for _, de := range des {
		info, err := de.Info()
		if err != nil || strings.HasPrefix(de.Name(), ".upload-") {
			continue
		}
		e := fileEntry{Name: de.Name(), Dir: de.IsDir(), MTime: info.ModTime().UTC()}
		if !e.Dir {
			e.Size = info.Size()
		}
		list = append(list, e)
	}
	writeJSON(w, http.StatusOK, list)
}

// PUT /api/boxes/{id}/files/<path>[?rescan=0]: write the body to C:\<path>
// (parents created) if it fits the box's allowance, then make a running
// box rescan its drives.
func (s *Server) handleFilePut(w http.ResponseWriter, r *http.Request, _ auth.Identity, b *Box) {
	hp, err := s.cPath(b, r.PathValue("path"))
	if err != nil || hp == s.cDir(b.ID) {
		httpErr(w, http.StatusBadRequest, "bad path")
		return
	}
	defer s.lockBox(b)()
	limit := int64(b.DiskLimitMB) << 20
	used := dirUsage(s.cDir(b.ID))
	var replaced int64
	if st, err := os.Stat(hp); err == nil {
		if st.IsDir() {
			httpErr(w, http.StatusConflict, "%s is a directory", r.PathValue("path"))
			return
		}
		replaced = st.Size()
	}
	room := limit - used + replaced
	if room <= 0 || r.ContentLength > room {
		httpErr(w, http.StatusRequestEntityTooLarge, "C: has %d MB of %d MB free", max(room, 0)>>20, b.DiskLimitMB)
		return
	}
	if free, ok := volumeFreeBytes(s.cfg.BoxesDir); ok && r.ContentLength > free-(64<<20) {
		httpErr(w, http.StatusInsufficientStorage, "the shared volume is full")
		return
	}
	if err := os.MkdirAll(filepath.Dir(hp), 0o755); err != nil {
		httpErr(w, http.StatusInternalServerError, "%v", err)
		return
	}
	_, statErr := os.Stat(hp)
	created := errors.Is(statErr, fs.ErrNotExist)
	tmp, err := os.CreateTemp(filepath.Dir(hp), ".upload-*")
	if err != nil {
		httpErr(w, http.StatusInternalServerError, "%v", err)
		return
	}
	n, err := io.Copy(tmp, http.MaxBytesReader(w, r.Body, room))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp.Name(), 0o644)
	}
	if err == nil {
		err = os.Rename(tmp.Name(), hp)
	}
	if err != nil {
		os.Remove(tmp.Name())
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			httpErr(w, http.StatusRequestEntityTooLarge, "C: has %d MB of %d MB free", room>>20, b.DiskLimitMB)
		} else {
			httpErr(w, http.StatusInternalServerError, "%v", err)
		}
		return
	}
	s.store.SetUsage(r.Context(), b.ID, used-replaced+n)
	s.touch(b.ID)
	resp := map[string]any{"path": r.PathValue("path"), "size": n, "rescanned": false}
	if r.URL.Query().Get("rescan") != "0" {
		resp["rescanned"] = s.rescan(r.Context(), b.ID)
	}
	code := http.StatusOK
	if created {
		code = http.StatusCreated
	}
	writeJSON(w, code, resp)
}

// POST /api/boxes/{id}/files/<path> {"op": "mkdir"} or {"op": "rename", "to": "<path>"}: make a folder
// (its parents too), or rename / move a file or folder within C:. Neither may replace something that exists.
func (s *Server) handleFileOp(w http.ResponseWriter, r *http.Request, _ auth.Identity, b *Box) {
	hp, err := s.cPath(b, r.PathValue("path"))
	if err != nil || hp == s.cDir(b.ID) {
		httpErr(w, http.StatusBadRequest, "bad path")
		return
	}
	var req struct {
		Op string `json:"op"`
		To string `json:"to"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req); err != nil {
		httpErr(w, http.StatusBadRequest, "bad request: %v", err)
		return
	}
	defer s.lockBox(b)()
	switch req.Op {
	case "mkdir":
		if _, err := os.Lstat(hp); err == nil {
			httpErr(w, http.StatusConflict, "%s already exists", r.PathValue("path"))
			return
		}
		if err := os.MkdirAll(hp, 0o755); err != nil {
			httpErr(w, http.StatusInternalServerError, "%v", err)
			return
		}
	case "rename":
		to, err := s.cPath(b, req.To)
		if err != nil || to == s.cDir(b.ID) {
			httpErr(w, http.StatusBadRequest, "bad target path")
			return
		}
		if _, err := os.Lstat(hp); errors.Is(err, fs.ErrNotExist) {
			httpErr(w, http.StatusNotFound, "not found")
			return
		}
		// Only a change of case may name something that "exists" (DOS names are case-blind).
		if _, err := os.Lstat(to); err == nil && !strings.EqualFold(hp, to) {
			httpErr(w, http.StatusConflict, "%s already exists", req.To)
			return
		}
		if rel, err := filepath.Rel(hp, to); err == nil && filepath.IsLocal(rel) && rel != "." {
			httpErr(w, http.StatusBadRequest, "a folder cannot move into itself")
			return
		}
		if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
			httpErr(w, http.StatusInternalServerError, "%v", err)
			return
		}
		if err := os.Rename(hp, to); err != nil {
			httpErr(w, http.StatusConflict, "%v", err)
			return
		}
	default:
		httpErr(w, http.StatusBadRequest, "unknown op %q", req.Op)
		return
	}
	s.touch(b.ID)
	s.rescan(r.Context(), b.ID)
	w.WriteHeader(http.StatusNoContent)
}

// DELETE /api/boxes/{id}/files/<path>[?recursive=1]
func (s *Server) handleFileDelete(w http.ResponseWriter, r *http.Request, _ auth.Identity, b *Box) {
	hp, err := s.cPath(b, r.PathValue("path"))
	if err != nil || hp == s.cDir(b.ID) {
		httpErr(w, http.StatusBadRequest, "bad path")
		return
	}
	defer s.lockBox(b)()
	st, err := os.Lstat(hp)
	if errors.Is(err, fs.ErrNotExist) {
		httpErr(w, http.StatusNotFound, "not found")
		return
	} else if err != nil {
		httpErr(w, http.StatusInternalServerError, "%v", err)
		return
	}
	if st.IsDir() && r.URL.Query().Get("recursive") == "1" {
		err = os.RemoveAll(hp)
	} else {
		err = os.Remove(hp) // a non-empty directory fails here
	}
	if err != nil {
		httpErr(w, http.StatusConflict, "%v", err)
		return
	}
	s.store.SetUsage(r.Context(), b.ID, dirUsage(s.cDir(b.ID)))
	s.touch(b.ID)
	s.rescan(r.Context(), b.ID)
	w.WriteHeader(http.StatusNoContent)
}
