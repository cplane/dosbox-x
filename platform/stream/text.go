package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"strings"
	"sync"

	"golang.org/x/text/encoding/charmap"
)

// The text screen mirror: DOSBox-X publishes text modes as data in
// /dev/shm/DWD_GAMELINK_TEXT_R1 (output_gamelink.cpp, sGameLinkText_R1),
// a seqlock (seq odd while written). Offsets below follow that struct.
const (
	txtMagic    = 0x54584244 // "DBXT"
	txtOffFlags = 6
	txtOffSeq   = 8
	txtOffCols  = 12
	txtOffFont  = 80
	txtOffCells = txtOffFont + 256*32
	txtMaxCells = 132 * 60
	txtSize     = txtOffCells + txtMaxCells*2

	txtActive        = 1 << 0
	txtCursorVisible = 1 << 1
	txtBlink         = 1 << 2
	txtLineGraphics  = 1 << 3
	txtFont          = 1 << 4
)

// TextScreen is one consistent copy of the mirror.
type TextScreen struct {
	Flags                  uint16
	Cols, Rows             int
	CellW, CellH           int
	CursorX, CursorY       int
	CursorStart, CursorEnd uint8
	Codepage               uint16
	FontSeq                uint32
	Palette                [48]byte
	Font                   []byte // 256 glyphs × CellH scanlines
	Cells                  []byte // Cols×Rows × (char, attr)
}

func (t *TextScreen) Active() bool { return t != nil && t.Flags&txtActive != 0 }

// TextMirror reads the block, reopening it when DOSBox-X recreates it.
type TextMirror struct {
	path string
	mu   sync.Mutex
	f    *os.File
	st   os.FileInfo
	buf  []byte
}

func NewTextMirror(path string) *TextMirror {
	return &TextMirror{path: path, buf: make([]byte, txtSize)}
}

var errNoText = errors.New("no text mirror")

// Read returns the current text screen, or nil when the screen is not in a
// text mode (or DOSBox-X doesn't publish one).
func (m *TextMirror) Read() (*TextScreen, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, err := os.Stat(m.path)
	if err != nil {
		m.close()
		return nil, errNoText
	}
	if m.f == nil || !os.SameFile(st, m.st) {
		m.close()
		if m.f, err = os.Open(m.path); err != nil {
			return nil, err
		}
		m.st = st
	}
	for try := 0; try < 4; try++ {
		var seq [4]byte
		if _, err := m.f.ReadAt(seq[:], txtOffSeq); err != nil {
			return nil, err
		}
		s1 := binary.LittleEndian.Uint32(seq[:])
		if s1&1 != 0 {
			continue // being written
		}
		if _, err := m.f.ReadAt(m.buf, 0); err != nil {
			return nil, err
		}
		if binary.LittleEndian.Uint32(m.buf[txtOffSeq:]) != s1 {
			continue // changed while we read
		}
		return parseText(m.buf), nil
	}
	return nil, errors.New("text mirror busy")
}

func (m *TextMirror) close() {
	if m.f != nil {
		m.f.Close()
		m.f, m.st = nil, nil
	}
}

func parseText(b []byte) *TextScreen {
	le := binary.LittleEndian
	if le.Uint32(b) != txtMagic {
		return nil
	}
	t := &TextScreen{Flags: le.Uint16(b[txtOffFlags:])}
	if t.Flags&txtActive == 0 {
		return nil
	}
	t.Cols, t.Rows = int(le.Uint16(b[12:])), int(le.Uint16(b[14:]))
	t.CellW, t.CellH = int(le.Uint16(b[16:])), int(le.Uint16(b[18:]))
	t.CursorX, t.CursorY = int(le.Uint16(b[20:])), int(le.Uint16(b[22:]))
	t.CursorStart, t.CursorEnd = b[24], b[25]
	t.Codepage = le.Uint16(b[26:])
	t.FontSeq = le.Uint32(b[28:])
	if t.Cols < 1 || t.Rows < 1 || t.Cols*t.Rows > txtMaxCells || t.CellH < 1 || t.CellH > 32 {
		return nil
	}
	copy(t.Palette[:], b[32:80])
	t.Font = make([]byte, 256*t.CellH)
	for c := 0; c < 256; c++ {
		copy(t.Font[c*t.CellH:(c+1)*t.CellH], b[txtOffFont+c*32:txtOffFont+c*32+t.CellH])
	}
	t.Cells = append([]byte(nil), b[txtOffCells:txtOffCells+t.Cols*t.Rows*2]...)
	return t
}

