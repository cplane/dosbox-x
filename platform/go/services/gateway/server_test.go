package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"dosbox/core/auth"
)

// fakeKube keeps pods in memory; created pods become Running+Ready at
// podIP immediately.
type fakeKube struct {
	mu    sync.Mutex
	pods  map[string]Pod
	podIP string
}

func (k *fakeKube) CreatePod(_ context.Context, p *Pod) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if _, ok := k.pods[p.Metadata.Name]; ok {
		return errors.New("exists")
	}
	c := *p
	c.Metadata.CreationTimestamp = time.Now()
	c.Status.Phase, c.Status.PodIP = "Running", k.podIP
	c.Status.Conditions = append(c.Status.Conditions, struct {
		Type   string `json:"type"`
		Status string `json:"status"`
	}{"Ready", "True"})
	k.pods[p.Metadata.Name] = c
	return nil
}

func (k *fakeKube) GetPod(_ context.Context, name string) (*Pod, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	p, ok := k.pods[name]
	if !ok {
		return nil, ErrNotFound
	}
	return &p, nil
}

func (k *fakeKube) ListPods(_ context.Context, selector string) ([]Pod, error) {
	key, val, _ := strings.Cut(selector, "=")
	k.mu.Lock()
	defer k.mu.Unlock()
	out := []Pod{}
	for _, p := range k.pods {
		if p.Metadata.Labels[key] == val {
			out = append(out, p)
		}
	}
	return out, nil
}

func (k *fakeKube) DeletePod(_ context.Context, name string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	delete(k.pods, name)
	return nil
}

// tokenVerifier accepts "Bearer <username>" for the users below.
type tokenVerifier map[string]auth.Identity

func (v tokenVerifier) Verify(raw string) (auth.Identity, error) {
	if id, ok := v[raw]; ok {
		return id, nil
	}
	return auth.Identity{}, auth.ErrInvalidToken
}

var (
	alice = auth.Identity{Id: uuid.New(), Username: "alice", Role: auth.RolePlayer}
	bob   = auth.Identity{Id: uuid.New(), Username: "bob", Role: auth.RolePlayer}
)

type env struct {
	t       *testing.T
	srv     *Server
	kube    *fakeKube
	store   *memStore
	api     *httptest.Server
	sidecar *httptest.Server
	calls   chan string // paths the fake sidecar saw
}

func newEnv(t *testing.T) *env {
	t.Helper()
	e := &env{t: t, calls: make(chan string, 100)}
	e.sidecar = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e.calls <- r.Method + " " + r.URL.Path
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			http.Error(w, "credentials leaked to the box", 500)
			return
		}
		io.WriteString(w, "sidecar "+r.URL.Path)
	}))
	t.Cleanup(e.sidecar.Close)
	host, port, _ := net.SplitHostPort(e.sidecar.Listener.Addr().String())
	p, _ := strconv.Atoi(port)
	e.kube = &fakeKube{pods: map[string]Pod{}, podIP: host}
	e.store = newMemStore()
	cfg := &Config{BoxesDir: t.TempDir(), BoxesPVC: "dosbox-boxes", PullSecret: "s", IdleMinutes: 15,
		MaxBoxesPerUser: 2, MaxRunningPerUser: 1, MaxRunningTotal: 2, DiskLimitMB: 1, BoxPort: p}
	e.srv = NewServer(cfg, e.store, e.kube, tokenVerifier{"alice": alice, "bob": bob, "root": root})
	e.api = httptest.NewServer(e.srv.Handler())
	t.Cleanup(e.api.Close)
	return e
}

func (e *env) do(user, method, path string, body io.Reader) (*http.Response, []byte) {
	e.t.Helper()
	req, _ := http.NewRequest(method, e.api.URL+path, body)
	if user != "" {
		req.Header.Set("Authorization", "Bearer "+user)
	}
	req.Header.Set("Cookie", "dbx_access=x")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, b
}

