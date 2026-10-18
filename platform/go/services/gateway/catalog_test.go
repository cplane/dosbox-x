package gateway

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"dosbox/core/auth"
)

var root = auth.Identity{Id: uuid.New(), Username: "root", Role: auth.RoleAdmin}

func tarOf(t *testing.T, files map[string]string) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for name, body := range files {
		tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg, ModTime: time.Now()})
		tw.Write([]byte(body))
	}
	tw.Close()
	return &buf
}

func zipOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, _ := zw.Create(name)
		w.Write([]byte(body))
	}
	zw.Close()
	return buf.Bytes()
}

// memBlob is an in-memory Spaces.
type memBlob struct {
	mu   sync.Mutex
	objs map[string][]byte
}

func (b *memBlob) Put(_ context.Context, key, file string) error {
	data, err := os.ReadFile(file)
	b.mu.Lock()
	b.objs[key] = data
	b.mu.Unlock()
	return err
}

func (b *memBlob) Get(_ context.Context, key, file string) error {
	b.mu.Lock()
	data, ok := b.objs[key]
	b.mu.Unlock()
	if !ok {
		return fmt.Errorf("no %s", key)
	}
	return os.WriteFile(file, data, 0o644)
}

func (b *memBlob) Exists(_ context.Context, key string) (bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.objs[key]
	return ok, nil
}

func (b *memBlob) Delete(_ context.Context, key string) error {
	b.mu.Lock()
	delete(b.objs, key)
	b.mu.Unlock()
	return nil
}

