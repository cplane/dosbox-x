package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// POST /run: run one command line at the DOS prompt and return what it
// printed, the way a terminal would. The screen is text (the mirror), so
// the output is read straight from it: the command is typed, the screen
// is polled, rows that scroll off are kept, and the run is over when the
// prompt is back on the cursor row and nothing changes any more.
//
//	{"cmd": "ml /AT hello.asm", "timeout_ms": 60000}  (or a text/plain body)
//	-> {"output": "...", "errorlevel": 0, "ms": 1234, "timed_out": false, "prompt": "C:\\>"}
//
// errorlevel is DOS's return code of the last *program* that ended (what
// IF ERRORLEVEL tests); internal commands don't change it. Programs that
// switch to graphics, wait for a key or never return end in a timeout
// with whatever was captured; the screen, /keys and /type take it from
// there.

// A DOS prompt as DOSBox-X draws it with the default $P$G: "C:\>", "C:\DIR>".
var promptRe = regexp.MustCompile(`^[A-Z]:[^>]*>$`)

// isPrompt reports whether row (trailing blanks trimmed) is a prompt with
// the cursor right after it.
func isPrompt(row string, cursorX int) bool {
	row = strings.TrimRight(row, " ")
	return promptRe.MatchString(row) && cursorX == len(row)
}

// screenRows splits a text screen into its rows (trailing blanks trimmed).
func screenRows(t *TextScreen) []string {
	rs := t.runes()
	rows := make([]string, t.Rows)
	for r := 0; r < t.Rows; r++ {
		rows[r] = strings.TrimRight(string(rs[r*t.Cols:(r+1)*t.Cols]), " ")
	}
	return rows
}

// mergeScreen folds a new screen snapshot into the scrollback: log ends
// with the previous snapshot (len(prev) rows). If cur is prev scrolled up
// by k rows, the k rows that left the screen stay in the log. If the
// first row that differs merely grew (text typed or printed on it), the
// visible rows are replaced in place. Anything else (a full-screen
// scroll, cls) keeps the old screen whole and appends the new one.
func mergeScreen(log, prev, cur []string) []string {
	n := len(prev)
	base := log[:len(log)-n]
	for k := 1; k < n; k++ {
		if equalRows(cur[:n-k], prev[k:]) {
			out := append([]string(nil), base...)
			out = append(out, prev[:k]...)
			return append(out, cur...)
		}
	}
	d := 0
	for d < n && cur[d] == prev[d] {
		d++
	}
	if d < n && strings.HasPrefix(cur[d], prev[d]) {
		return append(append([]string(nil), base...), cur...)
	}
	return append(append([]string(nil), log...), cur...)
}

func equalRows(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// runOutput is the text between the command row and the final prompt row
// of the scrollback, without trailing blank lines.
func runOutput(log []string, cmdRow, promptRow int) string {
	if promptRow <= cmdRow+1 || cmdRow < 0 || promptRow > len(log) {
		return ""
	}
	lines := log[cmdRow+1 : promptRow]
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n") + "\n"
}

// ANSI escape sequences (ANSI.SYS colours and cursor moves) in the console stream.
var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)

// conOutput is a command's output as the console stream has it: the bytes
// DOS wrote to CON since the command was typed, without the echo of the
// command line (everything up to the first newline) and the prompt that
// ends the run, trailing blank lines dropped. complete is true when the
// stream shows the whole run, echo through prompt: the output is then
// final even when it is empty.
func conOutput(raw []byte, prompt string) (output string, complete bool) {
	s := ansiRe.ReplaceAllString(string(raw), "")
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "")
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[i+1:]
	} else {
		return "", false
	}
	if prompt != "" && strings.HasSuffix(s, prompt) {
		s = strings.TrimSuffix(s, prompt)
		complete = true
	}
	s = strings.TrimRight(s, "\n")
	if s == "" {
		return "", complete
	}
	return s + "\n", complete
}

type runReq struct {
	Cmd       string `json:"cmd"`
	TimeoutMS int    `json:"timeout_ms"`
}

var errNotAtPrompt = errors.New("DOS is not at a prompt (a program is running, or the screen is in a graphics mode)")

