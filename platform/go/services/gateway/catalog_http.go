package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/sirupsen/logrus"

	"dosbox/core/auth"
)

// Catalog API (see catalog.go):
//
//	GET    /api/catalog                 items (players: ready ones)
//	PUT    /api/catalog/{slug}?title=…  admin: upload a zip (body) as the item
//	PATCH  /api/catalog/{slug}          admin: edit title, dir, run, …
//	DELETE /api/catalog/{slug}          admin
//	POST   /api/catalog/import          admin: {"identifier": "<archive.org id>", …}
//	POST   /api/boxes/{id}/attach       {"items": ["keen1", …]} copy into the box's C:
//
// Uploads and imports answer 202 and finish in the background; the item's
// status goes importing -> ready (or failed, with error).

func (s *Server) admin(next func(http.ResponseWriter, *http.Request, auth.Identity)) http.HandlerFunc {
	return s.signedIn(func(w http.ResponseWriter, r *http.Request, ident auth.Identity) {
		if !ident.IsAdmin() {
			httpErr(w, http.StatusForbidden, "admins only")
			return
		}
		next(w, r, ident)
	})
}

func (s *Server) handleCatalogList(w http.ResponseWriter, r *http.Request, ident auth.Identity) {
	items, err := s.store.ListCatalog(r.Context())
	if err != nil {
		httpErr(w, http.StatusInternalServerError, "%v", err)
		return
	}
	out := []CatalogItem{}
	for _, it := range items {
		if it.Status == CatalogReady || ident.IsAdmin() {
			out = append(out, it)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// itemFields is what an admin sets on an item (upload query, edit, import).
type itemFields struct {
	Title       *string `json:"title"`
	Category    *string `json:"category"`
	Description *string `json:"description"`
	Dir         *string `json:"dir"`
	Run         *string `json:"run"`
	Source      *string `json:"source"`
	License     *string `json:"license"`
}

func (f itemFields) apply(it *CatalogItem) {
	set := func(dst *string, v *string) {
		if v != nil {
			*dst = *v
		}
	}
	set(&it.Title, f.Title)
	set(&it.Category, f.Category)
	set(&it.Description, f.Description)
	set(&it.Dir, f.Dir)
	set(&it.Run, f.Run)
	set(&it.Source, f.Source)
	set(&it.License, f.License)
}

func fieldsFromQuery(q url.Values) itemFields {
	get := func(k string) *string {
		if !q.Has(k) {
			return nil
		}
		v := q.Get(k)
		return &v
	}
	return itemFields{Title: get("title"), Category: get("category"), Description: get("description"),
		Dir: get("dir"), Run: get("run"), Source: get("source"), License: get("license")}
}

// newItem starts an item for slug: the existing one (re-upload keeps its
// fields unless given) or a fresh one with defaults derived from the slug.
func (s *Server) newItem(ctx context.Context, slug string, ident auth.Identity, f itemFields) (CatalogItem, *CatalogItem, error) {
	var it CatalogItem
	prev, err := s.store.GetCatalogItem(ctx, slug)
	switch {
	case err == nil:
		it = *prev
	case errors.Is(err, ErrNotFound):
		prev = nil
		it = CatalogItem{Slug: slug, Title: slug, Dir: defaultDir(slug), CreatedBy: ident.Username,
			CreatedAt: s.now().UTC()}
	default:
		return it, nil, err
	}
	f.apply(&it)
	return it, prev, it.Normalize()
}

var nonDOS = regexp.MustCompile(`[^A-Z0-9_-]`)

func defaultDir(slug string) string {
	d := nonDOS.ReplaceAllString(strings.ToUpper(slug), "")
	if len(d) > 8 {
		d = d[:8]
	}
	if d == "" {
		d = "APP"
	}
	return d
}

// PUT /api/catalog/{slug}?title=…&dir=…&run=…: the body is a zip.
func (s *Server) handleCatalogUpload(w http.ResponseWriter, r *http.Request, ident auth.Identity) {
	slug := r.PathValue("slug")
	if !ValidSlug(slug) {
		httpErr(w, http.StatusBadRequest, "bad slug")
		return
	}
	it, prev, err := s.newItem(r.Context(), slug, ident, fieldsFromQuery(r.URL.Query()))
	if err != nil {
		httpErr(w, http.StatusBadRequest, "%v", err)
		return
	}
	if it.Source == "" {
		it.Source = "upload by " + ident.Username
	}
	if err := os.MkdirAll(s.catalog.dir, 0o755); err != nil {
		httpErr(w, http.StatusInternalServerError, "%v", err)
		return
	}
	f, err := os.CreateTemp(s.catalog.dir, ".upload-")
	if err != nil {
		httpErr(w, http.StatusInternalServerError, "%v", err)
		return
	}
	_, err = io.Copy(f, http.MaxBytesReader(w, r.Body, s.catalog.maxBytes))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(f.Name())
		httpErr(w, http.StatusRequestEntityTooLarge, "upload: %v", err)
		return
	}
	zipFile := f.Name()
	it = s.startImport(it, prev, nil, zipFile)
	writeJSON(w, http.StatusAccepted, it)
}

// POST /api/catalog/import {"identifier", "file"?, "slug"?, "title"?, "dir"?, "run"?, …}
func (s *Server) handleCatalogImport(w http.ResponseWriter, r *http.Request, ident auth.Identity) {
	var req struct {
		itemFields
		Identifier string `json:"identifier"`
		File       string `json:"file"`
		Slug       string `json:"slug"`
		Replace    bool   `json:"replace"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		httpErr(w, http.StatusBadRequest, "%v", err)
		return
	}
	req.Identifier = strings.TrimSpace(req.Identifier)
	if !archiveIDRe.MatchString(req.Identifier) {
		httpErr(w, http.StatusBadRequest, "identifier: the archive.org item id, e.g. msdos_Prince_of_Persia_1990")
		return
	}
	if req.Slug == "" {
		req.Slug = slugFrom(req.Identifier)
	}
	if !ValidSlug(req.Slug) {
		httpErr(w, http.StatusBadRequest, "bad slug")
		return
	}
	if req.Title == nil {
		req.Title = &req.Identifier
	}
	if req.Source == nil {
		src := "archive.org:" + req.Identifier
		req.Source = &src
	}
	it, prev, err := s.newItem(r.Context(), req.Slug, ident, req.itemFields)
	if err != nil {
		httpErr(w, http.StatusBadRequest, "%v", err)
		return
	}
	if prev != nil && !req.Replace {
		httpErr(w, http.StatusConflict, "catalog item %q exists; set replace to import over it", req.Slug)
		return
	}
	id, want := req.Identifier, req.File
	fetch := func(ctx context.Context, file string, it *CatalogItem) error {
		_, license, err := fetchArchiveOrg(ctx, s.cfg.ArchiveOrgURL, id, want, file, s.catalog.maxBytes)
		if err == nil && it.License == "" && license != "" {
			it.License = license
		}
		return err
	}
	it = s.startImport(it, prev, fetch, "")
	logrus.WithFields(logrus.Fields{"item": it.Slug, "archive.org": id, "by": ident.Username}).Info("catalog import started")
	writeJSON(w, http.StatusAccepted, it)
}

func slugFrom(id string) string {
	s := strings.Trim(regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(strings.ToLower(id), "-"), "-")
	s = strings.TrimPrefix(s, "msdos-")
	if len(s) > 32 {
		s = strings.TrimRight(s[:32], "-")
	}
	return s
}

// startImport records the item as importing (a new one; an existing ready
// item stays usable until the new copy is in) and finishes in the
// background: fetch fills the zip file (unless zipFile is already given),
// which is then ingested.
func (s *Server) startImport(it CatalogItem, prev *CatalogItem, fetch func(context.Context, string, *CatalogItem) error, zipFile string) CatalogItem {
	if prev == nil || prev.Status != CatalogReady {
		it.Status, it.Error, it.UpdatedAt = CatalogImporting, "", s.now().UTC()
		s.store.PutCatalogItem(context.Background(), &it)
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		err := func() error {
			if zipFile == "" {
				if err := os.MkdirAll(s.catalog.dir, 0o755); err != nil {
					return err
				}
				f, err := os.CreateTemp(s.catalog.dir, ".download-")
				if err != nil {
					return err
				}
				zipFile = f.Name()
				f.Close()
				if err := fetch(ctx, zipFile, &it); err != nil {
					return err
				}
			}
			_, err := s.catalog.Ingest(ctx, it, func(dst string) error {
				_, _, err := extractZip(zipFile, dst, s.catalog.maxBytes, s.catalog.maxFiles)
				return err
			})
			return err
		}()
		if zipFile != "" {
			os.Remove(zipFile)
		}
		if err == nil {
			return
		}
		logrus.WithError(err).WithField("item", it.Slug).Warn("catalog import failed")
		failed := it
		if prev != nil && prev.Status == CatalogReady {
			failed = *prev // the previous copy is still there and usable
		} else {
			failed.Status = CatalogFailed
		}
		failed.Error, failed.UpdatedAt = err.Error(), s.now().UTC()
		s.store.PutCatalogItem(context.Background(), &failed)
	}()
	return it
}

// PATCH /api/catalog/{slug} {"title"?, "dir"?, "run"?, …}
func (s *Server) handleCatalogEdit(w http.ResponseWriter, r *http.Request, _ auth.Identity) {
	it, err := s.store.GetCatalogItem(r.Context(), r.PathValue("slug"))
	if errors.Is(err, ErrNotFound) {
		httpErr(w, http.StatusNotFound, "no such catalog item")
		return
	} else if err != nil {
		httpErr(w, http.StatusInternalServerError, "%v", err)
		return
	}
	var f itemFields
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&f); err != nil {
		httpErr(w, http.StatusBadRequest, "%v", err)
		return
	}
	f.apply(it)
	if err := it.Normalize(); err != nil {
		httpErr(w, http.StatusBadRequest, "%v", err)
		return
	}
	it.UpdatedAt = s.now().UTC()
	if err := s.store.PutCatalogItem(r.Context(), it); err != nil {
		httpErr(w, http.StatusInternalServerError, "%v", err)
		return
	}
	writeJSON(w, http.StatusOK, it)
}

func (s *Server) handleCatalogDelete(w http.ResponseWriter, r *http.Request, ident auth.Identity) {
	slug := r.PathValue("slug")
	if _, err := s.store.GetCatalogItem(r.Context(), slug); errors.Is(err, ErrNotFound) {
		httpErr(w, http.StatusNotFound, "no such catalog item")
		return
	}
	if err := s.catalog.Remove(r.Context(), slug); err != nil {
		logrus.WithError(err).WithField("item", slug).Warn("removing catalog files")
	}
	if err := s.store.DeleteCatalogItem(r.Context(), slug); err != nil {
		httpErr(w, http.StatusInternalServerError, "%v", err)
		return
	}
	logrus.WithFields(logrus.Fields{"item": slug, "by": ident.Username}).Info("catalog item deleted")
	w.WriteHeader(http.StatusNoContent)
}

// readyItems resolves slugs (deduplicated) to ready catalog items.
func (s *Server) readyItems(ctx context.Context, slugs []string) ([]CatalogItem, error) {
	seen := map[string]bool{}
	out := []CatalogItem{}
	for _, slug := range slugs {
		if seen[slug] {
			continue
		}
		seen[slug] = true
		it, err := s.store.GetCatalogItem(ctx, slug)
		if errors.Is(err, ErrNotFound) || err == nil && it.Status != CatalogReady {
			return nil, fmt.Errorf("catalog item %q is not available", slug)
		} else if err != nil {
			return nil, err
		}
		out = append(out, *it)
	}
	return out, nil
}

type attachError struct {
	code int
	msg  string
}

func (e *attachError) Error() string { return e.msg }

// attach copies items into the box's C: if they fit its allowance.
func (s *Server) attach(ctx context.Context, b *Box, items []CatalogItem) error {
	if len(items) == 0 {
		return nil
	}
	defer s.lockBox(b)()
	cdir := s.cDir(b.ID)
	used := dirUsage(cdir)
	var need int64
	for _, it := range items {
		need += it.SizeBytes
	}
	limit := int64(b.DiskLimitMB) << 20
	if used+need > limit {
		return &attachError{http.StatusRequestEntityTooLarge,
			fmt.Sprintf("the items need %d MB but C: has %d MB of %d MB free", need>>20, max(limit-used, 0)>>20, b.DiskLimitMB)}
	}
	if free, ok := volumeFreeBytes(s.cfg.BoxesDir); ok && need > free-(64<<20) {
		return &attachError{http.StatusInsufficientStorage, "the shared volume is full"}
	}
	if err := os.MkdirAll(cdir, 0o755); err != nil {
		return err
	}
	for _, it := range items {
		if err := s.catalog.Attach(&it, cdir); errors.Is(err, ErrExists) {
			return &attachError{http.StatusConflict, err.Error() + "; delete or rename it first"}
		} else if err != nil {
			return fmt.Errorf("copying %s: %w", it.Slug, err)
		}
	}
	s.store.SetUsage(ctx, b.ID, dirUsage(cdir))
	return nil
}

func writeAttachErr(w http.ResponseWriter, err error) {
	var ae *attachError
	if errors.As(err, &ae) {
		httpErr(w, ae.code, "%s", ae.msg)
		return
	}
	httpErr(w, http.StatusInternalServerError, "%v", err)
}

// POST /api/boxes/{id}/attach {"items": ["keen1", …]}
func (s *Server) handleAttach(w http.ResponseWriter, r *http.Request, _ auth.Identity, b *Box) {
	var req struct{ Items []string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil || len(req.Items) == 0 {
		httpErr(w, http.StatusBadRequest, `body: {"items": ["slug", …]}`)
		return
	}
	items, err := s.readyItems(r.Context(), req.Items)
	if err != nil {
		httpErr(w, http.StatusBadRequest, "%v", err)
		return
	}
	if err := s.attach(r.Context(), b, items); err != nil {
		writeAttachErr(w, err)
		return
	}
	s.touch(b.ID)
	rescanned := s.rescan(r.Context(), b.ID)
	b, _ = s.store.GetBox(r.Context(), b.ID)
	p, _ := s.pod(r.Context(), b.ID)
	writeJSON(w, http.StatusOK, map[string]any{"box": s.view(*b, p), "rescanned": rescanned})
}
