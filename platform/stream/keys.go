package main

import (
	"fmt"
	"strings"
)

// PC set-1 scancodes, 0x80|code for E0-extended keys (matches
// src/gamelink/scancodes_windows.h and the player page's table).
const (
	scEsc       = 0x01
	scBackspace = 0x0E
	scTab       = 0x0F
	scEnter     = 0x1C
	scLCtrl     = 0x1D
	scLShift    = 0x2A
	scRShift    = 0x36
	scLAlt      = 0x38
	scSpace     = 0x39
)

// usKey is where an ASCII character sits on a US keyboard.
type usKey struct {
	sc    int
	shift bool
}

// usLayout maps printable ASCII and \t \n \b to US-layout keys.
var usLayout = func() map[rune]usKey {
	m := map[rune]usKey{
		' ': {scSpace, false}, '\t': {scTab, false}, '\n': {scEnter, false}, '\b': {scBackspace, false},
	}
	rows := []struct {
		first      int
		plain, shf string
	}{
		{0x02, "1234567890-=", "!@#$%^&*()_+"},
		{0x10, "qwertyuiop[]", "QWERTYUIOP{}"},
		{0x1E, "asdfghjkl;'`", "ASDFGHJKL:\"~"},
		{0x2C, "zxcvbnm,./", "ZXCVBNM<>?"},
	}
	for _, r := range rows {
		for i, c := range r.plain {
			m[c] = usKey{r.first + i, false}
		}
		for i, c := range r.shf {
			m[c] = usKey{r.first + i, true}
		}
	}
	m['\\'] = usKey{0x2B, false}
	m['|'] = usKey{0x2B, true}
	return m
}()

// namedKeys are the key names accepted in /keys combos (lower case).
var namedKeys = func() map[string]int {
	m := map[string]int{
		"esc": scEsc, "escape": scEsc,
		"backspace": scBackspace, "bksp": scBackspace, "bs": scBackspace,
		"tab": scTab, "enter": scEnter, "return": scEnter, "space": scSpace,
		"ctrl": scLCtrl, "control": scLCtrl, "lctrl": scLCtrl, "rctrl": 0x9D,
		"shift": scLShift, "lshift": scLShift, "rshift": scRShift,
		"alt": scLAlt, "lalt": scLAlt, "ralt": 0xB8, "altgr": 0xB8,
		"capslock": 0x3A, "caps": 0x3A, "numlock": 0x45, "scrolllock": 0x46,
		"f11": 0x57, "f12": 0x58,
		"home": 0xC7, "up": 0xC8, "pgup": 0xC9, "pageup": 0xC9,
		"left": 0xCB, "right": 0xCD, "end": 0xCF, "down": 0xD0,
		"pgdn": 0xD1, "pagedown": 0xD1, "ins": 0xD2, "insert": 0xD2,
		"del": 0xD3, "delete": 0xD3,
		"kpenter": 0x9C, "kp/": 0xB5, "kp*": 0x37, "kp-": 0x4A, "kp+": 0x4E, "kp.": 0x53,
		"kp7": 0x47, "kp8": 0x48, "kp9": 0x49, "kp4": 0x4B, "kp5": 0x4C, "kp6": 0x4D,
		"kp1": 0x4F, "kp2": 0x50, "kp3": 0x51, "kp0": 0x52,
		"prtsc": 0xB7, "printscreen": 0xB7, "pause": 0xC5,
		"win": 0xDB, "lwin": 0xDB, "rwin": 0xDC, "menu": 0xDD,
	}
	for i := 1; i <= 10; i++ {
		m[fmt.Sprintf("f%d", i)] = 0x3A + i
	}
	return m
}()

func isShift(sc int) bool { return sc == scLShift || sc == scRShift }

func press(sc int) InputEvent   { return InputEvent{Key: sc, Down: true, Buttons: -1} }
func release(sc int) InputEvent { return InputEvent{Key: sc, Down: false, Buttons: -1} }

// CharEvents returns the key transitions that type one character on a US
// layout. With capsLock set (the BIOS Caps Lock state) letters get the
// opposite Shift so the DOS program still sees the requested case.
// "\r\n" should be collapsed by the caller; a lone '\r' is Enter.
func CharEvents(c rune, capsLock bool) ([]InputEvent, error) {
	if c == '\r' {
		c = '\n'
	}
	k, ok := usLayout[c]
	if !ok {
		return nil, fmt.Errorf("character %q has no key on a US keyboard", c)
	}
	shift := k.shift
	if capsLock && (c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z') {
		shift = !shift
	}
	if !shift {
		return []InputEvent{press(k.sc), release(k.sc)}, nil
	}
	return []InputEvent{press(scLShift), press(k.sc), release(k.sc), release(scLShift)}, nil
}

// TextChars splits text into the characters CharEvents types, collapsing
// CRLF to one Enter, and rejects anything untypeable before input starts.
func TextChars(text string) ([]rune, error) {
	var out []rune
	rs := []rune(text)
	for i, c := range rs {
		if c == '\r' && i+1 < len(rs) && rs[i+1] == '\n' {
			continue
		}
		if c != '\r' {
			if _, ok := usLayout[c]; !ok {
				return nil, fmt.Errorf("character %q at %d has no key on a US keyboard", c, i)
			}
		}
		out = append(out, c)
	}
	return out, nil
}

// keyByName resolves one combo element: a key name, or a single character
// (which may need Shift, e.g. ":" or "plus" for "+"); letters are
// case-insensitive, so "ctrl+A" is Ctrl+A without Shift.
func keyByName(name string) (sc int, shift bool, err error) {
	n := strings.ToLower(name)
	if sc, ok := namedKeys[n]; ok {
		return sc, false, nil
	}
	if n == "plus" {
		n = "+"
	}
	if r := []rune(n); len(r) == 1 {
		if k, ok := usLayout[r[0]]; ok {
			return k.sc, k.shift, nil
		}
	}
	return 0, false, fmt.Errorf("unknown key %q", name)
}

// ParseCombo parses "ctrl+shift+f9" into scancodes in press order: the
// modifiers as written, then the last key. A character that needs Shift
// (e.g. "ctrl+:") adds Shift unless the combo already has it.
func ParseCombo(combo string) ([]int, error) {
	parts := strings.Split(combo, "+")
	// "ctrl++" and "+" end in the '+' key itself.
	if strings.HasSuffix(combo, "+") {
		base := strings.TrimSuffix(strings.TrimSuffix(combo, "+"), "+")
		parts = []string{"+"}
		if base != "" {
			parts = append(strings.Split(base, "+"), "+")
		}
	}
	var keys []int
	haveShift := false
	for i, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			return nil, fmt.Errorf("bad combo %q", combo)
		}
		sc, shift, err := keyByName(p)
		if err != nil {
			return nil, err
		}
		if isShift(sc) {
			haveShift = true
		}
		if shift && !haveShift && i == len(parts)-1 {
			keys = append(keys, scLShift)
			haveShift = true
		}
		keys = append(keys, sc)
	}
	return keys, nil
}

// ParseKeys parses whitespace-separated combos ("ctrl+k ctrl+b enter").
func ParseKeys(s string) ([][]int, error) {
	var out [][]int
	for _, c := range strings.Fields(s) {
		k, err := ParseCombo(c)
		if err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no keys")
	}
	return out, nil
}
