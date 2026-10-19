package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"time"
)

// Agent bridges DOSBox-X's RPC debugger agent (src/agent, JSON-RPC 2.0 as
// UTF-8 JSON Lines over a Unix socket; docs/rpc-agent-usage.md) to the
// browser and to scripts. Only the dosbox-x-debug image runs the agent; with
// the plain image the socket never appears and Available() is false.
//
// Each request gets its own connection: the agent serves every connection
// on a thread of its own, so a blocking execution.wait doesn't hold up a
// state.get_registers from another panel. At most maxInFlight at once.
type Agent struct {
	path       string
	maxMessage int
	sem        chan struct{}
}

func NewAgent(path string) *Agent {
	return &Agent{path: path, maxMessage: 1 << 20, sem: make(chan struct{}, 8)}
}

var errNoAgent = errors.New("no debugger agent (the box doesn't run the debug image)")

func (a *Agent) Available() bool {
	_, err := os.Stat(a.path)
	return err == nil
}

// Call sends one JSON-RPC request (a JSON object, already encoded) and
// returns the agent's response line.
func (a *Agent) Call(ctx context.Context, request []byte) ([]byte, error) {
	if !a.Available() {
		return nil, errNoAgent
	}
	if bytes.ContainsRune(request, '\n') {
		return nil, errors.New("request must be a single line")
	}
	select {
	case a.sem <- struct{}{}:
		defer func() { <-a.sem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", a.path)
	if err != nil {
		return nil, fmt.Errorf("connecting to the agent: %w", err)
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		conn.SetDeadline(dl)
	}
	if _, err := conn.Write(append(append([]byte(nil), request...), '\n')); err != nil {
		return nil, fmt.Errorf("sending to the agent: %w", err)
	}
	r := bufio.NewReaderSize(conn, 64<<10)
	line, err := r.ReadBytes('\n')
	if err != nil && !(errors.Is(err, io.EOF) && len(line) > 0) {
		return nil, fmt.Errorf("reading the agent's response: %w", err)
	}
	if len(line) > a.maxMessage {
		return nil, errors.New("agent response too large")
	}
	return bytes.TrimRight(line, "\r\n"), nil
}

// rpcTimeout bounds a request. execution.wait blocks for the client's own
// timeout_ms, so this must exceed what clients ask for.
const rpcTimeout = 60 * time.Second

// Register adds the HTTP side:
//
//	GET  /agent   {"available": true|false}
//	POST /agent   body: one JSON-RPC 2.0 request; the response as is
func (a *Agent) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /agent", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"available": a.Available()})
	})
	mux.HandleFunc("POST /agent", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, int64(a.maxMessage)+1))
		if err != nil || len(body) == 0 || len(body) > a.maxMessage || !json.Valid(body) {
			httpErr(w, http.StatusBadRequest, errors.New("body must be one JSON-RPC request"))
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), rpcTimeout)
		defer cancel()
		resp, err := a.Call(ctx, bytes.TrimSpace(body))
		if errors.Is(err, errNoAgent) {
			httpErr(w, http.StatusConflict, err)
			return
		} else if err != nil {
			httpErr(w, http.StatusBadGateway, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(resp)
	})
}

// wsRPC answers one {"rpc": <request>} message from the player with a
// {"type":"rpc", ...} text message carrying the agent's response (or an
// error shaped like a JSON-RPC error with the request's id).
func (a *Agent) wsRPC(ctx context.Context, request json.RawMessage) []byte {
	ctx, cancel := context.WithTimeout(ctx, rpcTimeout)
	defer cancel()
	resp, err := a.Call(ctx, bytes.TrimSpace(request))
	if err == nil {
		var out bytes.Buffer
		out.WriteString(`{"type":"rpc","response":`)
		out.Write(resp)
		out.WriteByte('}')
		return out.Bytes()
	}
	var req struct {
		ID json.RawMessage `json:"id"`
	}
	json.Unmarshal(request, &req)
	if len(req.ID) == 0 {
		req.ID = json.RawMessage("null")
	}
	code := -32000
	if errors.Is(err, errNoAgent) {
		code = -32004 // the agent's "capability unavailable"
	}
	b, _ := json.Marshal(map[string]any{"type": "rpc", "response": map[string]any{
		"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": code, "message": err.Error()},
	}})
	return b
}
