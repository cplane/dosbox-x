package main

import (
	"reflect"
	"testing"
)

// keyLog renders events as "+2A" (down) / "-2A" (up) for compact asserts.
func keyLog(evs []InputEvent) []string {
	var out []string
	for _, e := range evs {
		s := "-"
		if e.Down {
			s = "+"
		}
		out = append(out, s+hex2(e.Key))
	}
	return out
}

func hex2(v int) string {
	const d = "0123456789ABCDEF"
	return string([]byte{d[v>>4&15], d[v&15]})
}

func typeLog(t *testing.T, text string, caps bool) []string {
	t.Helper()
	chars, err := TextChars(text)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, c := range chars {
		evs, err := CharEvents(c, caps)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, keyLog(evs)...)
	}
	return out
}

func TestCharScancodes(t *testing.T) {
	cases := map[rune]usKey{
		'a': {0x1E, false}, 'A': {0x1E, true}, 'z': {0x2C, false}, 'q': {0x10, false},
		'1': {0x02, false}, '!': {0x02, true}, '0': {0x0B, false}, ')': {0x0B, true},
		'-': {0x0C, false}, '_': {0x0C, true}, '=': {0x0D, false}, '+': {0x0D, true},
		'[': {0x1A, false}, '{': {0x1A, true}, ']': {0x1B, false}, '}': {0x1B, true},
		';': {0x27, false}, ':': {0x27, true}, '\'': {0x28, false}, '"': {0x28, true},
		'`': {0x29, false}, '~': {0x29, true}, '\\': {0x2B, false}, '|': {0x2B, true},
		',': {0x33, false}, '<': {0x33, true}, '.': {0x34, false}, '>': {0x34, true},
		'/': {0x35, false}, '?': {0x35, true}, ' ': {0x39, false},
		'\n': {0x1C, false}, '\t': {0x0F, false}, '\b': {0x0E, false},
		'@': {0x03, true}, '#': {0x04, true}, '$': {0x05, true}, '%': {0x06, true},
		'^': {0x07, true}, '&': {0x08, true}, '*': {0x09, true}, '(': {0x0A, true},
	}
	for c, want := range cases {
		if got, ok := usLayout[c]; !ok || got != want {
			t.Errorf("%q: got %+v want %+v", c, got, want)
		}
	}
	// Every printable ASCII character is typeable.
	for c := rune(0x20); c < 0x7F; c++ {
		if _, ok := usLayout[c]; !ok {
			t.Errorf("%q missing", c)
		}
	}
}

func TestTypeText(t *testing.T) {
	got := typeLog(t, "dir > a:\r\n", false)
	want := []string{
		"+20", "-20", "+17", "-17", "+13", "-13", // d i r
		"+39", "-39", // space
		"+2A", "+34", "-34", "-2A", // >
		"+39", "-39",
		"+1E", "-1E", // a
		"+2A", "+27", "-27", "-2A", // :
		"+1C", "-1C", // CRLF -> one Enter
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %v\nwant %v", got, want)
	}
}

func TestTypeCapsLock(t *testing.T) {
	// With Caps Lock on, "aB1" needs Shift for 'a' only.
	got := typeLog(t, "aB1", true)
	want := []string{"+2A", "+1E", "-1E", "-2A", "+30", "-30", "+02", "-02"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestTypeRejectsNonASCII(t *testing.T) {
	for _, s := range []string{"héllo", "\x01", "€"} {
		if _, err := TextChars(s); err == nil {
			t.Errorf("%q accepted", s)
		}
	}
	if chars, _ := TextChars("a\rb"); string(chars) != "a\rb" {
		t.Errorf("lone CR: %q", string(chars))
	}
}

func TestParseKeys(t *testing.T) {
	cases := map[string][][]int{
		"ctrl+f9":        {{0x1D, 0x43}},
		"CTRL+F9":        {{0x1D, 0x43}},
		"alt+x":          {{0x38, 0x2D}},
		"ctrl+alt+del":   {{0x1D, 0x38, 0xD3}},
		"shift+tab":      {{0x2A, 0x0F}},
		"f1 f10 f11 f12": {{0x3B}, {0x44}, {0x57}, {0x58}},
		"up down left right": {
			{0xC8}, {0xD0}, {0xCB}, {0xCD}},
		"esc enter":     {{0x01}, {0x1C}},
		"ctrl+k ctrl+b": {{0x1D, 0x25}, {0x1D, 0x30}},
		"ctrl+:":        {{0x1D, 0x2A, 0x27}}, // needs Shift
		"shift+:":       {{0x2A, 0x27}},       // no second Shift
		"ctrl++":        {{0x1D, 0x2A, 0x0D}},
		"+":             {{0x2A, 0x0D}},
		"ctrl+plus":     {{0x1D, 0x2A, 0x0D}},
		"rctrl+ralt":    {{0x9D, 0xB8}},
		"kpenter pgdn":  {{0x9C}, {0xD1}},
	}
	for in, want := range cases {
		got, err := ParseKeys(in)
		if err != nil {
			t.Errorf("%q: %v", in, err)
			continue
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %x want %x", in, got, want)
		}
	}
	for _, bad := range []string{"", "hyper+x", "ctrl++x", "f13"} {
		if _, err := ParseKeys(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestDOS83(t *testing.T) {
	for name, want := range map[string]bool{
		"HELLO.TXT": true, "hello.c": true, "TC": true, "A.B.C": false,
		"LONGFILENAME.TXT": false, "X.HTML": false, "a b.c": false, ".x": false,
	} {
		if dos83(name) != want {
			t.Errorf("%q: want %v", name, want)
		}
	}
}
