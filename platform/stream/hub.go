package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/jpeg"
	"log"
	"runtime"
	"sync"
	"time"
)

// Meta is sent to clients as a text message whenever the screen geometry
// or running program changes.
type Meta struct {
	Type    string `json:"type"`
	W       int    `json:"w"`
	H       int    `json:"h"`
	ParX    int    `json:"parX"`
	ParY    int    `json:"parY"`
	Program string `json:"program"`
}

// The screen goes out as horizontal strips of stripRows rows, each its own
// JPEG, and only strips that changed since the previous frame are encoded:
// a moving mouse cursor or a unit walking costs a strip or two, not a whole
// frame. The hub keeps the latest JPEG of every strip; each client keeps the
// set of strips it hasn't been sent since they last changed, so however many
// updates flow control makes it skip, it always ends up with the newest
// content of every strip.
//
// A binary message is one update:
//
//	"S" 1  count:u16  frameW:u16 frameH:u16  then count × (y:u16 h:u16 len:u32 jpeg[len])
//
// (little-endian). The frame size travels with it so a client never draws
// strips of a new mode onto a canvas of the old one.
const stripRows = 32

type client struct {
	meta   chan []byte
	notify chan struct{} // capacity 1: strips became dirty

	// Guarded by Hub.mu.
	dirty []bool
	gen   int

	// Text mode (text.go), for clients that said {"hello":{"text":1}}:
	// while the screen is in a text mode they get text updates, not strips.
	text      bool
	mode      byte // what the client last got: 0 nothing, 'S' strips, 'T' text
	txtGen    int
	txtRows   []bool
	needPal   bool
	needFont  bool
	needHdr   bool
}

// Hub polls Game Link for new frames and fans strip updates out to clients.
type Hub struct {
	gl      *Gamelink
	quality int
	minGap  time.Duration

	mu        sync.Mutex
	clients   map[*client]struct{}
	lastMeta  []byte
	gen       int // bumped when the frame size changes
	w, h      int
	strips    [][]byte // latest JPEG per strip
	frame     []byte   // the latest frame, BGRA (for /snapshot.jpg)
	frameSeq  uint64
	lastFrame time.Time
	snapSeq   uint64
	snapJPEG  []byte

	text   *TextMirror
	txt    *TextScreen // the current text screen; nil in graphics modes
	txtGen int         // bumped when the text geometry changes

	// For the player's latency meter: encode time of an update (EWMA) and
	// updates produced in the last second.
	encodeMs  float64
	fps       int
	fpsCount  int
	fpsWindow time.Time
}

func NewHub(gl *Gamelink, quality, fps int) *Hub {
	return &Hub{
		gl:      gl,
		quality: quality,
		minGap:  time.Second / time.Duration(fps),
		clients: map[*client]struct{}{},
	}
}

func (h *Hub) add() *client {
	c := &client{meta: make(chan []byte, 4), notify: make(chan struct{}, 1)}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	meta := h.lastMeta
	c.gen, c.dirty = h.gen, allTrue(len(h.strips)) // a new client needs everything
	h.mu.Unlock()
	if meta != nil {
		c.meta <- meta
	}
	c.notify <- struct{}{}
	return c
}

func (h *Hub) remove(c *client) {
	h.mu.Lock()
	delete(h.clients, c)
	h.mu.Unlock()
}

func (h *Hub) viewers() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

func allTrue(n int) []bool {
	b := make([]bool, n)
	for i := range b {
		b[i] = true
	}
	return b
}

// wantText records that c can draw text updates.
func (h *Hub) wantText(c *client) {
	h.mu.Lock()
	c.text = true
	h.mu.Unlock()
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

// take builds the next update for c: text in a text mode (for clients that
// draw text), else every strip c still needs; nil when it is up to date.
func (h *Hub) take(c *client) []byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c.text && h.txt != nil {
		return h.takeText(c)
	}
	if c.mode != 'S' { // back from text: the whole screen again
		c.mode, c.gen = 'S', -1
	}
	if c.gen != h.gen {
		c.gen, c.dirty = h.gen, allTrue(len(h.strips))
	}
	var body bytes.Buffer
	count := 0
	for i, d := range c.dirty {
		if !d || h.strips[i] == nil {
			continue
		}
		y := i * stripRows
		rows := min(stripRows, h.h-y)
		var hdr [8]byte
		binary.LittleEndian.PutUint16(hdr[0:], uint16(y))
		binary.LittleEndian.PutUint16(hdr[2:], uint16(rows))
		binary.LittleEndian.PutUint32(hdr[4:], uint32(len(h.strips[i])))
		body.Write(hdr[:])
		body.Write(h.strips[i])
		c.dirty[i] = false
		count++
	}
	if count == 0 {
		return nil
	}
	msg := make([]byte, 8, 8+body.Len())
	msg[0], msg[1] = 'S', 1
	binary.LittleEndian.PutUint16(msg[2:], uint16(count))
	binary.LittleEndian.PutUint16(msg[4:], uint16(h.w))
	binary.LittleEndian.PutUint16(msg[6:], uint16(h.h))
	return append(msg, body.Bytes()...)
}

