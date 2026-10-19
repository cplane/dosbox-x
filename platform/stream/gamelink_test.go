package main

import (
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// Total size of sSharedMemoryMap_R4 as DOSBox-X ftruncates it (observed:
// 22233498 bytes in the running pod); only the prefix up to the input
// block matters here.
const shmSize = 22233498

func fakeShm(t *testing.T) (string, *os.File) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "gl")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(shmSize); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return p, f
}

func TestHeaderAndPixels(t *testing.T) {
	p, f := fakeShm(t)
	var hdr [offFrameBuf]byte
	hdr[offFlags] = 1
	copy(hdr[offProgram:], "COMMAND\x00")
	binary.LittleEndian.PutUint16(hdr[offFrameSeq:], 80)
	binary.LittleEndian.PutUint16(hdr[offFrameW:], 2)
	binary.LittleEndian.PutUint16(hdr[offFrameH:], 1)
	hdr[offFrameFmt] = 1
	binary.LittleEndian.PutUint16(hdr[offFrameParX:], 4096)
	binary.LittleEndian.PutUint16(hdr[offFrameParY:], 5531)
	f.WriteAt(hdr[:], 0)
	f.WriteAt([]byte{1, 2, 3, 255, 4, 5, 6, 255}, offFrameBuf) // BGRA

	gl := NewGamelink(p)
	t.Cleanup(gl.Close)
	h, err := gl.Header()
	if err != nil {
		t.Fatal(err)
	}
	if h.Seq != 80 || h.W != 2 || h.H != 1 || h.ParY != 5531 || h.Program != "COMMAND" {
		t.Fatalf("header %v", h)
	}
	px, err := gl.ReadPixels(h, nil)
	if err != nil {
		t.Fatal(err)
	}
	rgba := make([]byte, len(px))
	bgraToRGBA(rgba, px)
	if want := []byte{3, 2, 1, 255, 6, 5, 4, 255}; string(rgba) != string(want) {
		t.Fatalf("rgba %v want %v", rgba, want)
	}
}

func TestWriteInputAccumulatesMouse(t *testing.T) {
	p, f := fakeShm(t)
	gl := NewGamelink(p)
	t.Cleanup(gl.Close)
	var s InputState
	s.Keys[0x1C/32] |= 1 << (0x1C % 32) // Enter
	s.Buttons = 1
	if err := gl.WriteInput(s, 3, -2); err != nil {
		t.Fatal(err)
	}
	if err := gl.WriteInput(s, 1, 1); err != nil { // not consumed yet -> adds
		t.Fatal(err)
	}
	var b [42]byte
	f.ReadAt(b[:], offInput)
	dx := math.Float32frombits(binary.LittleEndian.Uint32(b[0:]))
	dy := math.Float32frombits(binary.LittleEndian.Uint32(b[4:]))
	if dx != 4 || dy != -1 || b[8] != 1 || b[9] != 1 {
		t.Fatalf("dx=%v dy=%v ready=%d btn=%d", dx, dy, b[8], b[9])
	}
	if w := binary.LittleEndian.Uint32(b[10:]); w != 1<<0x1C {
		t.Fatalf("keys[0]=%#x", w)
	}
	if ok, _ := gl.Consumed(); ok {
		t.Fatal("should not be consumed")
	}
	f.WriteAt([]byte{0}, offInputReady) // DOSBox-X took it
	if ok, _ := gl.Consumed(); !ok {
		t.Fatal("should be consumed")
	}
}

func TestOffsetsMatchHeaderLayout(t *testing.T) {
	// 342 = version + flags + system[64] + program[260] + hash[16]
	if offFrame != 1+1+64+260+16 {
		t.Fatal("frame offset")
	}
	if offInput != 342+12+1280*1024*4 {
		t.Fatal("input offset")
	}
}

func TestWriteInputAbsReplaces(t *testing.T) {
	p, f := fakeShm(t)
	gl := NewGamelink(p)
	t.Cleanup(gl.Close)
	s := InputState{Buttons: 1}
	if err := gl.WriteInputAbs(s, 0.25, 0.5); err != nil {
		t.Fatal(err)
	}
	if err := gl.WriteInputAbs(s, 0.75, 0.125); err != nil { // not consumed yet -> replaces
		t.Fatal(err)
	}
	var b [10]byte
	f.ReadAt(b[:], offInput)
	x := math.Float32frombits(binary.LittleEndian.Uint32(b[0:]))
	y := math.Float32frombits(binary.LittleEndian.Uint32(b[4:]))
	if x != 0.75 || y != 0.125 || b[8] != 1 || b[9] != 1|mouseAbsolute {
		t.Fatalf("x=%v y=%v ready=%d btn=%#x", x, y, b[8], b[9])
	}
}