func (e *env) create(user, name string) boxView {
	e.t.Helper()
	resp, b := e.do(user, "POST", "/api/boxes", strings.NewReader(fmt.Sprintf(`{"name":%q}`, name)))
	if resp.StatusCode != 201 {
		e.t.Fatalf("create: %d %s", resp.StatusCode, b)
	}
	var v boxView
	json.Unmarshal(b, &v)
	return v
}

func TestBoxLifecycle(t *testing.T) {
	e := newEnv(t)
	if resp, _ := e.do("", "GET", "/api/boxes", nil); resp.StatusCode != 401 {
		t.Fatalf("anonymous list: %d", resp.StatusCode)
	}
	b1 := e.create("alice", "Turbo C")
	b2 := e.create("alice", "Games")
	if resp, _ := e.do("alice", "POST", "/api/boxes", strings.NewReader(`{"name":"third"}`)); resp.StatusCode != 409 {
		t.Fatalf("box limit: %d", resp.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(e.srv.cfg.BoxesDir, b1.ID.String(), "c")); err != nil {
		t.Fatal("no C: folder:", err)
	}
	// Bob can't see or touch Alice's box.
	if resp, _ := e.do("bob", "POST", "/api/boxes/"+b1.ID.String()+"/start", nil); resp.StatusCode != 404 {
		t.Fatalf("bob start: %d", resp.StatusCode)
	}

	resp, body := e.do("alice", "POST", "/api/boxes/"+b1.ID.String()+"/start", nil)
	if resp.StatusCode != 202 {
		t.Fatalf("start: %d %s", resp.StatusCode, body)
	}
	pod := e.kube.pods[podName(b1.ID)]
	spec, _ := json.Marshal(pod.Spec)
	for _, want := range []string{`"subPath":"` + b1.ID.String() + `"`, `"subPath":"` + b1.ID.String() + `/c"`,
		`"claimName":"dosbox-boxes"`, `"name":"C_FREESIZE_MB","value":"1"`, `"dosbox/storage":"boxes"`, `"automountServiceAccountToken":false`} {
		if !strings.Contains(string(spec), want) {
			t.Errorf("pod spec lacks %s", want)
		}
	}
	if pod.Metadata.Labels[ownerLabel] != alice.Id.String() || pod.Metadata.Labels[storageLabel] != storageValue {
		t.Errorf("labels %v", pod.Metadata.Labels)
	}
	// One running box per user.
	if resp, _ := e.do("alice", "POST", "/api/boxes/"+b2.ID.String()+"/start", nil); resp.StatusCode != 409 {
		t.Fatalf("second running box: %d", resp.StatusCode)
	}
	// Starting again is a no-op.
	if resp, _ := e.do("alice", "POST", "/api/boxes/"+b1.ID.String()+"/start", nil); resp.StatusCode != 200 {
		t.Fatalf("restart running: %d", resp.StatusCode)
	}
	resp, body = e.do("alice", "GET", "/api/boxes", nil)
	var list []boxView
	json.Unmarshal(body, &list)
	if len(list) != 2 || list[0].State != StateRunning || list[1].State != StateStopped {
		t.Fatalf("list %s", body)
	}

	// Control API is proxied, without the user's credentials.
	resp, body = e.do("alice", "POST", "/api/boxes/"+b1.ID.String()+"/ctl/type", strings.NewReader("dir\n"))
	if resp.StatusCode != 200 || string(body) != "sidecar /type" {
		t.Fatalf("ctl type: %d %s", resp.StatusCode, body)
	}
	if resp, _ := e.do("alice", "GET", "/api/boxes/"+b1.ID.String()+"/ctl/files/X", nil); resp.StatusCode != 404 {
		t.Fatalf("non-whitelisted ctl: %d", resp.StatusCode)
	}
	if resp, _ := e.do("alice", "GET", "/api/boxes/"+b1.ID.String()+"/ctl/type", nil); resp.StatusCode != 404 {
		t.Fatalf("wrong method: %d", resp.StatusCode)
	}

	// Global cap: bob's box would be the third running pod with a cap of 2.
	bb := e.create("bob", "bob's")
	if resp, _ := e.do("bob", "POST", "/api/boxes/"+bb.ID.String()+"/start", nil); resp.StatusCode != 202 {
		t.Fatalf("bob start: %d", resp.StatusCode)
	}
	b3 := e.create("bob", "bob 2")
	e.srv.cfg.MaxRunningPerUser = 5
	if resp, _ := e.do("bob", "POST", "/api/boxes/"+b3.ID.String()+"/start", nil); resp.StatusCode != 503 {
		t.Fatalf("global cap: %d", resp.StatusCode)
	}

	if resp, _ := e.do("alice", "POST", "/api/boxes/"+b1.ID.String()+"/stop", nil); resp.StatusCode != 200 {
		t.Fatalf("stop: %d", resp.StatusCode)
	}
	if _, ok := e.kube.pods[podName(b1.ID)]; ok {
		t.Fatal("pod still there after stop")
	}
	if resp, _ := e.do("alice", "DELETE", "/api/boxes/"+b2.ID.String(), nil); resp.StatusCode != 204 {
		t.Fatalf("delete: %d", resp.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(e.srv.cfg.BoxesDir, b2.ID.String())); !os.IsNotExist(err) {
		t.Fatal("folder survived delete")
	}
}

func TestFilesAndDiskLimit(t *testing.T) {
	e := newEnv(t) // DiskLimitMB = 1
	b := e.create("alice", "files")
	base := "/api/boxes/" + b.ID.String() + "/files/"
	resp, body := e.do("alice", "PUT", base+"SRC/HELLO.C", strings.NewReader("main(){}\r\n"))
	if resp.StatusCode != 201 || !strings.Contains(string(body), `"rescanned":false`) {
		t.Fatalf("put: %d %s", resp.StatusCode, body)
	}
	resp, body = e.do("alice", "GET", base+"SRC", nil)
	var list []fileEntry
	json.Unmarshal(body, &list)
	if len(list) != 1 || list[0].Name != "HELLO.C" || list[0].Size != 10 {
		t.Fatalf("listing %s", body)
	}
	if _, body = e.do("alice", "GET", base+"SRC/HELLO.C", nil); string(body) != "main(){}\r\n" {
		t.Fatalf("get %q", body)
	}
	// Over the 1 MB allowance: refused, nothing written.
	big := strings.Repeat("x", 1<<20)
	if resp, _ = e.do("alice", "PUT", base+"BIG.BIN", strings.NewReader(big)); resp.StatusCode != 413 {
		t.Fatalf("over limit: %d", resp.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(e.srv.cDir(b.ID), "BIG.BIN")); err == nil {
		t.Fatal("over-limit file written")
	}
	// Replacing a file counts only the difference.
	if resp, _ = e.do("alice", "PUT", base+"SRC/HELLO.C", strings.NewReader(strings.Repeat("y", 1<<20-10))); resp.StatusCode != 200 {
		t.Fatalf("replace within limit: %d", resp.StatusCode)
	}
	for _, bad := range []string{"..%2F..%2Fescape", "SRC/../../escape"} {
		if resp, _ := e.do("alice", "PUT", base+bad, strings.NewReader("x")); resp.StatusCode != 400 && resp.StatusCode != 404 {
			t.Errorf("%s: %d", bad, resp.StatusCode)
		}
	}
	if resp, _ := e.do("bob", "GET", base, nil); resp.StatusCode != 404 {
		t.Fatalf("bob reads alice's files: %d", resp.StatusCode)
	}
	// Directory delete needs ?recursive=1.
	if resp, _ := e.do("alice", "DELETE", base+"SRC", nil); resp.StatusCode != 409 {
		t.Fatalf("delete non-empty dir: %d", resp.StatusCode)
	}
	if resp, _ := e.do("alice", "DELETE", base+"SRC?recursive=1", nil); resp.StatusCode != 204 {
		t.Fatalf("recursive delete: %d", resp.StatusCode)
	}
	if got, _ := e.store.GetBox(context.Background(), b.ID); got.UsedBytes != 0 {
		t.Fatalf("usage after delete %d", got.UsedBytes)
	}

	// With the box running, an upload triggers a rescan in it.
	e.do("alice", "POST", "/api/boxes/"+b.ID.String()+"/start", nil)
	resp, body = e.do("alice", "PUT", base+"NEW.TXT", strings.NewReader("hi"))
	if !strings.Contains(string(body), `"rescanned":true`) || <-e.calls != "POST /rescan" {
		t.Fatalf("rescan on upload: %s", body)
	}
}

func TestFileOps(t *testing.T) {
	e := newEnv(t)
	b := e.create("alice", "ops")
	base := "/api/boxes/" + b.ID.String() + "/files/"
	op := func(path, body string) int {
		resp, _ := e.do("alice", "POST", base+path, strings.NewReader(body))
		return resp.StatusCode
	}
	exists := func(rel string) bool { _, err := os.Stat(filepath.Join(e.srv.cDir(b.ID), filepath.FromSlash(rel))); return err == nil }

	if c := op("PROJ/SRC", `{"op":"mkdir"}`); c != 204 || !exists("PROJ/SRC") {
		t.Fatalf("mkdir with parents: %d", c)
	}
	if c := op("PROJ/SRC", `{"op":"mkdir"}`); c != 409 {
		t.Fatalf("mkdir over an existing folder: %d", c)
	}
	e.do("alice", "PUT", base+"PROJ/SRC/A.C", strings.NewReader("x"))
	e.do("alice", "PUT", base+"PROJ/B.C", strings.NewReader("y"))
	if c := op("PROJ/SRC/A.C", `{"op":"rename","to":"PROJ/SRC/MAIN.C"}`); c != 204 || !exists("PROJ/SRC/MAIN.C") || exists("PROJ/SRC/A.C") {
		t.Fatalf("rename a file: %d", c)
	}
	if c := op("PROJ/SRC/MAIN.C", `{"op":"rename","to":"PROJ/B.C"}`); c != 409 {
		t.Fatalf("rename over an existing file: %d", c)
	}
	if c := op("PROJ/SRC", `{"op":"rename","to":"PROJ/CODE"}`); c != 204 || !exists("PROJ/CODE/MAIN.C") {
		t.Fatalf("rename a folder: %d", c)
	}
	if c := op("PROJ", `{"op":"rename","to":"PROJ/CODE/INNER"}`); c != 400 {
		t.Fatalf("move a folder into itself: %d", c)
	}
	if c := op("NOPE.C", `{"op":"rename","to":"X.C"}`); c != 404 {
		t.Fatalf("rename a missing file: %d", c)
	}
	for _, bad := range []string{`{"op":"rename","to":"../escape"}`, `{"op":"rename","to":""}`, `{"op":"chmod"}`, `not json`} {
		if c := op("PROJ/B.C", bad); c != 400 {
			t.Errorf("%s: %d", bad, c)
		}
	}
	if resp, _ := e.do("bob", "POST", base+"PROJ/X", strings.NewReader(`{"op":"mkdir"}`)); resp.StatusCode != 404 || exists("PROJ/X") {
		t.Fatalf("bob makes folders in alice's box: %d", resp.StatusCode)
	}
}

func TestJanitor(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	now := time.Now()
	e.srv.now = func() time.Time { return now }
	idle := e.create("alice", "idle")
	full := e.create("bob", "full")
	e.do("alice", "POST", "/api/boxes/"+idle.ID.String()+"/start", nil)
	e.do("bob", "POST", "/api/boxes/"+full.ID.String()+"/start", nil)
	orphan := boxPod(e.srv.cfg, &Box{ID: uuid.New(), Owner: bob.Id}, 1)
	e.kube.CreatePod(ctx, orphan)

	// Bob's box goes over its allowance from inside DOS.
	os.WriteFile(filepath.Join(e.srv.cDir(full.ID), "HUGE.DAT"), make([]byte, 2<<20), 0o644)
	e.srv.Sweep(ctx)
	if _, ok := e.kube.pods[podName(full.ID)]; ok {
		t.Error("over-limit box still running")
	}
	if _, ok := e.kube.pods[orphan.Metadata.Name]; ok {
		t.Error("orphan pod kept")
	}
	if _, ok := e.kube.pods[podName(idle.ID)]; !ok {
		t.Fatal("fresh box stopped")
	}
	// Starting it again is refused while over the limit.
	if resp, _ := e.do("bob", "POST", "/api/boxes/"+full.ID.String()+"/start", nil); resp.StatusCode != 409 {
		t.Fatalf("start over limit: %d", resp.StatusCode)
	}
	_, body := e.do("bob", "GET", "/api/boxes/"+full.ID.String(), nil)
	if !strings.Contains(string(body), "C: uses 2 MB of 1 MB") {
		t.Fatalf("stop reason not shown: %s", body)
	}

	// A watched box is never idle; an unwatched one stops after 15 min.
	e.srv.mu.Lock()
	e.srv.viewers[idle.ID] = 1
	e.srv.mu.Unlock()
	now = now.Add(time.Hour)
	e.srv.Sweep(ctx)
	if _, ok := e.kube.pods[podName(idle.ID)]; !ok {
		t.Fatal("watched box stopped")
	}
	e.srv.mu.Lock()
	delete(e.srv.viewers, idle.ID)
	e.srv.mu.Unlock()
	e.srv.Sweep(ctx)
	if _, ok := e.kube.pods[podName(idle.ID)]; ok {
		t.Fatal("idle box kept running")
	}
	// Its folder stays.
	if _, err := os.Stat(e.srv.cDir(idle.ID)); err != nil {
		t.Fatal(err)
	}
}

func TestPodState(t *testing.T) {
	if st, _ := podState(nil); st != StateStopped {
		t.Fatal(st)
	}
	p := &Pod{}
	p.Status.Phase = "Pending"
	if st, _ := podState(p); st != StateStarting {
		t.Fatal(st)
	}
	p.Status.Phase = "Failed"
	if st, _ := podState(p); st != StateFailed {
		t.Fatal(st)
	}
	now := time.Now()
	p.Metadata.DeletionTimestamp = &now
	if st, _ := podState(p); st != StateStopping {
		t.Fatal(st)
	}
}

func TestSameOrigin(t *testing.T) {
	for _, tc := range []struct {
		host, origin string
		want         bool
	}{
		{"dosbox.pocket-maze.app", "", true}, // non-browser client
		{"dosbox.pocket-maze.app", "https://dosbox.pocket-maze.app", true},
		{"dosbox.pocket-maze.app", "https://DOSBOX.pocket-maze.app", true},
		{"dosbox.pocket-maze.app", "https://evil.example", false},
		{"dosbox.pocket-maze.app", "https://dunelegacy.pocket-maze.app", false},
		{"dosbox.pocket-maze.app", "null", false},
	} {
		r := httptest.NewRequest("GET", "/api/boxes/x/ws", nil)
		r.Host = tc.host
		if tc.origin != "" {
			r.Header.Set("Origin", tc.origin)
		}
		if got := sameOrigin(r); got != tc.want {
			t.Errorf("sameOrigin(host=%q, origin=%q) = %v, want %v", tc.host, tc.origin, got, tc.want)
		}
	}
}
