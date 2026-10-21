package main

import (
	"encoding/binary"
	"errors"
	"os"
	"sync"
	"time"
)

// Live heat: DOSBox-X's debug build counts, per 16-byte paragraph of the
// first megabyte, how often it was read and written, in shared memory
// (output_gamelink.cpp), while this sidecar has the block's `enabled` flag
// set. Clients that send {"heat":1} get a tick ten times a second with the
// paragraphs touched since the last one; {"heat":0} stops it. The emulator
// counts only while someone listens, so a box nobody watches pays nothing.
//
//	0  magic "DBXH"  4 version u16  6 bucket_shift u16  8 buckets u32
//	12 enabled u32   16 frame u64   24 reads u16[buckets]  then writes u16[buckets]
//
// One tick, binary:
//
//	"H" 1 flags:u8 n:u32 then n × (bucket:u16, reads:u16, writes:u16)
//	flags bit 0: the first tick since heat was switched on (start afresh)
const (
	heatMagic      = 0x48584244
	heatOffEnabled = 12
	heatOffCounts  = 24
	heatBuckets    = 65536
	heatPeriod     = 100 * time.Millisecond
)

var errNoHeat = errors.New("no heat map (the box doesn't run the debug image)")

type HeatPump struct {
	hub  *Hub
	path string
	mu   sync.Mutex
	f    *os.File
	st   os.FileInfo
	prev []byte // the counters as last seen
	on   bool   // the block's enabled flag as we last set it
	cur  []byte
}

func NewHeatPump(hub *Hub, path string) *HeatPump {
	return &HeatPump{hub: hub, path: path, prev: make([]byte, heatBuckets*4), cur: make([]byte, heatBuckets*4)}
}

func (p *HeatPump) open() error {
	st, err := os.Stat(p.path)
	if err != nil {
		p.close()
		return errNoHeat
	}
	if p.f != nil && os.SameFile(st, p.st) {
		return nil
	}
	p.close()
	if p.f, err = os.OpenFile(p.path, os.O_RDWR, 0); err != nil {
		return err
	}
	p.st = st
	var hdr [heatOffCounts]byte
	if _, err := p.f.ReadAt(hdr[:], 0); err != nil || binary.LittleEndian.Uint32(hdr[:]) != heatMagic ||
		binary.LittleEndian.Uint32(hdr[8:]) != heatBuckets {
		p.close()
		return errNoHeat
	}
	p.on = false // a new block: say again whether we want it
	return nil
}

func (p *HeatPump) close() {
	if p.f != nil {
		p.f.Close()
		p.f, p.st = nil, nil
	}
}

func (p *HeatPump) setEnabled(on bool) {
	if p.f == nil || p.on == on {
		return
	}
	var b [4]byte
	if on {
		binary.LittleEndian.PutUint32(b[:], 1)
	}
	if _, err := p.f.WriteAt(b[:], heatOffEnabled); err == nil {
		p.on = on
	}
}

// Available says whether the box publishes a heat map at all.
func (p *HeatPump) Available() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.open() == nil
}

// Run switches counting on while anyone listens and sends each listener
// the paragraphs touched since the last tick.
func (p *HeatPump) Run() {
	t := time.NewTicker(heatPeriod)
	defer t.Stop()
	fresh := true
	for range t.C {
		want := p.hub.heatWanted()
		p.mu.Lock()
		if err := p.open(); err != nil {
			p.mu.Unlock()
			continue
		}
		if !want {
			p.setEnabled(false)
			fresh = true
			p.mu.Unlock()
			continue
		}
		if !p.on {
			// Start counting from here: what the counters hold is history.
			if _, err := p.f.ReadAt(p.prev, heatOffCounts); err != nil {
				p.mu.Unlock()
				continue
			}
			p.setEnabled(true)
			fresh = true
			p.mu.Unlock()
			continue
		}
		if _, err := p.f.ReadAt(p.cur, heatOffCounts); err != nil {
			p.mu.Unlock()
			continue
		}
		msg := heatFrame(p.prev, p.cur, fresh)
		p.prev, p.cur = p.cur, p.prev
		p.mu.Unlock()
		if msg != nil {
			fresh = false
			p.hub.broadcastHeat(msg)
		}
	}
}

// heatFrame is the tick for the counters moving from prev to cur, nil when nothing moved
// (a fresh tick is always sent, even empty, so the client knows to start afresh).
func heatFrame(prev, cur []byte, fresh bool) []byte {
	out := make([]byte, 7, 7+6*256)
	out[0], out[1] = 'H', 1
	if fresh {
		out[2] = 1
	}
	n := uint32(0)
	var e [6]byte
	for b := 0; b < heatBuckets; b++ {
		r := binary.LittleEndian.Uint16(cur[b*2:]) - binary.LittleEndian.Uint16(prev[b*2:])
		w := binary.LittleEndian.Uint16(cur[heatBuckets*2+b*2:]) - binary.LittleEndian.Uint16(prev[heatBuckets*2+b*2:])
		if r == 0 && w == 0 {
			continue
		}
		binary.LittleEndian.PutUint16(e[0:], uint16(b))
		binary.LittleEndian.PutUint16(e[2:], r)
		binary.LittleEndian.PutUint16(e[4:], w)
		out = append(out, e[:]...)
		n++
	}
	if n == 0 && !fresh {
		return nil
	}
	binary.LittleEndian.PutUint32(out[3:], n)
	return out
}