func (h *Hub) takeText(c *client) []byte {
	t := h.txt
	if c.mode != 'T' || c.txtGen != h.txtGen {
		c.mode, c.txtGen = 'T', h.txtGen
		c.txtRows = allTrue(t.Rows)
		c.needPal, c.needFont, c.needHdr = true, true, true
	}
	var rows []int
	for r, d := range c.txtRows {
		if d {
			rows = append(rows, r)
			c.txtRows[r] = false
		}
	}
	if len(rows) == 0 && !c.needPal && !c.needFont && !c.needHdr {
		return nil
	}
	msg := encodeText(t, c.needPal, c.needFont, rows)
	c.needPal, c.needFont, c.needHdr = false, false, false
	return msg
}

// publishText takes a new text screen (nil: the screen left text mode) and
// marks what changed for text clients.
func (h *Hub) publishText(t *TextScreen) {
	h.mu.Lock()
	defer h.mu.Unlock()
	prev := h.txt
	if t == nil {
		if prev == nil {
			return
		}
		h.txt = nil
		h.notifyText()
		return
	}
	if !sameGeometry(t, prev) {
		h.txtGen++
	}
	h.txt = t
	rows := changedRows(t, prev)
	pal := prev == nil || prev.Palette != t.Palette
	font := prev == nil || prev.FontSeq != t.FontSeq || prev.CellH != t.CellH
	hdr := prev == nil || prev.CursorX != t.CursorX || prev.CursorY != t.CursorY || prev.Flags != t.Flags ||
		prev.CursorStart != t.CursorStart || prev.CursorEnd != t.CursorEnd || prev.Codepage != t.Codepage
	if len(rows) == 0 && !pal && !font && !hdr {
		return
	}
	for c := range h.clients {
		if !c.text || c.mode != 'T' || c.txtGen != h.txtGen {
			continue // takeText starts it over
		}
		for _, r := range rows {
			c.txtRows[r] = true
		}
		c.needPal = c.needPal || pal
		c.needFont = c.needFont || font
		c.needHdr = c.needHdr || hdr
	}
	h.notifyText()
}

func (h *Hub) notifyText() {
	for c := range h.clients {
		if c.text {
			select {
			case c.notify <- struct{}{}:
			default:
			}
		}
	}
}

// Screen returns the current text screen straight from the mirror (nil in
// graphics modes), for /screen.txt.
func (h *Hub) Screen() (*TextScreen, error) {
	if h.text == nil {
		return nil, errNoText
	}
	return h.text.Read()
}

// Latest returns the current frame as one JPEG (for /snapshot.jpg; encoded
// on demand) and when the newest frame arrived.
func (h *Hub) Latest() ([]byte, time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.frame == nil {
		return nil, h.lastFrame
	}
	if h.snapSeq != h.frameSeq || h.snapJPEG == nil {
		img := image.NewRGBA(image.Rect(0, 0, h.w, h.h))
		bgraToRGBA(img.Pix, h.frame)
		var buf bytes.Buffer
		if jpeg.Encode(&buf, img, &jpeg.Options{Quality: h.quality}) == nil {
			h.snapJPEG, h.snapSeq = buf.Bytes(), h.frameSeq
		}
	}
	return h.snapJPEG, h.lastFrame
}

