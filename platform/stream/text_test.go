package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeMirror writes a text mirror block like DOSBox-X does.
func writeMirror(t *testing.T, path string, seq uint32, cols, rows int, cp uint16, text string, attr byte) {
	t.Helper()
	b := make([]byte, txtSize)
	le := binary.LittleEndian
	le.PutUint32(b, txtMagic)
	le.PutUint16(b[4:], 2)
	le.PutUint16(b[txtOffFlags:], txtActive|txtCursorVisible|txtFont)
	le.PutUint32(b[txtOffSeq:], seq)
	le.PutUint16(b[12:], uint16(cols))
	le.PutUint16(b[14:], uint16(rows))
	le.PutUint16(b[16:], 9)
	le.PutUint16(b[18:], 16)
	le.PutUint16(b[20:], 2) // cursor x
	le.PutUint16(b[22:], 1) // cursor y
	b[24], b[25] = 14, 15
	le.PutUint16(b[26:], cp)
	le.PutUint32(b[28:], 1)
	b[32] = 3                                              // errorlevel
	b[36+3*7], b[36+3*7+1], b[36+3*7+2] = 0xaa, 0xaa, 0xaa // light grey
	b[txtOffFont+'A'*32] = 0x18
	for i := 0; i < cols*rows; i++ {
		ch := byte(' ')
		if i < len(text) {
			ch = text[i]
		}
		b[txtOffCells+i*2], b[txtOffCells+i*2+1] = ch, attr
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestTextMirrorRead(t *testing.T) {
	p := filepath.Join(t.TempDir(), "text")
	m := NewTextMirror(p)
	t.Cleanup(func() { m.mu.Lock(); m.close(); m.mu.Unlock() })
	if ts, err := m.Read(); ts != nil || err == nil {
		t.Fatal("no file: want an error")
	}

	writeMirror(t, p, 3, 4, 2, 437, "AB", 0x07) // odd seq: being written
	if _, err := m.Read(); err == nil {
		t.Fatal("read a block that is being written")
	}
	writeMirror(t, p, 4, 4, 2, 437, "AB  C", 0x07)
	ts, err := m.Read()
	if err != nil || ts == nil {
		t.Fatal(ts, err)
	}
	if ts.Cols != 4 || ts.Rows != 2 || ts.CellW != 9 || ts.CellH != 16 || ts.CursorX != 2 || ts.CursorY != 1 {
		t.Fatalf("%+v", ts)
	}
	if len(ts.Font) != 256*16 || ts.Font['A'*16] != 0x18 || ts.Palette[21] != 0xaa {
		t.Fatal("font or palette not read")
	}
	if got := ts.Text(); got != "AB\nC\n" {
		t.Fatalf("text %q", got)
	}
}

func TestTextCodepage866(t *testing.T) {
	ts := &TextScreen{Cols: 3, Rows: 1, Codepage: 866, Cells: []byte{0x8f, 7, 0xe0, 7, 0xa8, 7}} // "При"
	if got := ts.Text(); got != "При\n" {
		t.Fatalf("cp866: %q", got)
	}
}

func TestTextUpdatesAndModeSwitch(t *testing.T) {
	h := NewHub(nil, 75, 60)
	c := h.add()
	h.wantText(c)

	// Graphics first: strips.
	g := frameOf(16, 8, func(x, y int) byte { return 1 })
	h.publish(16, 8, g, h.encodeStrips(g, 16, 8, changedStrips(g, nil, 16, 8)))
	if m := h.take(c); m == nil || m[0] != 'S' {
		t.Fatalf("graphics: want strips, got %q", m)
	}

	// Text mode: a full text update (palette, font, all rows).
	mk := func(s string) *TextScreen {
		cells := make([]byte, 4*2*2)
		for i := 0; i < 8; i++ {
			ch := byte(' ')
			if i < len(s) {
				ch = s[i]
			}
			cells[i*2], cells[i*2+1] = ch, 7
		}
		return &TextScreen{Flags: txtActive, Cols: 4, Rows: 2, CellW: 9, CellH: 16, Codepage: 437,
			FontSeq: 1, Font: make([]byte, 256*16), Cells: cells}
	}
	h.publishText(mk("ABCDEFGH"))
	m := h.take(c)
	if m == nil || m[0] != 'T' || m[20] != secPalette|secFont|secRows {
		t.Fatalf("first text update: % x", m[:min(24, len(m))])
	}
	if want := 21 + 48 + 256*16 + 2 + 2*(2+8); len(m) != want {
		t.Fatalf("full text update is %d bytes, want %d", len(m), want)
	}

	// One row changes: just that row.
	h.publishText(mk("ABCDxFGH"))
	m = h.take(c)
	if m == nil || m[20] != secRows || binary.LittleEndian.Uint16(m[21:]) != 1 || binary.LittleEndian.Uint16(m[23:]) != 1 {
		t.Fatalf("row update: % x", m)
	}
	if h.take(c) != nil {
		t.Fatal("nothing changed, but an update came")
	}

	// A client without text support keeps getting strips in text mode.
	old := h.add()
	if m := h.take(old); m == nil || m[0] != 'S' {
		t.Fatalf("non-text client: %q", m)
	}

	// Back to graphics: the text client gets the whole screen as strips.
	h.publishText(nil)
	if m := h.take(c); m == nil || m[0] != 'S' {
		t.Fatalf("after leaving text mode: %q", m)
	} else if _, _, s := parseUpdate(t, m); len(s) != 1 {
		t.Fatalf("want every strip, got %v", s)
	}
}

func TestScreenRenderings(t *testing.T) {
	if n := len(dosControlGlyphs); n != 32 {
		t.Fatalf("control glyph table has %d entries", n)
	}
	ts := &TextScreen{Flags: txtActive | txtCursorVisible | txtBlink, Cols: 3, Rows: 1, CellW: 9, CellH: 16,
		Codepage: 437, CursorX: 1, Cells: []byte{0x01, 0x1E, 'h', 0x9E, 0xC9, 0x07}}
	for i, rgb := range [][3]byte{1: {0, 0, 0xaa}, 7: {0xaa, 0xaa, 0xaa}, 14: {0xff, 0xff, 0x55}} {
		copy(ts.Palette[i*3:], rgb[:])
	}

	if got := ts.Text(); got != "☺h╔\n" {
		t.Fatalf("text %q", got)
	}

	ansi := ts.ANSI()
	for _, want := range []string{
		"\x1b[0;38;2;255;255;85;48;2;0;0;170m☺", // yellow on blue (attr 1E)
		"\x1b[5mh",                             // attr 9E: blinking, same colours
		"\x1b[0;38;2;170;170;170;48;2;0;0;0m╔", // grey on black (attr 07)
		"\x1b[0m\n",
	} {
		if !strings.Contains(ansi, want) {
			t.Fatalf("ansi lacks %q:\n%q", want, ansi)
		}
	}

	j := ts.JSON()
	row := j.Lines[0]
	if row.Text != "☺h╔" || len([]rune(row.Text)) != 3 || len(row.FG) != 3 {
		t.Fatalf("row %+v", row)
	}
	if row.FG[0] != 14 || row.BG[0] != 1 || row.BG[1] != 1 || len(row.Blink) != 1 || row.Blink[0] != 1 {
		t.Fatalf("colours %+v", row)
	}
	if j.Palette[14] != "#ffff55" || !j.Cursor.Visible || j.Cursor.X != 1 || !j.BlinkAttribute {
		t.Fatalf("screen %+v", j)
	}

	// Without blinking, bit 7 selects bright backgrounds.
	ts.Flags &^= txtBlink
	if r := ts.JSON().Lines[0]; r.BG[1] != 9 || len(r.Blink) != 0 {
		t.Fatalf("bright background: %+v", r)
	}
}
