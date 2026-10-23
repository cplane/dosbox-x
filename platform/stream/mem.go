package main

import (
	"bytes"
	"compress/flate"
	"encoding/binary"
	"errors"
	"os"
	"sync"
	"time"
)

// Live memory: DOSBox-X mirrors the first megabyte as the CPU sees it into shared memory
// (output_gamelink.cpp) while this sidecar has the block's `enabled` flag set: about 15 times a
// second while the program runs, and right after each debugger command while it is paused. A
// client that sends {"mem":[tile, …]} (4 KB tiles, the ones it shows, the most wanted first) gets
// those tiles, and then each again whenever it changes, ten times a second; {"mem":[]} stops it.
//
//	0 magic "DBXM"  4 version u16  6 page_shift u16  8 size u32  12 enabled u32
//	16 seq u64 (odd while a copy is under way)  24 reserved u64  32 mirrored bit per page [32]  64 mem[1 MB]
//
// One message, binary:
//
//	"M" 1 flags:u8 n:u16 then the body: n × (tile:u16, mirrored:u8, bytes[4096])
//	flags bit 0: the body is deflate-compressed (raw deflate)
//	flags bit 1: the box has no memory mirror (an older image): nothing will come
const (
	memMagic      = 0x4D584244
	memOffEnabled = 12
	memOffSeq     = 16
	memOffMirror  = 32
	memOffData    = 64
	memSize       = 0x100000
	memTile       = 4096
	memTiles      = memSize / memTile
	memPeriod     = 100 * time.Millisecond
	// At most this many tiles (4 KB each) to a client per tick: a whole megabyte arrives in a few
	// seconds, and what changes in a running program (a stack, a buffer, the screen) every tick.
	memBudget = 64
)

var errNoMem = errors.New("no memory mirror (the box runs an older image)")

type MemPump struct {
	hub  *Hub
	path string
	mu   sync.Mutex
	f    *os.File
	st   os.FileInfo
	on   bool

	snap     []byte           // the last consistent copy: the mirrored bits, then the megabyte
	next     []byte           // the copy being read
	version  [memTiles]uint32 // bumped when a tile's bytes (or its mirrored bit) change
	haveSnap bool
}

func NewMemPump(hub *Hub, path string) *MemPump {
	n := memOffData - memOffMirror + memSize
	return &MemPump{hub: hub, path: path, snap: make([]byte, n), next: make([]byte, n)}
}

func (p *MemPump) open() error {
	st, err := os.Stat(p.path)
	if err != nil {
		p.close()
		return errNoMem
	}
	if p.f != nil && os.SameFile(st, p.st) {
		return nil
	}
	p.close()
	if p.f, err = os.OpenFile(p.path, os.O_RDWR, 0); err != nil {
		return err
	}
	p.st = st
	var hdr [16]byte
	if _, err := p.f.ReadAt(hdr[:], 0); err != nil || binary.LittleEndian.Uint32(hdr[:]) != memMagic ||
		binary.LittleEndian.Uint32(hdr[8:]) != memSize {
		p.close()
		return errNoMem
	}
	p.on = false
	p.haveSnap = false // a new emulator: everything is news
	return nil
}

func (p *MemPump) close() {
	if p.f != nil {
		p.f.Close()
		p.f, p.st = nil, nil
	}
}

func (p *MemPump) setEnabled(on bool) {
	if p.f == nil || p.on == on {
		return
	}
	var b [4]byte
	if on {
		binary.LittleEndian.PutUint32(b[:], 1)
	}
	if _, err := p.f.WriteAt(b[:], memOffEnabled); err == nil {
		p.on = on
	}
}

// read takes a consistent copy (the same even seq before and after) into p.next.
func (p *MemPump) read() bool {
	var s [8]byte
	for try := 0; try < 4; try++ {
		if _, err := p.f.ReadAt(s[:], memOffSeq); err != nil {
			return false
		}
		before := binary.LittleEndian.Uint64(s[:])
		if before&1 == 1 {
			time.Sleep(2 * time.Millisecond)
			continue
		}
		if _, err := p.f.ReadAt(p.next, memOffMirror); err != nil {
			return false
		}
		if _, err := p.f.ReadAt(s[:], memOffSeq); err != nil {
			return false
		}
		if binary.LittleEndian.Uint64(s[:]) == before {
			return true
		}
	}
	return false
}

// absorb makes p.next the snapshot, bumping the version of every tile that changed.
func (p *MemPump) absorb() {
	const head = memOffData - memOffMirror
	for t := 0; t < memTiles; t++ {
		bit := byte(1) << (t & 7)
		a, b := head+t*memTile, head+(t+1)*memTile
		if !p.haveSnap || (p.snap[t>>3]&bit) != (p.next[t>>3]&bit) || !bytes.Equal(p.snap[a:b], p.next[a:b]) {
			p.version[t]++
		}
	}
	p.snap, p.next = p.next, p.snap
	p.haveSnap = true
}

// Run mirrors while anyone watches and sends each watcher what changed among its tiles.
func (p *MemPump) Run() {
	t := time.NewTicker(memPeriod)
	defer t.Stop()
	for range t.C {
		watchers := p.hub.memWatchers()
		p.mu.Lock()
		err := p.open()
		if err != nil || len(watchers) == 0 {
			if err == nil {
				p.setEnabled(false)
			}
			p.mu.Unlock()
			if err != nil {
				for _, c := range watchers {
					p.hub.memUnavailable(c)
				}
			}
			continue
		}
		p.setEnabled(true)
		if p.read() {
			p.absorb()
		}
		if !p.haveSnap {
			p.mu.Unlock()
			continue
		}
		for _, c := range watchers {
			if msg := p.frameFor(c); msg != nil {
				p.hub.sendMem(c, msg)
			}
		}
		p.mu.Unlock()
	}
}

// frameFor is the next message for a watcher: its wanted tiles that it has not seen at their
// current version, in its order, up to the budget; nil when it is up to date.
func (p *MemPump) frameFor(c *client) []byte {
	want, sent := p.hub.memState(c)
	var tiles []int
	for _, t := range want {
		if int(t) >= memTiles || sent[t] == p.version[t] {
			continue
		}
		tiles = append(tiles, int(t))
		if len(tiles) == memBudget {
			break
		}
	}
	if len(tiles) == 0 {
		return nil
	}
	const head = memOffData - memOffMirror
	var raw bytes.Buffer
	raw.Grow(len(tiles) * (3 + memTile))
	versions := make([]uint32, len(tiles))
	for i, t := range tiles {
		var h [3]byte
		binary.LittleEndian.PutUint16(h[:], uint16(t))
		if p.snap[t>>3]&(byte(1)<<(t&7)) != 0 {
			h[2] = 1
		}
		raw.Write(h[:])
		raw.Write(p.snap[head+t*memTile : head+(t+1)*memTile])
		versions[i] = p.version[t]
	}
	p.hub.memSent(c, tiles, versions)
	return memFrame(len(tiles), raw.Bytes())
}

// memFrame wraps a body, deflated (memory is mostly zeros and repeats).
func memFrame(n int, body []byte) []byte {
	var z bytes.Buffer
	z.Write([]byte{'M', 1, 1, byte(n), byte(n >> 8)})
	w, _ := flate.NewWriter(&z, flate.BestSpeed)
	w.Write(body)
	w.Close()
	return z.Bytes()
}
