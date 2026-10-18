package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os"
	"sync"
	"time"
)

// Offsets into sSharedMemoryMap_R4 (src/gamelink/gamelink.h, #pragma pack 1).
const (
	offFlags   = 1
	offProgram = 66
	programLen = 260

	offFrame     = 342 // after version, flags, system[64], program[260], program_hash[16]
	offFrameSeq  = offFrame + 0
	offFrameW    = offFrame + 2
	offFrameH    = offFrame + 4
	offFrameFmt  = offFrame + 6
	offFrameParX = offFrame + 8
	offFrameParY = offFrame + 10
	offFrameBuf  = offFrame + 12

	maxFrameW = 1280
	maxFrameH = 1024

	offInput      = offFrameBuf + maxFrameW*maxFrameH*4
	offInputDX    = offInput + 0
	offInputDY    = offInput + 4
	offInputReady = offInput + 8
	offInputBtn   = offInput + 9
	offInputKeys  = offInput + 10 // uint32[8], bit n = Windows set-1 scancode n

	offPeek    = offInput + 42                     // sSharedMMapPeek_R2
	offBufRecv = offPeek + 4 + 16*1024*4 + 16*1024 // sSharedMMapBuffer_R1: payload u16 + data[64K]
	offBufHost = offBufRecv + 2 + 64*1024
	offAudio   = offBufHost + 2 + 64*1024
	offRAMSize = offAudio + 2
	coreSize   = offRAMSize + 4 // MEMORY_MAP_CORE_SIZE; guest RAM follows
	maxMechCmd = 128            // proc_mech() ignores longer commands
)

var errNoFrame = errors.New("no frame")

// FrameHeader is the Game Link frame metadata.
type FrameHeader struct {
	Seq     uint16
	W, H    int
	ParX    int
	ParY    int
	Flags   uint8
	Program string
}

// Gamelink reads frames from and writes input to the DOSBox-X Game Link
// shared memory file. It re-opens the file when DOSBox-X recreates it.
type Gamelink struct {
	path string

	mu sync.Mutex
	f  *os.File
	st os.FileInfo
}

func NewGamelink(path string) *Gamelink { return &Gamelink{path: path} }

// file returns the open shm file, (re)opening it if DOSBox-X replaced it.
func (g *Gamelink) file() (*os.File, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	st, err := os.Stat(g.path)
	if err != nil {
		g.closeLocked()
		return nil, err
	}
	if g.f != nil && os.SameFile(st, g.st) {
		return g.f, nil
	}
	g.closeLocked()
	f, err := os.OpenFile(g.path, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	g.f, g.st = f, st
	return f, nil
}

func (g *Gamelink) Close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closeLocked()
}

func (g *Gamelink) closeLocked() {
	if g.f != nil {
		g.f.Close()
		g.f, g.st = nil, nil
	}
}

func (g *Gamelink) Header() (FrameHeader, error) {
	f, err := g.file()
	if err != nil {
		return FrameHeader{}, err
	}
	var b [offFrameBuf]byte
	if _, err := f.ReadAt(b[:], 0); err != nil {
		return FrameHeader{}, err
	}
	h := FrameHeader{
		Seq:   binary.LittleEndian.Uint16(b[offFrameSeq:]),
		W:     int(binary.LittleEndian.Uint16(b[offFrameW:])),
		H:     int(binary.LittleEndian.Uint16(b[offFrameH:])),
		ParX:  int(binary.LittleEndian.Uint16(b[offFrameParX:])),
		ParY:  int(binary.LittleEndian.Uint16(b[offFrameParY:])),
		Flags: b[offFlags],
	}
	prog := b[offProgram : offProgram+programLen]
	for i, c := range prog {
		if c == 0 {
			prog = prog[:i]
			break
		}
	}
	h.Program = string(prog)
	if b[offFrameFmt] != 1 || h.W == 0 || h.H == 0 || h.W > maxFrameW || h.H > maxFrameH {
		return h, errNoFrame
	}
	return h, nil
}

// ReadPixels copies the frame's 32-bit 0xAARRGGBB pixels (bytes B,G,R,A) into buf.
func (g *Gamelink) ReadPixels(h FrameHeader, buf []byte) ([]byte, error) {
	f, err := g.file()
	if err != nil {
		return nil, err
	}
	n := h.W * h.H * 4
	if cap(buf) < n {
		buf = make([]byte, n)
	}
	buf = buf[:n]
	_, err = f.ReadAt(buf, offFrameBuf)
	return buf, err
}

