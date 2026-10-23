package main

import (
	"bytes"
	"compress/flate"
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// A fake mirror block: the header, every page mirrored, the megabyte.
func writeMemBlock(t *testing.T, path string, mem []byte, seq uint64) {
	t.Helper()
	b := make([]byte, memOffData+memSize)
	binary.LittleEndian.PutUint32(b[0:], memMagic)
	binary.LittleEndian.PutUint16(b[4:], 1)
	binary.LittleEndian.PutUint16(b[6:], 12)
	binary.LittleEndian.PutUint32(b[8:], memSize)
	binary.LittleEndian.PutUint64(b[memOffSeq:], seq)
	for i := 0; i < memTiles/8; i++ {
		b[memOffMirror+i] = 0xff
	}
	copy(b[memOffData:], mem)
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

// decode reads a memory message: its flags and tile -> bytes.
func decodeMem(t *testing.T, msg []byte) (byte, map[int][]byte) {
	t.Helper()
	if len(msg) < 5 || msg[0] != 'M' || msg[1] != 1 {
		t.Fatalf("not a memory message: % x", msg[:min(len(msg), 8)])
	}
	flags, n := msg[2], int(binary.LittleEndian.Uint16(msg[3:]))
	body := msg[5:]
	if flags&1 != 0 {
		var err error
		if body, err = io.ReadAll(flate.NewReader(bytes.NewReader(body))); err != nil {
			t.Fatal(err)
		}
	}
	out := map[int][]byte{}
	for i := 0; i < n; i++ {
		e := body[i*(3+memTile):]
		if e[2] != 1 {
			t.Fatalf("tile %d not marked mirrored", binary.LittleEndian.Uint16(e))
		}
		out[int(binary.LittleEndian.Uint16(e))] = e[3 : 3+memTile]
	}
	return flags, out
}

func memTick(p *MemPump) {
	watchers := p.hub.memWatchers()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.open() != nil {
		for _, c := range watchers {
			p.hub.memUnavailable(c)
		}
		return
	}
	p.setEnabled(true)
	if p.read() {
		p.absorb()
	}
	for _, c := range watchers {
		if msg := p.frameFor(c); msg != nil {
			p.hub.sendMem(c, msg)
		}
	}
}

func TestMemTiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mem")
	mem := make([]byte, memSize)
	mem[0x0400] = 0x11 // tile 0
	mem[0xB8000] = 'A' // tile 0xB8
	writeMemBlock(t, path, mem, 2)

	h := NewHub(nil, 75, 60)
	c := h.add()
	p := NewMemPump(h, path)
	t.Cleanup(func() { p.mu.Lock(); p.close(); p.mu.Unlock() }) // Windows keeps an open file
	h.setMem(c, []uint16{0xB8, 0})

	memTick(p)
	msg := <-c.memOut
	_, tiles := decodeMem(t, msg)
	if len(tiles) != 2 || tiles[0xB8][0] != 'A' || tiles[0][0x400] != 0x11 {
		t.Fatalf("first tick: tiles %v", len(tiles))
	}
	// The emulator was told someone watches.
	b, _ := os.ReadFile(path)
	if binary.LittleEndian.Uint32(b[memOffEnabled:]) != 1 {
		t.Fatal("mirror not enabled")
	}

	// Nothing changed: nothing sent.
	memTick(p)
	select {
	case m := <-c.memOut:
		t.Fatalf("unchanged tick sent %d bytes", len(m))
	default:
	}

	// The screen changes: only its tile comes again.
	mem[0xB8002] = 'B'
	writeMemBlock(t, path, mem, 4)
	memTick(p)
	_, tiles = decodeMem(t, <-c.memOut)
	if len(tiles) != 1 || tiles[0xB8][2] != 'B' {
		t.Fatalf("changed tick: %d tiles", len(tiles))
	}

	// A copy in progress (odd seq) is not taken.
	mem[0xB8004] = 'C'
	writeMemBlock(t, path, mem, 5)
	memTick(p)
	select {
	case m := <-c.memOut:
		t.Fatalf("a torn copy was sent (%d bytes)", len(m))
	default:
	}
}

func TestMemBudget(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mem")
	writeMemBlock(t, path, make([]byte, memSize), 2)
	h := NewHub(nil, 75, 60)
	c := h.add()
	p := NewMemPump(h, path)
	t.Cleanup(func() { p.mu.Lock(); p.close(); p.mu.Unlock() }) // Windows keeps an open file
	all := make([]uint16, memTiles)
	for i := range all {
		all[i] = uint16(i)
	}
	h.setMem(c, all)
	got := map[int]bool{}
	for i := 0; i < memTiles/memBudget; i++ {
		memTick(p)
		_, tiles := decodeMem(t, <-c.memOut)
		if len(tiles) > memBudget {
			t.Fatalf("tick %d: %d tiles over the budget", i, len(tiles))
		}
		for k := range tiles {
			got[k] = true
		}
	}
	if len(got) != memTiles {
		t.Fatalf("the whole megabyte took more than %d ticks: %d tiles", memTiles/memBudget, len(got))
	}
}

func TestMemUnavailable(t *testing.T) {
	h := NewHub(nil, 75, 60)
	c := h.add()
	p := NewMemPump(h, filepath.Join(t.TempDir(), "missing"))
	h.setMem(c, []uint16{0})
	memTick(p)
	memTick(p)
	if m := <-c.memOut; !bytes.Equal(m, []byte{'M', 1, 2, 0, 0}) {
		t.Fatalf("unavailable: % x", m)
	}
	select {
	case m := <-c.memOut:
		t.Fatalf("told twice: % x", m)
	default:
	}
}
