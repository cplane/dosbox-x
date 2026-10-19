package main

import "testing"

func TestIsPrompt(t *testing.T) {
	for _, tc := range []struct {
		row  string
		x    int
		want bool
	}{
		{"C:\\>", 4, true},
		{"C:\\TCPP>", 8, true},
		{"C:\\>   ", 4, true},
		{"C:\\>dir", 7, false}, // the command typed after it
		{"C:\\>", 2, false},    // cursor not after it
		{"Hello from DOS", 14, false},
		{"", 0, false},
		{"A:\\GAMES\\KEEN>", 14, true},
	} {
		if got := isPrompt(tc.row, tc.x); got != tc.want {
			t.Errorf("isPrompt(%q, %d) = %v, want %v", tc.row, tc.x, got, tc.want)
		}
	}
}

func TestMergeScreenAndOutput(t *testing.T) {
	// A 4-row screen. The command is typed on row 1 (the prompt row).
	prev := []string{"C:\\>dir", "", "C:\\>", ""}
	log := append([]string(nil), prev...)
	cmdRow := 2
	// The command is echoed on the prompt row, output starts below.
	cur := []string{"C:\\>dir", "", "C:\\>ml hello.asm", "Assembling: hello.asm"}
	log = mergeScreen(log, prev, cur)
	if !equalRows(log, cur) {
		t.Fatalf("in-place update: %q", log)
	}
	prev = cur
	// Two more lines: the screen scrolls by 2.
	cur = []string{"C:\\>ml hello.asm", "Assembling: hello.asm", "Linking: hello.com", "C:\\>"}
	log = mergeScreen(log, prev, cur)
	want := []string{"C:\\>dir", "", "C:\\>ml hello.asm", "Assembling: hello.asm", "Linking: hello.com", "C:\\>"}
	if !equalRows(log, want) {
		t.Fatalf("scrolled by 2: %q", log)
	}
	promptRow := len(log) - len(cur) + 3
	if got := runOutput(log, cmdRow, promptRow); got != "Assembling: hello.asm\nLinking: hello.com\n" {
		t.Fatalf("output %q", got)
	}
	// A full-screen scroll (nothing in common) keeps the old screen whole.
	prev = cur
	cur = []string{"x1", "x2", "x3", "C:\\>"}
	log = mergeScreen(log, prev, cur)
	if len(log) != len(want)+4 || log[len(log)-1] != "C:\\>" || log[5] != "C:\\>" {
		t.Fatalf("full scroll: %q", log)
	}
	// No output at all: an empty string, not "\n".
	if got := runOutput([]string{"C:\\>cls", "C:\\>"}, 0, 1); got != "" {
		t.Fatalf("empty output %q", got)
	}
}

func TestConOutput(t *testing.T) {
	for _, tc := range []struct {
		raw, prompt, want string
		complete          bool
	}{
		// echo of the typed command, output, blank line, prompt
		{"ver\r\nDOSBox-X version 2026\r\n\r\nC:\\>", "C:\\>", "DOSBox-X version 2026\n", true},
		// internal command with no output: complete all the same
		{"cd \\TOOLS\r\n\r\nC:\\TOOLS>", "C:\\TOOLS>", "", true},
		// ANSI colours stripped, lone CRs dropped
		{"x\r\n\x1b[1;33mhello\x1b[0m\r\r\n\r\nC:\\>", "C:\\>", "hello\n", true},
		// a program still running: no prompt yet
		{"prog\r\nworking...", "C:\\>", "working...\n", false},
		// nothing after the echo
		{"ver", "C:\\>", "", false},
	} {
		if got, complete := conOutput([]byte(tc.raw), tc.prompt); got != tc.want || complete != tc.complete {
			t.Errorf("conOutput(%q) = %q, %v; want %q, %v", tc.raw, got, complete, tc.want, tc.complete)
		}
	}
}