// InputState is the full input block DOSBox-X diffs against its previous copy.
type InputState struct {
	Keys    [8]uint32
	Buttons uint8
}

// WriteInput publishes state plus a relative mouse delta and raises the
// ready flag. DOSBox-X zeroes dx/dy when it consumes the block, so a delta
// written before the previous one was consumed is added to it.
func (g *Gamelink) WriteInput(s InputState, dx, dy float32) error {
	f, err := g.file()
	if err != nil {
		return err
	}
	var cur [8]byte
	if _, err := f.ReadAt(cur[:], offInputDX); err != nil {
		return err
	}
	dx += math.Float32frombits(binary.LittleEndian.Uint32(cur[0:]))
	dy += math.Float32frombits(binary.LittleEndian.Uint32(cur[4:]))

	var b [offInputKeys + 32 - offInput]byte
	binary.LittleEndian.PutUint32(b[offInputDX-offInput:], math.Float32bits(dx))
	binary.LittleEndian.PutUint32(b[offInputDY-offInput:], math.Float32bits(dy))
	b[offInputBtn-offInput] = s.Buttons
	for i, w := range s.Keys {
		binary.LittleEndian.PutUint32(b[offInputKeys-offInput+4*i:], w)
	}
	// Write everything but the ready flag first, then raise it.
	b[offInputReady-offInput] = 0
	if _, err := f.WriteAt(b[:], offInput); err != nil {
		return err
	}
	_, err = f.WriteAt([]byte{1}, offInputReady)
	return err
}

// Consumed reports whether DOSBox-X has taken the last published input.
func (g *Gamelink) Consumed() (bool, error) {
	f, err := g.file()
	if err != nil {
		return false, err
	}
	var b [1]byte
	if _, err := f.ReadAt(b[:], offInputReady); err != nil {
		return false, err
	}
	return b[0] == 0, nil
}

// Command sends a Game Link "mechanical" command (":reset", ":pause",
// ":rescan" ...) through buf_recv and waits until DOSBox-X has taken it.
// DOSBox-X polls the buffer once per frame output.
func (g *Gamelink) Command(cmd string, timeout time.Duration) error {
	if len(cmd) < 2 || len(cmd) > maxMechCmd || cmd[0] != ':' {
		return fmt.Errorf("bad command %q", cmd)
	}
	f, err := g.file()
	if err != nil {
		return err
	}
	pending := func() (bool, error) {
		var b [2]byte
		if _, err := f.ReadAt(b[:], offBufRecv); err != nil {
			return false, err
		}
		return binary.LittleEndian.Uint16(b[:]) != 0, nil
	}
	deadline := time.Now().Add(timeout)
	for {
		p, err := pending()
		if err != nil {
			return err
		}
		if !p {
			break
		}
		if time.Now().After(deadline) {
			return errors.New("game link command buffer busy")
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Data first, then the payload length that makes DOSBox-X read it.
	if _, err := f.WriteAt(append([]byte(cmd), 0), offBufRecv+2); err != nil {
		return err
	}
	var n [2]byte
	binary.LittleEndian.PutUint16(n[:], uint16(len(cmd)))
	if _, err := f.WriteAt(n[:], offBufRecv); err != nil {
		return err
	}
	for time.Now().Before(deadline) {
		if p, err := pending(); err != nil || !p {
			return err
		}
		time.Sleep(5 * time.Millisecond)
	}
	return errors.New("DOSBox-X did not take the command (paused, or no frames?)")
}

// ReadRAM reads guest physical memory, which Game Link maps right after
// the core block.
func (g *Gamelink) ReadRAM(addr, n int) ([]byte, error) {
	f, err := g.file()
	if err != nil {
		return nil, err
	}
	var sz [4]byte
	if _, err := f.ReadAt(sz[:], offRAMSize); err != nil {
		return nil, err
	}
	if addr < 0 || n < 0 || addr+n > int(binary.LittleEndian.Uint32(sz[:])) {
		return nil, fmt.Errorf("guest address %#x+%d out of range", addr, n)
	}
	b := make([]byte, n)
	_, err = f.ReadAt(b, int64(coreSize+addr))
	return b, err
}

func (h FrameHeader) String() string {
	return fmt.Sprintf("seq=%d %dx%d par=%d:%d program=%q", h.Seq, h.W, h.H, h.ParX, h.ParY, h.Program)
}
