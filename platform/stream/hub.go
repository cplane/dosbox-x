package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/jpeg"
	"log"
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

type client struct {
	frames chan []byte // capacity 1: always the latest JPEG
	meta   chan []byte
}

// Hub polls Game Link for new frames and fans JPEGs out to clients.
type Hub struct {
	gl      *Gamelink
	quality int
	minGap  time.Duration

	mu        sync.Mutex
	clients   map[*client]struct{}
	lastMeta  []byte
	lastJPEG  []byte
	lastFrame time.Time
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
	c := &client{frames: make(chan []byte, 1), meta: make(chan []byte, 4)}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	meta, jpg := h.lastMeta, h.lastJPEG
	h.mu.Unlock()
	if meta != nil {
		c.meta <- meta
	}
	if jpg != nil {
		c.frames <- jpg
	}
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

// Latest returns the most recent JPEG and when it was produced.
func (h *Hub) Latest() ([]byte, time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.lastJPEG, h.lastFrame
}

func (h *Hub) Run() {
	var (
		lastSeq   uint16
		haveSeq   bool
		lastSent  time.Time
		lastMeta  Meta
		pixels    []byte
		img       *image.RGBA
		lastErr   string
		idleProbe time.Time
	)
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for range tick.C {
		// With nobody watching, still produce a frame every 2s so
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
		if pixels, err = h.gl.ReadPixels(hdr, pixels); err != nil {
			log.Printf("gamelink read: %v", err)
			continue
		}
		lastSeq, haveSeq, lastSent = hdr.Seq, true, time.Now()

		if m := (Meta{"meta", hdr.W, hdr.H, hdr.ParX, hdr.ParY, hdr.Program}); m != lastMeta {
			lastMeta = m
			log.Printf("frame %v", hdr)
			b, _ := json.Marshal(m)
			h.broadcastMeta(b)
		}

		if img == nil || img.Rect.Dx() != hdr.W || img.Rect.Dy() != hdr.H {
			img = image.NewRGBA(image.Rect(0, 0, hdr.W, hdr.H))
		}
		bgraToRGBA(img.Pix, pixels)
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: h.quality}); err != nil {
			log.Printf("jpeg: %v", err)
			continue
		}
		h.broadcastFrame(buf.Bytes())
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

func (h *Hub) broadcastFrame(b []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastJPEG, h.lastFrame = b, time.Now()
	for c := range h.clients {
		select {
		case <-c.frames: // drop the stale frame the client hasn't sent yet
		default:
		}
		c.frames <- b
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