func TestArchivePathRejectsEscapes(t *testing.T) {
	for _, bad := range []string{"../evil", "a/../../evil", "/../x", `..\x`} {
		if _, err := archivePath(bad); err == nil {
			t.Errorf("archivePath(%q) accepted", bad)
		}
	}
	for in, want := range map[string]string{"KEEN1/KEEN1.EXE": filepath.FromSlash("KEEN1/KEEN1.EXE"),
		`TC\BIN\TC.EXE`: filepath.FromSlash("TC/BIN/TC.EXE"), "dir/": "", "__MACOSX/x": ""} {
		if got, err := archivePath(in); err != nil || got != want {
			t.Errorf("archivePath(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	dir := t.TempDir()
	zf := filepath.Join(dir, "a.zip")
	os.WriteFile(zf, zipOf(t, map[string]string{"ok.txt": "x", "../../escape.txt": "y"}), 0o644)
	if _, _, err := extractZip(zf, filepath.Join(dir, "out"), 1<<20, 100); err == nil {
		t.Fatal("zip with ../ extracted")
	}
	if _, err := os.Stat(filepath.Join(dir, "..", "escape.txt")); err == nil {
		t.Fatal("file written outside the destination")
	}
}

func TestExtractLimits(t *testing.T) {
	dir := t.TempDir()
	zf := filepath.Join(dir, "big.zip")
	os.WriteFile(zf, zipOf(t, map[string]string{"big.bin": strings.Repeat("A", 4096)}), 0o644)
	if _, _, err := extractZip(zf, filepath.Join(dir, "o1"), 1000, 100); err == nil || !strings.Contains(err.Error(), "too big") {
		t.Fatalf("size limit: %v", err)
	}
	zf2 := filepath.Join(dir, "many.zip")
	os.WriteFile(zf2, zipOf(t, map[string]string{"a": "1", "b": "2", "c": "3"}), 0o644)
	if _, _, err := extractZip(zf2, filepath.Join(dir, "o2"), 1<<20, 2); err == nil || !strings.Contains(err.Error(), "too many") {
		t.Fatalf("file limit: %v", err)
	}
}

func TestIngestAttachRestore(t *testing.T) {
	ctx := context.Background()
	boxes := t.TempDir()
	store := newMemStore()
	blob := &memBlob{objs: map[string][]byte{}}
	cat := NewCatalog(boxes, blob, store, 10)

	// A tar with one top-level folder, as `tar -cf - keen1` makes.
	it, err := cat.PutFromTar(ctx, CatalogItem{Slug: "keen1", Title: "Commander Keen 1", Category: "game",
		Dir: "keen1", Run: "keen1.exe"}, tarOf(t, map[string]string{"keen1/KEEN1.EXE": "MZ..", "keen1/SAVE/GAME1.SAV": "s"}))
	if err != nil {
		t.Fatal(err)
	}
	if it.Status != CatalogReady || it.Files != 2 || it.Dir != "KEEN1" || it.Run != "KEEN1.EXE" {
		t.Fatalf("item %+v", it)
	}
	if _, err := os.Stat(filepath.Join(cat.ItemDir("keen1"), "KEEN1.EXE")); err != nil {
		t.Fatal("top-level folder not unwrapped:", err)
	}
	if ok, _ := blob.Exists(ctx, blobKey("keen1")); !ok {
		t.Fatal("master copy not in Spaces")
	}

	cdir := filepath.Join(boxes, "box", "c")
	os.MkdirAll(cdir, 0o755)
	if err := cat.Attach(&it, cdir); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(cdir, "KEEN1", "SAVE", "GAME1.SAV")); err != nil || string(data) != "s" {
		t.Fatalf("attached file: %q %v", data, err)
	}
	bat, _ := os.ReadFile(filepath.Join(cdir, "KEEN1.BAT"))
	if !strings.Contains(string(bat), "CD \\KEEN1\r\nKEEN1.EXE") {
		t.Fatalf("launcher: %q", bat)
	}
	if err := cat.Attach(&it, cdir); err == nil {
		t.Fatal("attaching twice overwrote C:\\KEEN1")
	}

	// The volume copy is lost: Sync restores it from Spaces.
	os.RemoveAll(cat.ItemDir("keen1"))
	cat.Sync(ctx)
	if _, err := os.Stat(filepath.Join(cat.ItemDir("keen1"), "SAVE", "GAME1.SAV")); err != nil {
		t.Fatal("not restored:", err)
	}
	// Spaces lost it: Sync uploads it again.
	blob.Delete(ctx, blobKey("keen1"))
	cat.Sync(ctx)
	if ok, _ := blob.Exists(ctx, blobKey("keen1")); !ok {
		t.Fatal("not re-uploaded")
	}
}

func TestNormalize(t *testing.T) {
	for _, it := range []CatalogItem{
		{Slug: "Bad", Title: "x", Dir: "X"},
		{Slug: "ok", Title: "", Dir: "X"},
		{Slug: "ok", Title: "x", Dir: "TOOLONGNAME"},
		{Slug: "ok", Title: "x", Dir: "X", Run: `..\EVIL.EXE`},
		{Slug: "ok", Title: "x", Dir: "X", Run: "README.TXT"},
		{Slug: "ok", Title: "x", Dir: "X", Category: "weird"},
	} {
		if err := it.Normalize(); err == nil {
			t.Errorf("accepted %+v", it)
		}
	}
	it := CatalogItem{Slug: "tc", Title: "Turbo C", Dir: "tcc", Run: "bin/tc.exe"}
	if err := it.Normalize(); err != nil || it.Run != `BIN\TC.EXE` || it.Category != "app" {
		t.Fatalf("%+v %v", it, err)
	}
}

func waitItem(t *testing.T, e *env, slug, status string) CatalogItem {
	t.Helper()
	for i := 0; i < 200; i++ {
		if it, err := e.store.GetCatalogItem(context.Background(), slug); err == nil && it.Status == status {
			return *it
		}
		time.Sleep(20 * time.Millisecond)
	}
	it, _ := e.store.GetCatalogItem(context.Background(), slug)
	t.Fatalf("item %s never became %s: %+v", slug, status, it)
	return CatalogItem{}
}

func TestCatalogAPI(t *testing.T) {
	e := newEnv(t)
	e.srv.cfg.DiskLimitMB = 1

	// Only admins add items.
	body := zipOf(t, map[string]string{"POP/PRINCE.EXE": strings.Repeat("P", 1000), "POP/README.TXT": "hi"})
	if resp, _ := e.do("alice", "PUT", "/api/catalog/pop?title=Prince&dir=POP&run=PRINCE.EXE&category=game", bytes.NewReader(body)); resp.StatusCode != 403 {
		t.Fatalf("player upload: %d", resp.StatusCode)
	}
	if resp, b := e.do("root", "PUT", "/api/catalog/pop?title=Prince&dir=POP&run=PRINCE.EXE&category=game", bytes.NewReader(body)); resp.StatusCode != 202 {
		t.Fatalf("admin upload: %d %s", resp.StatusCode, b)
	}
	waitItem(t, e, "pop", CatalogReady)

	// Players see ready items.
	_, b := e.do("alice", "GET", "/api/catalog", nil)
	var items []CatalogItem
	json.Unmarshal(b, &items)
	if len(items) != 1 || items[0].Slug != "pop" || items[0].Files != 2 {
		t.Fatalf("catalog: %s", b)
	}

	// A new box with the item on C:, then the same item again is a conflict.
	resp, b := e.do("alice", "POST", "/api/boxes", strings.NewReader(`{"name":"games","items":["pop"]}`))
	if resp.StatusCode != 201 {
		t.Fatalf("create with items: %d %s", resp.StatusCode, b)
	}
	var v boxView
	json.Unmarshal(b, &v)
	if _, err := os.Stat(filepath.Join(e.srv.cDir(v.ID), "POP", "PRINCE.EXE")); err != nil {
		t.Fatal("item not on C:", err)
	}
	if v.UsedBytes != 1002+int64(len("@ECHO OFF\r\nC:\r\nCD \\POP\r\nPRINCE.EXE %1 %2 %3 %4\r\nCD \\\r\n")) {
		t.Fatalf("usage %d", v.UsedBytes)
	}
	if resp, b := e.do("alice", "POST", "/api/boxes/"+v.ID.String()+"/attach", strings.NewReader(`{"items":["pop"]}`)); resp.StatusCode != 409 {
		t.Fatalf("attach twice: %d %s", resp.StatusCode, b)
	}
	// Unknown items and other people's boxes.
	if resp, _ := e.do("alice", "POST", "/api/boxes", strings.NewReader(`{"name":"x","items":["nope"]}`)); resp.StatusCode != 400 {
		t.Fatalf("unknown item: %d", resp.StatusCode)
	}
	if resp, _ := e.do("bob", "POST", "/api/boxes/"+v.ID.String()+"/attach", strings.NewReader(`{"items":["pop"]}`)); resp.StatusCode != 404 {
		t.Fatalf("bob attaching to alice's box: %d", resp.StatusCode)
	}

	// Over the allowance (1 MB): refused, and no half-made box is left.
	big := zipOf(t, map[string]string{"BIG.DAT": strings.Repeat("B", 2<<20)})
	e.do("root", "PUT", "/api/catalog/big?title=Big&dir=BIG", bytes.NewReader(big))
	waitItem(t, e, "big", CatalogReady)
	before, _ := e.store.ListBoxes(context.Background(), bob.Id)
	if resp, b := e.do("bob", "POST", "/api/boxes", strings.NewReader(`{"name":"b","items":["big"]}`)); resp.StatusCode != 413 {
		t.Fatalf("over allowance: %d %s", resp.StatusCode, b)
	}
	if after, _ := e.store.ListBoxes(context.Background(), bob.Id); len(after) != len(before) {
		t.Fatal("a failed create left a box behind")
	}

	// A broken upload ends failed, with the reason.
	e.do("root", "PUT", "/api/catalog/junk?title=Junk&dir=JUNK", strings.NewReader("not a zip"))
	if it := waitItem(t, e, "junk", CatalogFailed); !strings.Contains(it.Error, "zip") {
		t.Fatalf("error: %q", it.Error)
	}
	_, b = e.do("alice", "GET", "/api/catalog", nil)
	if strings.Contains(string(b), "junk") {
		t.Fatal("players see failed items")
	}

	// Edit and delete.
	if resp, b := e.do("root", "PATCH", "/api/catalog/pop", strings.NewReader(`{"title":"Prince of Persia"}`)); resp.StatusCode != 200 || !strings.Contains(string(b), "Prince of Persia") {
		t.Fatalf("edit: %d %s", resp.StatusCode, b)
	}
	if resp, _ := e.do("root", "DELETE", "/api/catalog/pop", nil); resp.StatusCode != 204 {
		t.Fatalf("delete: %d", resp.StatusCode)
	}
	if _, err := os.Stat(e.srv.catalog.ItemDir("pop")); err == nil {
		t.Fatal("deleted item's files remain")
	}
}

func TestArchiveOrgImport(t *testing.T) {
	zipBody := zipOf(t, map[string]string{"Stunts/STUNTS.COM": "MZ", "Stunts/GAME.RES": "r"})
	ao := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/metadata/msdos_Stunts_1990":
			fmt.Fprintf(w, `{"metadata":{"title":"Stunts","licenseurl":"https://example.org/l"},
				"files":[{"name":"stunts.png","size":"10"},{"name":"Stunts_1990.zip","size":"%d"},{"name":"small.zip","size":"1"}]}`, len(zipBody))
		case "/metadata/nothing":
			io.WriteString(w, `{}`)
		case "/download/msdos_Stunts_1990/Stunts_1990.zip":
			w.Write(zipBody)
		default:
			http.NotFound(w, r)
		}
	}))
	defer ao.Close()

	e := newEnv(t)
	e.srv.cfg.ArchiveOrgURL = ao.URL

	if resp, _ := e.do("alice", "POST", "/api/catalog/import", strings.NewReader(`{"identifier":"msdos_Stunts_1990"}`)); resp.StatusCode != 403 {
		t.Fatalf("player import: %d", resp.StatusCode)
	}
	resp, b := e.do("root", "POST", "/api/catalog/import", strings.NewReader(`{"identifier":"msdos_Stunts_1990","title":"Stunts","dir":"STUNTS","run":"STUNTS.COM","category":"game"}`))
	if resp.StatusCode != 202 {
		t.Fatalf("import: %d %s", resp.StatusCode, b)
	}
	it := waitItem(t, e, "stunts-1990", CatalogReady)
	if it.Source != "archive.org:msdos_Stunts_1990" || it.License != "https://example.org/l" || it.Files != 2 {
		t.Fatalf("imported item %+v", it)
	}
	if resp, _ := e.do("root", "POST", "/api/catalog/import", strings.NewReader(`{"identifier":"msdos_Stunts_1990"}`)); resp.StatusCode != 409 {
		t.Fatalf("import over an existing item: %d", resp.StatusCode)
	}
	e.do("root", "POST", "/api/catalog/import", strings.NewReader(`{"identifier":"nothing"}`))
	if it := waitItem(t, e, "nothing", CatalogFailed); !strings.Contains(it.Error, "no item") {
		t.Fatalf("unknown id error: %q", it.Error)
	}
}
