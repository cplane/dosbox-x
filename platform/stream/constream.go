package main

import (
	"encoding/binary"
	"errors"
	"os"
	"sync"
)

// The console stream: every byte DOS programs write to the CON device, in
// order, published by DOSBox-X (output_gamelink.cpp) as a ring buffer in
// shared memory. Unlike the text mirror it misses nothing that scrolls by
// quickly; unlike the mirror it has nothing a program draws on the screen
// directly.
//
//	0  magic "DBXC"   4  version u16   6  reserved u16
//	8  size u32       12 reserved u32  16 write_pos u64 (bytes ever written)
//	24 ring[size]
const (
	conMagic    = 0x43584244
	conOffSize  = 8
	conOffPos   = 16
	conOffRing  = 24
	conMaxBytes = 4 << 20
)

type ConStream struct {
	path string
	mu   sync.Mutex
	f    *os.File
	st   os.FileInfo
	size uint64
}

func NewConStream(path string) *ConStream { return &ConStream{path: path} }

var errNoCon = errors.New("no console stream")

func (c *ConStream) open() error {
	st, err := os.Stat(c.path)
	if err != nil {
		c.close()
		return errNoCon
	}
	if c.f != nil && os.SameFile(st, c.st) {
		return nil
	}
	c.close()
	if c.f, err = os.Open(c.path); err != nil {
		return err
	}
	c.st = st
	var hdr [conOffRing]byte
	if _, err := c.f.ReadAt(hdr[:], 0); err != nil {
		c.close()
		return err
	}
	size := uint64(binary.LittleEndian.Uint32(hdr[conOffSize:]))
	if binary.LittleEndian.Uint32(hdr[:]) != conMagic || size == 0 || size > conMaxBytes {
		c.close()
		return errNoCon
	}
	c.size = size
	return nil
}

func (c *ConStream) close() {
	if c.f != nil {
		c.f.Close()
		c.f, c.st = nil, nil
	}
}

func (c *ConStream) writePos() (uint64, error) {
	var b [8]byte
	if _, err := c.f.ReadAt(b[:], conOffPos); err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint64(b[:]), nil
}

// Pos is the stream position now: bytes written before it are old.
func (c *ConStream) Pos() (uint64, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.open(); err != nil {
		return 0, err
	}
	return c.writePos()
}

// ReadFrom returns the bytes written since pos and the position after
// them. lost is true when some were already overwritten (the ring is
// smaller than what was written meanwhile, or DOSBox-X restarted the
// stream); the bytes returned are then the most recent ones.
func (c *ConStream) ReadFrom(pos uint64) (data []byte, next uint64, lost bool, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.open(); err != nil {
		return nil, pos, false, err
	}
	for try := 0; try < 4; try++ {
		end, err := c.writePos()
		if err != nil {
			return nil, pos, false, err
		}
		if end < pos { // DOSBox-X restarted: the stream begins again
			pos, lost = 0, true
		}
		if end-pos > c.size {
			pos, lost = end-c.size, true
		}
		if end == pos {
			return nil, end, lost, nil
		}
		buf := make([]byte, end-pos)
		start := pos % c.size
		n := min(uint64(len(buf)), c.size-start)
		if _, err := c.f.ReadAt(buf[:n], int64(conOffRing+start)); err != nil {
			return nil, pos, false, err
		}
		if n < uint64(len(buf)) {
			if _, err := c.f.ReadAt(buf[n:], conOffRing); err != nil {
				return nil, pos, false, err
			}
		}
		// Still intact if the writer didn't lap our start meanwhile.
		if end2, err := c.writePos(); err != nil {
			return nil, pos, false, err
		} else if end2-pos <= c.size {
			return buf, end, lost, nil
		}
	}
	return nil, pos, true, errors.New("console stream busy")
}