// sameGeometry reports whether a and b can be diffed row by row.
func sameGeometry(a, b *TextScreen) bool {
	return a != nil && b != nil && a.Cols == b.Cols && a.Rows == b.Rows && a.CellW == b.CellW && a.CellH == b.CellH
}

// A text update (binary, little-endian):
//
//	"T" 1 flags:u16 cols:u16 rows:u16 cellW:u16 cellH:u16 curX:u16 curY:u16
//	curStart:u8 curEnd:u8 codepage:u16 sections:u8
//	[palette: 48 bytes]             if sections & 1
//	[font: 256 × cellH bytes]       if sections & 2
//	[count:u16, count × (row:u16, cols × (char, attr))]  if sections & 4
//
// The header (cursor, flags) comes with every update.
const (
	secPalette = 1
	secFont    = 2
	secRows    = 4
)

func encodeText(t *TextScreen, palette, font bool, rows []int) []byte {
	le := binary.LittleEndian
	var b bytes.Buffer
	h := make([]byte, 24)
	h[0], h[1] = 'T', 1
	le.PutUint16(h[2:], t.Flags)
	le.PutUint16(h[4:], uint16(t.Cols))
	le.PutUint16(h[6:], uint16(t.Rows))
	le.PutUint16(h[8:], uint16(t.CellW))
	le.PutUint16(h[10:], uint16(t.CellH))
	le.PutUint16(h[12:], uint16(t.CursorX))
	le.PutUint16(h[14:], uint16(t.CursorY))
	h[16], h[17] = t.CursorStart, t.CursorEnd
	le.PutUint16(h[18:], t.Codepage)
	var sec byte
	if palette {
		sec |= secPalette
	}
	if font {
		sec |= secFont
	}
	if len(rows) > 0 {
		sec |= secRows
	}
	h[20] = sec
	b.Write(h[:21])
	if palette {
		b.Write(t.Palette[:])
	}
	if font {
		b.Write(t.Font)
	}
	if len(rows) > 0 {
		var n [2]byte
		le.PutUint16(n[:], uint16(len(rows)))
		b.Write(n[:])
		for _, r := range rows {
			le.PutUint16(n[:], uint16(r))
			b.Write(n[:])
			b.Write(t.Cells[r*t.Cols*2 : (r+1)*t.Cols*2])
		}
	}
	return b.Bytes()
}

// changedRows lists the rows of cur that differ from prev.
func changedRows(cur, prev *TextScreen) []int {
	var out []int
	w := cur.Cols * 2
	for r := 0; r < cur.Rows; r++ {
		if !sameGeometry(cur, prev) || !bytes.Equal(cur.Cells[r*w:(r+1)*w], prev.Cells[r*w:(r+1)*w]) {
			out = append(out, r)
		}
	}
	return out
}

var codepages = map[uint16]*charmap.Charmap{
	437: charmap.CodePage437, 850: charmap.CodePage850, 852: charmap.CodePage852,
	855: charmap.CodePage855, 858: charmap.CodePage858, 860: charmap.CodePage860,
	862: charmap.CodePage862, 863: charmap.CodePage863, 865: charmap.CodePage865,
	866: charmap.CodePage866,
}

// Text renders the screen as UTF-8 lines (trailing blanks trimmed), the
// character bytes read through the screen's codepage (437 if unknown).
func (t *TextScreen) Text() string {
	cm := codepages[t.Codepage]
	if cm == nil {
		cm = charmap.CodePage437
	}
	var sb strings.Builder
	for r := 0; r < t.Rows; r++ {
		line := make([]rune, t.Cols)
		for c := 0; c < t.Cols; c++ {
			ch := t.Cells[(r*t.Cols+c)*2]
			if ch == 0 {
				line[c] = ' '
			} else {
				line[c] = cm.DecodeByte(ch)
			}
		}
		sb.WriteString(strings.TrimRight(string(line), " "))
		sb.WriteByte('\n')
	}
	return sb.String()
}
