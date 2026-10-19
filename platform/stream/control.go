package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Control is the HTTP API for agents and scripts: typing, key combos,
// mouse, lossless snapshots and the box's C: drive.
type Control struct {
	gl        *Gamelink
	in        *InputWriter
	text      *TextMirror // the text screen (run.go reads a command's output from it)
	con       *ConStream  // the console stream (what DOS writes to CON; run.go)
	dataDir   string      // host directory mounted as C: (/data/c)
	maxUpload int64

	mu sync.Mutex // one input sequence at a time, so two /type calls don't interleave
}

func (c *Control) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /type", c.handleType)
	mux.HandleFunc("POST /run", c.handleRun)
	mux.HandleFunc("POST /keys", c.handleKeys)
	mux.HandleFunc("POST /mouse", c.handleMouse)
	mux.HandleFunc("POST /click", c.handleMouse)
	mux.HandleFunc("GET /snapshot.png", c.handleSnapshotPNG)
	mux.HandleFunc("POST /rescan", c.handleRescan)
	mux.HandleFunc("GET /files", c.handleFileGet)
	mux.HandleFunc("GET /files/{path...}", c.handleFileGet)
	mux.HandleFunc("PUT /files/{path...}", c.handleFilePut)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func httpErr(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]string{"error": err.Error()})
}

// decode reads a JSON body into v (an empty body leaves v as is).
func decode(r *http.Request, v any) error {
	b, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return nil
	}
	return json.Unmarshal(b, v)
}

// deliver queues events and waits until DOSBox-X has them. A cancelled
// request still gets its trailing releases delivered (see releaseAll).
func (c *Control) deliver(ctx context.Context, evs ...InputEvent) error {
	return c.in.SendWait(ctx, evs...)
}

func (c *Control) releaseAll(keys []int) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var evs []InputEvent
	for i := len(keys) - 1; i >= 0; i-- {
		evs = append(evs, release(keys[i]))
	}
	c.in.SendWait(ctx, evs...)
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// BIOS data area: keyboard flags and the type-ahead ring buffer.
const (
	bdaKbdFlags = 0x417 // bit 6 = Caps Lock on
	bdaKbdHead  = 0x41A
	bdaKbdTail  = 0x41C
	bdaKbdStart = 0x480
	bdaKbdEnd   = 0x482
)

// kbdBuffer returns how many keys wait in the BIOS type-ahead buffer, its
// capacity and the Caps Lock state.
func (c *Control) kbdBuffer() (used, size int, caps bool, err error) {
	b, err := c.gl.ReadRAM(0x400, 0x84)
	if err != nil {
		return 0, 0, false, err
	}
	u16 := func(a int) int { return int(binary.LittleEndian.Uint16(b[a-0x400:])) }
	start, end := u16(bdaKbdStart), u16(bdaKbdEnd)
	if start == 0 || end <= start {
		start, end = 0x1E, 0x3E
	}
	size = (end - start) / 2
	used = ((u16(bdaKbdTail) - u16(bdaKbdHead)) / 2) % size
	if used < 0 {
		used += size
	}
	return used, size, b[bdaKbdFlags-0x400]&0x40 != 0, nil
}

type typeReq struct {
	Text   string `json:"text"`
	HoldMS *int   `json:"hold_ms"` // how long each key is held down (default 20)
	GapMS  *int   `json:"gap_ms"`  // pause after each key release (default 10)
}

func msOr(p *int, def int) time.Duration {
	if p != nil && *p >= 0 {
		return time.Duration(*p) * time.Millisecond
	}
	return time.Duration(def) * time.Millisecond
}