func (h *Hub) Run() {
	var (
		lastSeq   uint16
		haveSeq   bool
		lastSent  time.Time
		lastMeta  Meta
		cur, prev []byte
		lastErr   string
		idleProbe time.Time
	)
	tick := time.NewTicker(2 * time.Millisecond)
	defer tick.Stop()
	for range tick.C {
		// With nobody watching, still read a frame every 2s so
		// /snapshot.jpg and /healthz stay meaningful.
		if h.viewers() == 0 {
			if time.Since(idleProbe) < 2*time.Second {
				continue
			}
			idleProbe = time.Now()
		}
		hdr, err := h.gl.Header()
		if err != nil {
			if err.Error() != lastErr {
				log.Printf("gamelink: %v", err)
				lastErr = err.Error()
			}
			continue
		}
		lastErr = ""
		if haveSeq && hdr.Seq == lastSeq || time.Since(lastSent) < h.minGap {
			continue
		}
		// Seq is bumped before DOSBox-X copies the pixels; give the
		// memcpy a moment to finish to avoid a torn frame.
		time.Sleep(time.Millisecond)
		if cur, err = h.gl.ReadPixels(hdr, cur); err != nil {
			log.Printf("gamelink read: %v", err)
			continue
		}
		lastSeq, haveSeq, lastSent = hdr.Seq, true, time.Now()

		if m := (Meta{"meta", hdr.W, hdr.H, hdr.ParX, hdr.ParY, hdr.Program}); m != lastMeta {
			if m.W != lastMeta.W || m.H != lastMeta.H {
				prev = nil // new geometry: every strip changed
			}
			lastMeta = m
			log.Printf("frame %v", hdr)
			b, _ := json.Marshal(m)
			h.broadcastMeta(b)
		}

		if h.text != nil {
			ts, _ := h.text.Read() // nil in graphics modes or without a mirror
			h.publishText(ts)
		}

		changed := changedStrips(cur, prev, hdr.W, hdr.H)
		var jpegs map[int][]byte
		if len(changed) > 0 {
			start := time.Now()
			jpegs = h.encodeStrips(cur, hdr.W, hdr.H, changed)
			h.noteUpdate(time.Since(start))
		}
		h.publish(hdr.W, hdr.H, cur, jpegs)
		cur, prev = prev, cur // keep this frame to diff the next against
	}
}

// changedStrips lists the strips that differ from prev (all of them when
// there is no previous frame of this size).
func changedStrips(cur, prev []byte, w, h int) []int {
	n := (h + stripRows - 1) / stripRows
	stride := w * 4
	var out []int
	for i := 0; i < n; i++ {
		y0, y1 := i*stripRows*stride, min((i+1)*stripRows, h)*stride
		if len(prev) != len(cur) || !bytes.Equal(cur[y0:y1], prev[y0:y1]) {
			out = append(out, i)
		}
	}
	return out
}

// encodeStrips JPEG-encodes the given strips in parallel.
func (h *Hub) encodeStrips(px []byte, w, hgt int, idx []int) map[int][]byte {
	out := make(map[int][]byte, len(idx))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, max(1, runtime.GOMAXPROCS(0)))
	stride := w * 4
	for _, i := range idx {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer func() { <-sem; wg.Done() }()
			y0 := i * stripRows
			rows := min(stripRows, hgt-y0)
			img := image.NewRGBA(image.Rect(0, 0, w, rows))
			bgraToRGBA(img.Pix, px[y0*stride:(y0+rows)*stride])
			var buf bytes.Buffer
			if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: h.quality}); err != nil {
				log.Printf("jpeg: %v", err)
				return
			}
			mu.Lock()
			out[i] = buf.Bytes()
			mu.Unlock()
		}(i)
	}
	wg.Wait()
	return out
}

// publish stores the frame and new strips and marks them dirty for every
// client.
func (h *Hub) publish(w, hgt int, px []byte, jpegs map[int][]byte) {
	n := (hgt + stripRows - 1) / stripRows
	h.mu.Lock()
	defer h.mu.Unlock()
	if w != h.w || hgt != h.h || len(h.strips) != n {
		h.w, h.h, h.strips = w, hgt, make([][]byte, n)
		h.gen++
	}
	h.frame = append(h.frame[:0], px...)
	h.frameSeq++
	h.lastFrame = time.Now()
	if len(jpegs) == 0 {
		return
	}
	for i, b := range jpegs {
		h.strips[i] = b
	}
	for c := range h.clients {
		if c.gen == h.gen { // else take() resets it to "everything"
			for i := range jpegs {
				c.dirty[i] = true
			}
		}
		select {
		case c.notify <- struct{}{}:
		default:
		}
	}
}

func (h *Hub) broadcastMeta(b []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastMeta = b
	for c := range h.clients {
		select {
		case c.meta <- b:
		default:
		}
	}
}

func bgraToRGBA(dst, src []byte) {
	for i := 0; i+3 < len(src); i += 4 {
		dst[i+0] = src[i+2]
		dst[i+1] = src[i+1]
		dst[i+2] = src[i+0]
		dst[i+3] = 0xff
	}
}

func (h *Hub) noteUpdate(enc time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	ms := float64(enc.Microseconds()) / 1000
	if h.encodeMs == 0 {
		h.encodeMs = ms
	} else {
		h.encodeMs += (ms - h.encodeMs) / 8
	}
	now := time.Now()
	if now.Sub(h.fpsWindow) >= time.Second {
		h.fps, h.fpsCount, h.fpsWindow = h.fpsCount, 0, now
	}
	h.fpsCount++
}

// Stats is what the player's latency meter shows besides its own round trip.
func (h *Hub) Stats() (encodeMs float64, fps int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if time.Since(h.fpsWindow) > 2*time.Second {
		return h.encodeMs, 0 // nothing changed lately: a still screen
	}
	return h.encodeMs, h.fps
}
