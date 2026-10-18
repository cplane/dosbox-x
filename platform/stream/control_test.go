package main

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const guestRAM = 16 << 20 // memsize = 16 in docker/dosbox-x.conf

func TestCoreSize(t *testing.T) {
	// The running pod's shm is the core block plus 16 MiB of guest RAM.
	if shmSize-coreSize != guestRAM {
		t.Fatalf("coreSize %d leaves %d bytes of RAM", coreSize, shmSize-coreSize)
	}
}

// fakeDOSBox emulates DOSBox-X's side of the input and command buffers:
// it records every published key bitmap and acknowledges commands.
type fakeDOSBox struct {
	f        *os.File
	stop     chan struct{}
	done     chan struct{}
	states   [][8]uint32
	commands []string
}

func startFake(t *testing.T, f *os.File) *fakeDOSBox {
	d := &fakeDOSBox{f: f, stop: make(chan struct{}), done: make(chan struct{})}
	var sz [4]byte
	binary.LittleEndian.PutUint32(sz[:], guestRAM)
	f.WriteAt(sz[:], offRAMSize)
	go func() {
		defer close(d.done)
		for {
			select {
			case <-d.stop:
				return
			default:
			}
			var b [42]byte
			f.ReadAt(b[:], offInput)
			if b[8] == 1 {
				var s [8]uint32
				for i := range s {
					s[i] = binary.LittleEndian.Uint32(b[10+4*i:])
				}
				if len(d.states) == 0 || d.states[len(d.states)-1] != s {
					d.states = append(d.states, s)
				}
				f.WriteAt([]byte{0}, offInputReady)
			}
			var p [2]byte
			f.ReadAt(p[:], offBufRecv)
			if n := binary.LittleEndian.Uint16(p[:]); n != 0 {
				c := make([]byte, n)
				f.ReadAt(c, offBufRecv+2)
				d.commands = append(d.commands, string(c))
				f.WriteAt([]byte{0, 0}, offBufRecv)
			}
			time.Sleep(200 * time.Microsecond)
		}
	}()
	t.Cleanup(d.close)
	return d
}

func (d *fakeDOSBox) close() {
	select {
	case <-d.stop:
	default:
		close(d.stop)
		<-d.done
	}
}

// transitions turns the recorded bitmaps into "+1E"/"-1E" key changes.
func (d *fakeDOSBox) transitions() []string {
	var out []string
	var prev [8]uint32
	for _, s := range d.states {
		for k := 0; k < 256; k++ {
			was, is := prev[k/32]>>(k%32)&1, s[k/32]>>(k%32)&1
			if is == 1 && was == 0 {
				out = append(out, "+"+hex2(k))
			} else if is == 0 && was == 1 {
				out = append(out, "-"+hex2(k))
			}
		}
		prev = s
	}
	return out
}

func newTestControl(t *testing.T) (*Control, *fakeDOSBox, *os.File) {
	p, f := fakeShm(t)
	gl := NewGamelink(p)
	t.Cleanup(gl.Close)
	in := NewInputWriter(gl)
	go in.Run()
	d := startFake(t, f)
	return &Control{gl: gl, in: in, dataDir: t.TempDir(), maxUpload: 1 << 20}, d, f
}

func serve(c *Control) *httptest.Server {
	mux := http.NewServeMux()
	c.Register(mux)
	return httptest.NewServer(mux)
}

func TestTypeEndToEnd(t *testing.T) {
	c, d, _ := newTestControl(t)
	srv := serve(c)
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/type", "application/json", strings.NewReader(`{"text":"Hi>\n"}`))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	d.close()
	want := []string{"+2A", "+23", "-23", "-2A", "+17", "-17", "+2A", "+34", "-34", "-2A", "+1C", "-1C"}
	if got := d.transitions(); !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %v\nwant %v", got, want)
	}

	// Plain-text body, and a 400 before any input for untypeable text.
	resp, _ = http.Post(srv.URL+"/type", "text/plain", strings.NewReader("ü"))
	if resp.StatusCode != 400 {
		t.Fatalf("non-ASCII: %d", resp.StatusCode)
	}
}