func (c *Control) handleRun(w http.ResponseWriter, r *http.Request) {
	var req runReq
	if strings.Contains(r.Header.Get("Content-Type"), "json") {
		if err := decode(r, &req); err != nil {
			httpErr(w, http.StatusBadRequest, err)
			return
		}
	} else {
		b, err := io.ReadAll(io.LimitReader(r.Body, 4096))
		if err != nil {
			httpErr(w, http.StatusBadRequest, err)
			return
		}
		req.Cmd = string(b)
	}
	req.Cmd = strings.TrimRight(req.Cmd, "\r\n")
	if req.Cmd == "" || strings.ContainsAny(req.Cmd, "\r\n") || len(req.Cmd) > 127 {
		httpErr(w, http.StatusBadRequest, errors.New("cmd: one DOS command line, up to 127 characters"))
		return
	}
	timeout := 60 * time.Second
	if req.TimeoutMS > 0 {
		timeout = min(time.Duration(req.TimeoutMS)*time.Millisecond, 10*time.Minute)
	}
	if c.text == nil {
		httpErr(w, http.StatusServiceUnavailable, errNoText)
		return
	}
	chars, err := TextChars(req.Cmd + "\n")
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	ts, err := c.text.Read()
	if err != nil || ts == nil {
		httpErr(w, http.StatusConflict, errNotAtPrompt)
		return
	}
	prev := screenRows(ts)
	if ts.CursorY >= len(prev) || !isPrompt(prev[ts.CursorY], ts.CursorX) {
		httpErr(w, http.StatusConflict, errNotAtPrompt)
		return
	}
	log := append([]string(nil), prev...)
	cmdRow := ts.CursorY
	prompt := strings.TrimRight(prev[cmdRow], " ")

	// The console stream, when DOSBox-X publishes one, has the output
	// complete; the screen is the fallback (and what direct-video programs
	// leave behind).
	conStart, haveCon := uint64(0), false
	if c.con != nil {
		if p, err := c.con.Pos(); err == nil {
			conStart, haveCon = p, true
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	start := time.Now()
	if _, _, err := c.typeChars(ctx, chars, 20*time.Millisecond, 10*time.Millisecond); err != nil {
		httpErr(w, http.StatusBadGateway, err)
		return
	}

	// Poll until a prompt sits under the cursor on a row after the command
	// (so the echo of the command itself doesn't count) and the screen has
	// been still for a couple of polls.
	const poll = 30 * time.Millisecond
	timedOut := false
	stillFor := 0
	promptRow := -1
	errorlevel := -1
	for {
		if sleepCtx(ctx, poll) != nil {
			timedOut = true
			break
		}
		t, err := c.text.Read()
		if err != nil || t == nil {
			stillFor = 0
			continue // graphics mode, or a torn read: keep waiting
		}
		cur := screenRows(t)
		if len(cur) != len(prev) {
			prev, log = cur, cur // a mode change: start over from this screen
			stillFor = 0
			continue
		}
		if equalRows(cur, prev) {
			stillFor++
		} else {
			log = mergeScreen(log, prev, cur)
			prev = cur
			stillFor = 0
		}
		row := len(log) - len(cur) + t.CursorY
		if t.CursorY < len(cur) && isPrompt(cur[t.CursorY], t.CursorX) && row > cmdRow && stillFor >= 2 {
			promptRow = row
			prompt = strings.TrimRight(cur[t.CursorY], " ")
			errorlevel = t.ErrorLevel
			break
		}
	}
	output, source := "", "screen"
	if promptRow >= 0 {
		output = runOutput(log, cmdRow, promptRow)
	} else {
		output = runOutput(log, cmdRow, len(log))
	}
	lost := false
	if haveCon {
		if raw, l, err := c.con.ReadFrom(conStart); err == nil {
			if o, complete := conOutput(raw, prompt); complete || o != "" || output == "" {
				output, source, lost = o, "con", l
			}
		}
	}
	resp := map[string]any{
		"output": output, "ms": time.Since(start).Milliseconds(), "timed_out": timedOut, "prompt": prompt, "source": source,
	}
	if lost {
		resp["truncated"] = true
	}
	if errorlevel >= 0 {
		resp["errorlevel"] = errorlevel
	}
	writeJSON(w, http.StatusOK, resp)
}

// ensure the JSON decoder is used for the typed body too
var _ = json.Valid