// POST /type {"text": "...", "hold_ms": 20, "gap_ms": 10}, or a non-JSON
// body taken as the text itself. Types US-layout ASCII (\n = Enter, \t =
// Tab, \b = Backspace) and returns when every key has reached DOSBox-X.
//
// Keys are held and spaced like a (fast) person types: programs that
// sample key state from their own INT 9 handler (Turbo C++'s IDE) miss
// a press released ~1 ms later and repeat the previous character instead.
// Characters are also paced so the BIOS type-ahead buffer (15 keys) never
// overflows; if the running program doesn't drain it (it reads the
// keyboard itself), that pacing is dropped for the rest of the request.
func (c *Control) handleType(w http.ResponseWriter, r *http.Request) {
	var req typeReq
	if strings.Contains(r.Header.Get("Content-Type"), "json") {
		if err := decode(r, &req); err != nil {
			httpErr(w, http.StatusBadRequest, err)
			return
		}
	} else {
		b, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			httpErr(w, http.StatusBadRequest, err)
			return
		}
		req.Text = string(b)
	}
	chars, err := TextChars(req.Text)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	hold, gap := msOr(req.HoldMS, 20), msOr(req.GapMS, 10)
	c.mu.Lock()
	defer c.mu.Unlock()

	start := time.Now()
	typed, flow, err := c.typeChars(r.Context(), chars, hold, gap)
	if err != nil {
		log.Printf("type: cancelled after %d chars", typed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"typed": typed, "ms": time.Since(start).Milliseconds(), "paced": flow,
	})
}

// typeChars types chars with the pacing described at handleType; the
// caller holds c.mu. Returns how many characters went in and whether the
// keyboard-buffer pacing stayed on. On a cancelled context the keys held
// at that moment are released.
func (c *Control) typeChars(ctx context.Context, chars []rune, hold, gap time.Duration) (int, bool, error) {
	flow := true
	for i, ch := range chars {
		used, size, caps, err := c.kbdBuffer()
		for waitStart := time.Now(); flow && err == nil && used > size/2; used, size, caps, err = c.kbdBuffer() {
			if time.Since(waitStart) > 2*time.Second {
				log.Printf("type: BIOS keyboard buffer not draining (%d/%d), pacing off", used, size)
				flow = false
				break
			}
			if err := sleepCtx(ctx, 5*time.Millisecond); err != nil {
				return i, flow, err
			}
		}
		evs, _ := CharEvents(ch, caps)
		for _, ev := range evs {
			pause := gap
			if ev.Down {
				pause = hold
			}
			err := c.deliver(ctx, ev)
			if err == nil {
				err = sleepCtx(ctx, pause)
			}
			if err != nil {
				c.releaseAll([]int{scLShift, ev.Key})
				return i, flow, err
			}
		}
	}
	return len(chars), flow, nil
}

type keysReq struct {
	Combo  string `json:"combo"`   // "ctrl+f9", or several: "ctrl+k ctrl+b enter"
	HoldMS *int   `json:"hold_ms"` // how long each combo is held (default 50)
	Action string `json:"action"`  // "press" (default), "down" or "up"
}