func TestKeysEndToEnd(t *testing.T) {
	c, d, _ := newTestControl(t)
	srv := serve(c)
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/keys", "application/json", strings.NewReader(`{"combo":"ctrl+f9","hold_ms":0}`))
	if err != nil || resp.StatusCode != 200 {
		t.Fatal(err, resp.StatusCode)
	}
	d.close()
	// Modifiers go down first and come up last.
	got := d.transitions()
	want := []string{"+1D", "+43", "-43", "-1D"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestKbdBuffer(t *testing.T) {
	c, d, f := newTestControl(t)
	d.close()
	bda := make([]byte, 0x84)
	binary.LittleEndian.PutUint16(bda[bdaKbdHead-0x400:], 0x3A)
	binary.LittleEndian.PutUint16(bda[bdaKbdTail-0x400:], 0x22) // wrapped: 0x3A..0x3E, 0x1E..0x22
	binary.LittleEndian.PutUint16(bda[bdaKbdStart-0x400:], 0x1E)
	binary.LittleEndian.PutUint16(bda[bdaKbdEnd-0x400:], 0x3E)
	bda[bdaKbdFlags-0x400] = 0x40
	f.WriteAt(bda, coreSize+0x400)
	used, size, caps, err := c.kbdBuffer()
	if err != nil || used != 4 || size != 16 || !caps {
		t.Fatalf("used=%d size=%d caps=%v err=%v", used, size, caps, err)
	}
	if _, err := c.gl.ReadRAM(guestRAM-1, 2); err == nil {
		t.Fatal("read past RAM accepted")
	}
}

func TestFilesPutGetRescan(t *testing.T) {
	c, d, _ := newTestControl(t)
	srv := serve(c)
	defer srv.Close()
	put := func(path, body string) (*http.Response, map[string]any) {
		req, _ := http.NewRequest("PUT", srv.URL+"/files/"+path, strings.NewReader(body))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		json.NewDecoder(resp.Body).Decode(&m)
		return resp, m
	}
	resp, m := put("SRC/HELLO.C", "main(){}\r\n")
	if resp.StatusCode != 201 || m["rescanned"] != true || m["warning"] != nil {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
	if b, _ := os.ReadFile(filepath.Join(c.dataDir, "SRC", "HELLO.C")); string(b) != "main(){}\r\n" {
		t.Fatalf("content %q", b)
	}
	resp, m = put("SRC/HELLO.C?rescan=0", "x")
	if resp.StatusCode != 200 || m["rescanned"] != false {
		t.Fatalf("replace: %d %v", resp.StatusCode, m)
	}
	if _, m = put("longfilename.txt", "x"); m["warning"] == nil {
		t.Fatal("no 8.3 warning")
	}
	for _, bad := range []string{"..%2Fescape", "SRC/../../escape"} {
		if resp, _ := put(bad, "x"); resp.StatusCode != 400 && resp.StatusCode != 404 {
			t.Errorf("%s: %d", bad, resp.StatusCode)
		}
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(c.dataDir), "escape")); err == nil {
		t.Fatal("wrote outside the data dir")
	}

	resp, err := http.Get(srv.URL + "/files/SRC")
	if err != nil {
		t.Fatal(err)
	}
	var list []fileEntry
	json.NewDecoder(resp.Body).Decode(&list)
	if len(list) != 1 || list[0].Name != "HELLO.C" || list[0].Size != 1 {
		t.Fatalf("listing %+v", list)
	}
	resp, _ = http.Get(srv.URL + "/files/SRC/HELLO.C")
	if b, _ := io.ReadAll(resp.Body); string(b) != "x" {
		t.Fatalf("get %q", b)
	}
	d.close()
	if !reflect.DeepEqual(d.commands, []string{":rescan", ":rescan"}) {
		t.Fatalf("commands %v", d.commands)
	}
}
