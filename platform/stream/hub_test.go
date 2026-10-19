package main

import (
	"encoding/binary"
	"testing"
)

// parseUpdate decodes a strip update into y -> jpeg length.
func parseUpdate(t *testing.T, msg []byte) (w, h int, strips map[int]int) {
	t.Helper()
	if len(msg) < 8 || msg[0] != 'S' || msg[1] != 1 {
		t.Fatalf("bad header % x", msg[:min(8, len(msg))])
	}
	n := int(binary.LittleEndian.Uint16(msg[2:]))
	w, h = int(binary.LittleEndian.Uint16(msg[4:])), int(binary.LittleEndian.Uint16(msg[6:]))
	strips = map[int]int{}
	p := 8
	for i := 0; i < n; i++ {
		y := int(binary.LittleEndian.Uint16(msg[p:]))
		l := int(binary.LittleEndian.Uint32(msg[p+4:]))
		strips[y] = l
		p += 8 + l
	}
	if p != len(msg) {
		t.Fatalf("trailing bytes: %d of %d", p, len(msg))
	}
	return
}

func frameOf(w, h int, fill func(x, y int) byte) []byte {
	px := make([]byte, w*h*4)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			v := fill(x, y)
			i := (y*w + x) * 4
			px[i], px[i+1], px[i+2], px[i+3] = v, v, v, 0xff
		}
	}
	return px
}

func TestStripUpdates(t *testing.T) {
	h := NewHub(nil, 75, 60)
	const W, H = 64, 100 // 4 strips: 32+32+32+4 rows
	push := func(prev, cur []byte) {
		changed := changedStrips(cur, prev, W, H)
		h.publish(W, H, cur, h.encodeStrips(cur, W, H, changed))
	}

	c := h.add()
	f1 := frameOf(W, H, func(x, y int) byte { return byte(x + y) })
	push(nil, f1)
	w, hh, s := parseUpdate(t, h.take(c))
	if w != W || hh != H || len(s) != 4 {
		t.Fatalf("first update: %dx%d strips %v", w, hh, s)
	}
	if h.take(c) != nil {
		t.Fatal("nothing changed, but an update came")
	}

	// Only rows 40..41 change: one strip (y=32).
	f2 := append([]byte(nil), f1...)
	for i := 40 * W * 4; i < 42*W*4; i++ {
		f2[i] ^= 0xff
	}
	push(f1, f2)
	if _, _, s := parseUpdate(t, h.take(c)); len(s) != 1 || s[32] == 0 {
		t.Fatalf("one changed strip, got %v", s)
	}

	// The client skips two updates (window full); then it gets the union,
	// each strip once, with its newest content.
	f3 := append([]byte(nil), f2...)
	f3[0] ^= 0xff // strip y=0
	push(f2, f3)
	f4 := append([]byte(nil), f3...)
	f4[0] ^= 0x0f             // strip y=0 again
	f4[99*W*4] ^= 0xff        // strip y=96
	push(f3, f4)
	if _, _, s := parseUpdate(t, h.take(c)); len(s) != 2 || s[0] == 0 || s[96] == 0 {
		t.Fatalf("merged update, got %v", s)
	}

	// A late joiner gets the whole screen.
	c2 := h.add()
	if _, _, s := parseUpdate(t, h.take(c2)); len(s) != 4 {
		t.Fatalf("new client, got %v", s)
	}

	// A new screen size: everything again, with the new size.
	g := frameOf(32, 40, func(x, y int) byte { return 7 })
	h.publish(32, 40, g, h.encodeStrips(g, 32, 40, changedStrips(g, nil, 32, 40)))
	if w, hh, s := parseUpdate(t, h.take(c)); w != 32 || hh != 40 || len(s) != 2 {
		t.Fatalf("after resize: %dx%d %v", w, hh, s)
	}
}
