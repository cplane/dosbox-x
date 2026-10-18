package gateway

import (
	"archive/tar"
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/sirupsen/logrus"
)

// The catalog is ready-made DOS software (games, compilers, tools) that a box
// can get a copy of on its C: drive. An item is a folder of files:
//
//   - the unpacked copy on the shared volume (<BoxesDir>/_catalog/<slug>) is
//     what boxes are filled from — attaching copies it to C:\<DIR>, so the
//     box can write to it like to anything else on its drive;
//   - the master copy is a zip in DO Spaces (catalog/<slug>.zip), from which
//     a lost volume copy is restored. Without Spaces configured the catalog
//     still works, volume only, and Sync uploads the zips once it is.

const (
	CatalogReady     = "ready"
	CatalogImporting = "importing"
	CatalogFailed    = "failed"
)

type CatalogItem struct {
	Slug        string    `json:"slug"`
	Title       string    `json:"title"`
	Category    string    `json:"category"`
	Description string    `json:"description"`
	Dir         string    `json:"dir"` // folder created on C:, e.g. KEEN1
	Run         string    `json:"run"` // program in Dir that starts it, e.g. KEEN1.EXE
	Source      string    `json:"source"`
	License     string    `json:"license"`
	SizeBytes   int64     `json:"sizeBytes"`
	Files       int       `json:"files"`
	Status      string    `json:"status"`
	Error       string    `json:"error,omitempty"`
	CreatedBy   string    `json:"createdBy"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

var (
	slugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)
	// A DOS 8.3 directory name, upper case.
	dosDirRe = regexp.MustCompile(`^[A-Z0-9_-]{1,8}$`)
	// A program inside the item, e.g. KEEN1.EXE or BIN\TC.EXE.
	runRe      = regexp.MustCompile(`^([A-Z0-9_-]{1,8}\\){0,3}[A-Z0-9_-]{1,8}\.(EXE|COM|BAT)$`)
	categories = map[string]bool{"game": true, "app": true, "dev": true, "util": true, "demo": true, "other": true}
)

func ValidSlug(s string) bool { return slugRe.MatchString(s) }

// Normalize upper-cases the DOS names and checks every field.
func (it *CatalogItem) Normalize() error {
	it.Title = strings.TrimSpace(it.Title)
	it.Dir = strings.ToUpper(strings.TrimSpace(it.Dir))
	it.Run = strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(it.Run), "/", `\`))
	it.Category = strings.ToLower(strings.TrimSpace(it.Category))
	if it.Category == "" {
		it.Category = "app"
	}
	switch {
	case !ValidSlug(it.Slug):
		return errors.New("slug: 1-32 of a-z, 0-9 and -, starting with a letter or digit")
	case it.Title == "" || utf8.RuneCountInString(it.Title) > 60:
		return errors.New("title: 1-60 characters")
	case !dosDirRe.MatchString(it.Dir):
		return errors.New("dir: a DOS folder name, 1-8 of A-Z, 0-9, _ and -")
	case it.Run != "" && !runRe.MatchString(it.Run):
		return errors.New(`run: a program in the folder, e.g. KEEN1.EXE or BIN\TC.EXE`)
	case !categories[it.Category]:
		return errors.New("category: game, app, dev, util, demo or other")
	case utf8.RuneCountInString(it.Description) > 500, utf8.RuneCountInString(it.License) > 200,
		utf8.RuneCountInString(it.Source) > 200:
		return errors.New("description (500), license (200) or source (200) too long")
	}
	return nil
}

// Blob is the catalog's master copy store (DO Spaces).
type Blob interface {
	Put(ctx context.Context, key, file string) error
	Get(ctx context.Context, key, file string) error // download into file
	Exists(ctx context.Context, key string) (bool, error)
	Delete(ctx context.Context, key string) error
}

func blobKey(slug string) string { return "catalog/" + slug + ".zip" }

type Catalog struct {
	dir      string // <BoxesDir>/_catalog
	blob     Blob   // nil: volume only
	store    Store
	maxBytes int64 // unpacked size of one item
	maxFiles int
	now      func() time.Time
	mu       sync.Mutex // serializes swaps of an item's folder
}

func NewCatalog(boxesDir string, blob Blob, store Store, maxMB int) *Catalog {
	if maxMB <= 0 {
		maxMB = 400
	}
	return &Catalog{dir: filepath.Join(boxesDir, "_catalog"), blob: blob, store: store,
		maxBytes: int64(maxMB) << 20, maxFiles: 20000, now: time.Now}
}

func (c *Catalog) ItemDir(slug string) string { return filepath.Join(c.dir, slug) }

// Ingest unpacks an item with extract (into an empty temporary folder),
// stores the master copy, swaps the result in as the item's folder and
// records it as ready. A single top-level folder in the archive is unwrapped:
// the item's own Dir names its folder on C:.
func (c *Catalog) Ingest(ctx context.Context, it CatalogItem, extract func(dst string) error) (CatalogItem, error) {
	if err := os.MkdirAll(c.dir, 0o755); err != nil {
		return it, err
	}
	tmp, err := os.MkdirTemp(c.dir, ".ingest-")
	if err != nil {
		return it, err
	}
	defer os.RemoveAll(tmp)
	if err := extract(tmp); err != nil {
		return it, err
	}
	for i := 0; i < 3; i++ { // e.g. stunts/stunts/...
		if err := unwrapSingleDir(tmp); err != nil {
			return it, err
		}
	}
	size, files := treeStats(tmp)
	if files == 0 {
		return it, errors.New("the archive has no files")
	}
	if c.blob != nil {
		if err := c.upload(ctx, it.Slug, tmp); err != nil {
			return it, fmt.Errorf("storing the master copy: %w", err)
		}
	}
	if err := c.swapIn(tmp, it.Slug); err != nil {
		return it, err
	}
	it.SizeBytes, it.Files, it.Status, it.Error = size, files, CatalogReady, ""
	it.UpdatedAt = c.now().UTC()
	if it.CreatedAt.IsZero() {
		it.CreatedAt = it.UpdatedAt
	}
	if err := c.store.PutCatalogItem(ctx, &it); err != nil {
		return it, err
	}
	logrus.WithFields(logrus.Fields{"item": it.Slug, "files": files, "bytes": size}).Info("catalog item ready")
	return it, nil
}

// PutFromTar ingests a tar stream as the item (the seeding path:
// `gateway catalog-put`, fed through kubectl exec).
func (c *Catalog) PutFromTar(ctx context.Context, it CatalogItem, r io.Reader) (CatalogItem, error) {
	if err := it.Normalize(); err != nil {
		return it, err
	}
	if prev, err := c.store.GetCatalogItem(ctx, it.Slug); err == nil {
		it.CreatedAt, it.CreatedBy = prev.CreatedAt, prev.CreatedBy
	}
	return c.Ingest(ctx, it, func(dst string) error {
		_, _, err := extractTar(r, dst, c.maxBytes, c.maxFiles)
		return err
	})
}

// swapIn replaces the item's folder with src (on the same volume).
func (c *Catalog) swapIn(src, slug string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	final := c.ItemDir(slug)
	old := ""
	if _, err := os.Stat(final); err == nil {
		old = fmt.Sprintf("%s.old-%d", final, c.now().UnixNano())
		if err := os.Rename(final, old); err != nil {
			return err
		}
	}
	if err := os.Rename(src, final); err != nil {
		if old != "" {
			os.Rename(old, final)
		}
		return err
	}
	if old != "" {
		os.RemoveAll(old)
	}
	return nil
}

func (c *Catalog) upload(ctx context.Context, slug, dir string) error {
	f, err := os.CreateTemp(c.dir, ".zip-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	err = zipDir(dir, f)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return c.blob.Put(ctx, blobKey(slug), name)
}

// Remove deletes the item's folder and master copy (not the row).
func (c *Catalog) Remove(ctx context.Context, slug string) error {
	c.mu.Lock()
	err := os.RemoveAll(c.ItemDir(slug))
	c.mu.Unlock()
	if c.blob != nil {
		if berr := c.blob.Delete(ctx, blobKey(slug)); err == nil {
			err = berr
		}
	}
	return err
}

// Sync brings the volume and Spaces in line with the table: a ready item
// missing on the volume is restored from Spaces, one missing in Spaces is
// uploaded, and an import that was cut short (gateway restart) is marked
// failed.
func (c *Catalog) Sync(ctx context.Context) {
	items, err := c.store.ListCatalog(ctx)
	if err != nil {
		logrus.WithError(err).Warn("catalog sync")
		return
	}
	for _, it := range items {
		log := logrus.WithField("item", it.Slug)
		switch it.Status {
		case CatalogImporting:
			if c.now().Sub(it.UpdatedAt) > time.Hour {
				it.Status, it.Error, it.UpdatedAt = CatalogFailed, "import interrupted", c.now().UTC()
				c.store.PutCatalogItem(ctx, &it)
			}
			continue
		case CatalogReady:
		default:
			continue
		}
		_, statErr := os.Stat(c.ItemDir(it.Slug))
		onVolume := statErr == nil
		if c.blob == nil {
			if !onVolume {
				log.Warn("catalog item missing on the volume and no Spaces to restore it from")
			}
			continue
		}
		inBlob, err := c.blob.Exists(ctx, blobKey(it.Slug))
		if err != nil {
			log.WithError(err).Warn("catalog sync: checking Spaces")
			continue
		}
		switch {
		case !onVolume && inBlob:
			if err := c.restore(ctx, it.Slug); err != nil {
				log.WithError(err).Warn("catalog sync: restoring from Spaces")
			} else {
				log.Info("catalog item restored from Spaces")
			}
		case onVolume && !inBlob:
			if err := c.upload(ctx, it.Slug, c.ItemDir(it.Slug)); err != nil {
				log.WithError(err).Warn("catalog sync: uploading to Spaces")
			} else {
				log.Info("catalog item uploaded to Spaces")
			}
		case !onVolume:
			log.Warn("catalog item missing on the volume and in Spaces")
		}
	}
}

func (c *Catalog) restore(ctx context.Context, slug string) error {
	if err := os.MkdirAll(c.dir, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(c.dir, ".zip-")
	if err != nil {
		return err
	}
	name := f.Name()
	f.Close()
	defer os.Remove(name)
	if err := c.blob.Get(ctx, blobKey(slug), name); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(c.dir, ".restore-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	if _, _, err := extractZip(name, tmp, c.maxBytes, c.maxFiles); err != nil {
		return err
	}
	return c.swapIn(tmp, slug)
}

// RunSync syncs at start and then periodically.
func (c *Catalog) RunSync(ctx context.Context, every time.Duration) {
	for {
		c.Sync(ctx)
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
	}
}

var ErrExists = errors.New("already exists")

// Attach copies the item into cDir\<Dir> and, if it has a Run program and
// no such file exists yet, writes cDir\<Dir>.BAT that starts it.
func (c *Catalog) Attach(it *CatalogItem, cDir string) error {
	if exists, err := hasEntryFold(cDir, it.Dir); err != nil {
		return err
	} else if exists {
		return fmt.Errorf("C:\\%s %w", it.Dir, ErrExists)
	}
	tmp, err := os.MkdirTemp(cDir, ".attach-")
	if err != nil {
		return err
	}
	if err := copyTree(c.ItemDir(it.Slug), tmp); err != nil {
		os.RemoveAll(tmp)
		return err
	}
	if err := os.Rename(tmp, filepath.Join(cDir, it.Dir)); err != nil {
		os.RemoveAll(tmp)
		return err
	}
	if it.Run == "" {
		return nil
	}
	bat := it.Dir + ".BAT"
	if exists, _ := hasEntryFold(cDir, bat); exists {
		return nil
	}
	script := fmt.Sprintf("@ECHO OFF\r\nC:\r\nCD \\%s\r\n%s %%1 %%2 %%3 %%4\r\nCD \\\r\n", it.Dir, it.Run)
	return os.WriteFile(filepath.Join(cDir, bat), []byte(script), 0o644)
}

// hasEntryFold reports whether dir has an entry named name, ignoring case
// (DOS does).
func hasEntryFold(dir, name string) (bool, error) {
	des, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	for _, de := range des {
		if strings.EqualFold(de.Name(), name) {
			return true, nil
		}
	}
	return false, nil
}

// ---- archive and tree helpers

// treeStats is the total size and count of the regular files under dir.
func treeStats(dir string) (size int64, files int) {
	filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				size += info.Size()
				files++
			}
		}
		return nil
	})
	return
}

// unwrapSingleDir moves the contents of dir/X up into dir when X is dir's
// only entry and a folder.
func unwrapSingleDir(dir string) error {
	des, err := os.ReadDir(dir)
	if err != nil || len(des) != 1 || !des[0].IsDir() {
		return err
	}
	inner := filepath.Join(dir, des[0].Name())
	moved := filepath.Join(dir, ".unwrap")
	if err := os.Rename(inner, moved); err != nil {
		return err
	}
	kids, err := os.ReadDir(moved)
	if err != nil {
		return err
	}
	for _, k := range kids {
		if err := os.Rename(filepath.Join(moved, k.Name()), filepath.Join(dir, k.Name())); err != nil {
			return err
		}
	}
	return os.Remove(moved)
}

// archivePath turns an archive entry name into a safe relative path, or ""
// for entries to skip (directories, macOS metadata).
func archivePath(name string) (string, error) {
	name = strings.ReplaceAll(name, "\\", "/") // zips made on Windows
	name = strings.TrimLeft(name, "/")
	if name == "" || strings.HasSuffix(name, "/") || strings.HasPrefix(name, "__MACOSX/") {
		return "", nil
	}
	clean := path.Clean(name)
	if !filepath.IsLocal(filepath.FromSlash(clean)) {
		return "", fmt.Errorf("unsafe path %q in the archive", name)
	}
	return filepath.FromSlash(clean), nil
}

// budget counts what an archive unpacks to, refusing archives that are too
// big or have too many files (decompression bombs included: the limit is on
// the bytes actually written, not on the headers).
type budget struct {
	left  int64
	files int
}

func (b *budget) write(dst string, r io.Reader, mode fs.FileMode, mtime time.Time) error {
	if b.files--; b.files < 0 {
		return errors.New("the archive has too many files")
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, io.LimitReader(r, b.left+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if b.left -= n; b.left < 0 {
		return errors.New("the archive is too big when unpacked")
	}
	if !mtime.IsZero() {
		os.Chtimes(dst, mtime, mtime)
	}
	return nil
}

// extractZip unpacks the zip file src into dst.
func extractZip(src, dst string, maxBytes int64, maxFiles int) (int64, int, error) {
	zr, err := zip.OpenReader(src)
	if err != nil {
		return 0, 0, fmt.Errorf("reading the zip: %w", err)
	}
	defer zr.Close()
	b := &budget{left: maxBytes, files: maxFiles}
	for _, f := range zr.File {
		if !f.Mode().IsRegular() && !f.Mode().IsDir() {
			continue // symlinks and devices: never
		}
		rel, err := archivePath(f.Name)
		if err != nil {
			return 0, 0, err
		}
		if rel == "" || f.Mode().IsDir() {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return 0, 0, err
		}
		err = b.write(filepath.Join(dst, rel), rc, f.Mode(), f.Modified)
		rc.Close()
		if err != nil {
			return 0, 0, err
		}
	}
	return maxBytes - b.left, maxFiles - b.files, nil
}

// extractTar unpacks a tar stream into dst.
func extractTar(r io.Reader, dst string, maxBytes int64, maxFiles int) (int64, int, error) {
	tr := tar.NewReader(r)
	b := &budget{left: maxBytes, files: maxFiles}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		} else if err != nil {
			return 0, 0, fmt.Errorf("reading the tar: %w", err)
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		rel, err := archivePath(h.Name)
		if err != nil {
			return 0, 0, err
		}
		if rel == "" {
			continue
		}
		if err := b.write(filepath.Join(dst, rel), tr, 0o644, h.ModTime); err != nil {
			return 0, 0, err
		}
	}
	return maxBytes - b.left, maxFiles - b.files, nil
}

// zipDir writes the files under dir to w as a zip (paths with "/").
func zipDir(dir string, w io.Writer) error {
	zw := zip.NewWriter(w)
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.Type().IsRegular() {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		h, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		h.Name, h.Method = filepath.ToSlash(rel), zip.Deflate
		fw, err := zw.CreateHeader(h)
		if err != nil {
			return err
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(fw, f)
		return err
	})
	if cerr := zw.Close(); err == nil {
		err = cerr
	}
	return err
}

// copyTree copies the regular files under src into dst (created).
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		in, err := os.Open(p)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			return err
		}
		_, err = io.Copy(out, in)
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		if err == nil {
			os.Chtimes(target, info.ModTime(), info.ModTime())
		}
		return err
	})
}