// POST /keys {"combo": "ctrl+f9", "hold_ms": 50, "action": "press"}
func (c *Control) handleKeys(w http.ResponseWriter, r *http.Request) {
	var req keysReq
	if err := decode(r, &req); err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	combos, err := ParseKeys(req.Combo)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	hold := 50 * time.Millisecond
	if req.HoldMS != nil {
		hold = time.Duration(*req.HoldMS) * time.Millisecond
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	ctx := r.Context()
	for i, keys := range combos {
		switch req.Action {
		case "down":
			var evs []InputEvent
			for _, k := range keys {
				evs = append(evs, press(k))
			}
			err = c.deliver(ctx, evs...)
		case "up":
			c.releaseAll(keys)
		case "", "press":
			var evs []InputEvent
			for _, k := range keys {
				evs = append(evs, press(k))
			}
			err = c.deliver(ctx, evs...)
			if err == nil {
				err = sleepCtx(ctx, hold)
			}
			c.releaseAll(keys)
			if err == nil && i < len(combos)-1 {
				err = sleepCtx(ctx, hold)
			}
		default:
			httpErr(w, http.StatusBadRequest, fmt.Errorf("action must be press, down or up"))
			return
		}
		if err != nil {
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"combos": len(combos)})
}

type mouseReq struct {
	DX      float32 `json:"dx"`
	DY      float32 `json:"dy"`
	Buttons *int    `json:"buttons"` // set the button mask (bit0 L, bit1 R, bit2 M)
	Click   string  `json:"click"`   // "left", "right" or "middle"
	Double  bool    `json:"double"`
	HoldMS  *int    `json:"hold_ms"` // button down time for clicks (default 50)
}

var buttonBits = map[string]int{"left": 1, "l": 1, "right": 2, "r": 2, "middle": 4, "m": 4}

// POST /mouse {"dx": 10, "dy": -5, "buttons": 1, "click": "left", "double": false}
// POST /click is the same with "click" defaulting to "left".
// Motion is relative (mickeys, like the browser's captured mouse); it is
// applied first, then "buttons", then the click.
func (c *Control) handleMouse(w http.ResponseWriter, r *http.Request) {
	var req mouseReq
	if err := decode(r, &req); err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	if req.Click == "" && r.URL.Path == "/click" {
		req.Click = "left"
	}
	bit, ok := buttonBits[strings.ToLower(req.Click)]
	if req.Click != "" && !ok {
		httpErr(w, http.StatusBadRequest, fmt.Errorf("click must be left, right or middle"))
		return
	}
	hold := 50 * time.Millisecond
	if req.HoldMS != nil {
		hold = time.Duration(*req.HoldMS) * time.Millisecond
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	ctx := r.Context()
	if req.DX != 0 || req.DY != 0 {
		if err := c.deliver(ctx, InputEvent{Key: -1, DX: req.DX, DY: req.DY, Buttons: -1}); err != nil {
			return
		}
	}
	base := 0
	if req.Buttons != nil {
		base = *req.Buttons & 7
		if err := c.deliver(ctx, InputEvent{Key: -1, Buttons: base}); err != nil {
			return
		}
	}
	clicks := 0
	if bit != 0 {
		clicks = 1
		if req.Double {
			clicks = 2
		}
	}
	for i := 0; i < clicks; i++ {
		// Hold the button so programs polling INT 33h see it pressed.
		err := c.deliver(ctx, InputEvent{Key: -1, Buttons: base | bit})
		if err == nil {
			err = sleepCtx(ctx, hold)
		}
		c.deliver(context.Background(), InputEvent{Key: -1, Buttons: base &^ bit})
		if err == nil && i < clicks-1 {
			err = sleepCtx(ctx, hold)
		}
		if err != nil {
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// GET /snapshot.png: the current Game Link frame, lossless.
func (c *Control) handleSnapshotPNG(w http.ResponseWriter, r *http.Request) {
	hdr, err := c.gl.Header()
	if err != nil {
		httpErr(w, http.StatusServiceUnavailable, err)
		return
	}
	px, err := c.gl.ReadPixels(hdr, nil)
	if err != nil {
		httpErr(w, http.StatusServiceUnavailable, err)
		return
	}
	img := image.NewRGBA(image.Rect(0, 0, hdr.W, hdr.H))
	bgraToRGBA(img.Pix, px)
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Frame-Seq", strconv.Itoa(int(hdr.Seq)))
	w.Header().Set("X-Frame-Par", fmt.Sprintf("%d:%d", hdr.ParX, hdr.ParY))
	w.Header().Set("X-Program", hdr.Program)
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	enc.Encode(w, img)
}

func (c *Control) rescan() error { return c.gl.Command(":rescan", 2*time.Second) }

// POST /rescan: make DOS re-read every drive's directories (DOSBox-X
// "Rescan all drives"), e.g. after changing /data/c behind its back.
func (c *Control) handleRescan(w http.ResponseWriter, r *http.Request) {
	if err := c.rescan(); err != nil {
		httpErr(w, http.StatusServiceUnavailable, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rescanned": true})
}

// hostPath maps a /files/ path onto dataDir, refusing anything that would
// leave it.
func (c *Control) hostPath(p string) (string, error) {
	p = strings.Trim(strings.ReplaceAll(p, "\\", "/"), "/")
	if p == "" {
		return c.dataDir, nil
	}
	if !filepath.IsLocal(filepath.FromSlash(p)) {
		return "", fmt.Errorf("bad path %q", p)
	}
	return filepath.Join(c.dataDir, filepath.FromSlash(p)), nil
}

// dos83 reports whether name is a plain DOS 8.3 file name; others still
// work but DOS sees a mangled short name (e.g. LONGFI~1.TXT).
func dos83(name string) bool {
	base, ext, _ := strings.Cut(name, ".")
	if base == "" || len(base) > 8 || len(ext) > 3 || strings.Contains(ext, ".") {
		return false
	}
	for _, r := range base + ext {
		if r > 0x7E || r <= ' ' || strings.ContainsRune(`"*+,/:;<=>?[\]|`, r) {
			return false
		}
	}
	return true
}

type fileEntry struct {
	Name  string    `json:"name"`
	Size  int64     `json:"size"`
	Dir   bool      `json:"dir"`
	MTime time.Time `json:"mtime"`
}

// GET /files/<path>: a JSON listing for a directory, the contents for a file.
func (c *Control) handleFileGet(w http.ResponseWriter, r *http.Request) {
	hp, err := c.hostPath(r.PathValue("path"))
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	st, err := os.Stat(hp)
	if errors.Is(err, fs.ErrNotExist) {
		httpErr(w, http.StatusNotFound, err)
		return
	} else if err != nil {
		httpErr(w, http.StatusInternalServerError, err)
		return
	}
	if !st.IsDir() {
		f, err := os.Open(hp)
		if err != nil {
			httpErr(w, http.StatusInternalServerError, err)
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeContent(w, r, st.Name(), st.ModTime(), f)
		return
	}
	des, err := os.ReadDir(hp)
	if err != nil {
		httpErr(w, http.StatusInternalServerError, err)
		return
	}
	list := []fileEntry{}
	for _, de := range des {
		info, err := de.Info()
		if err != nil {
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

// PUT /files/<path>[?rescan=0]: write the body to C:\<path> (parent
// directories are created), then rescan so DOS sees it.
func (c *Control) handleFilePut(w http.ResponseWriter, r *http.Request) {
	rel := strings.Trim(strings.ReplaceAll(r.PathValue("path"), "\\", "/"), "/")
	hp, err := c.hostPath(rel)
	if err != nil || hp == c.dataDir {
		httpErr(w, http.StatusBadRequest, fmt.Errorf("bad path %q", rel))
		return
	}
	if err := os.MkdirAll(filepath.Dir(hp), 0o755); err != nil {
		httpErr(w, http.StatusInternalServerError, err)
		return
	}
	_, statErr := os.Stat(hp)
	created := errors.Is(statErr, fs.ErrNotExist)

	// Write next to the target and rename, so DOS never sees half a file.
	tmp, err := os.CreateTemp(filepath.Dir(hp), ".upload-*")
	if err != nil {
		httpErr(w, http.StatusInternalServerError, err)
		return
	}
	n, err := io.Copy(tmp, http.MaxBytesReader(w, r.Body, c.maxUpload))
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
		code := http.StatusInternalServerError
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			code = http.StatusRequestEntityTooLarge
		}
		httpErr(w, code, err)
		return
	}

	resp := map[string]any{"path": rel, "size": n, "rescanned": false}
	allDOS := true
	for _, part := range strings.Split(rel, "/") {
		allDOS = allDOS && dos83(part)
	}
	if !allDOS {
		resp["warning"] = "not an 8.3 name: DOS sees a mangled short name"
	}
	if r.URL.Query().Get("rescan") != "0" {
		if err := c.rescan(); err != nil {
			resp["rescan_error"] = err.Error()
		} else {
			resp["rescanned"] = true
		}
	}
	code := http.StatusOK
	if created {
		code = http.StatusCreated
	}
	writeJSON(w, code, resp)
}
