package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeAgent answers JSON Lines requests like DOSBox-X's agent transport:
// one line in, one line out, per connection.
func fakeAgent(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.sock")
	l, err := net.Listen("unix", path)
	if err != nil {
		t.Skipf("unix sockets unavailable: %v", err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				r := bufio.NewReader(c)
				for {
					line, err := r.ReadString('\n')
					if err != nil {
						return
					}
					var req struct {
						ID     json.RawMessage `json:"id"`
						Method string          `json:"method"`
					}
					json.Unmarshal([]byte(line), &req)
					if req.Method == "slow" {
						time.Sleep(300 * time.Millisecond)
					}
					resp, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"echo": req.Method}})
					c.Write(append(resp, '\n'))
				}
			}()
		}
	}()
	return path
}

func TestAgentCall(t *testing.T) {
	a := NewAgent(fakeAgent(t))
	if !a.Available() {
		t.Fatal("socket not seen")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp, err := a.Call(ctx, []byte(`{"jsonrpc":"2.0","id":7,"method":"agent.capabilities","params":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(resp), `"echo":"agent.capabilities"`) || !strings.Contains(string(resp), `"id":7`) {
		t.Fatalf("response %s", resp)
	}

	// Two calls at once use two connections: the slow one doesn't delay the other.
	done := make(chan time.Duration, 2)
	for _, m := range []string{"slow", "fast"} {
		go func(m string) {
			t0 := time.Now()
			a.Call(ctx, []byte(`{"jsonrpc":"2.0","id":"`+m+`","method":"`+m+`"}`))
			done <- time.Since(t0)
		}(m)
	}
	d1, d2 := <-done, <-done
	if min(d1, d2) > 200*time.Millisecond {
		t.Fatalf("calls serialized: %v %v", d1, d2)
	}

	// The WebSocket shape, and the error shape without an agent.
	msg := a.wsRPC(ctx, json.RawMessage(`{"jsonrpc":"2.0","id":3,"method":"x"}`))
	if !strings.HasPrefix(string(msg), `{"type":"rpc","response":{`) || !strings.Contains(string(msg), `"id":3`) {
		t.Fatalf("ws message %s", msg)
	}
	none := NewAgent(filepath.Join(t.TempDir(), "none.sock"))
	msg = none.wsRPC(ctx, json.RawMessage(`{"jsonrpc":"2.0","id":4,"method":"x"}`))
	var out struct {
		Type     string
		Response struct {
			ID    int
			Error struct {
				Code    int
				Message string
			}
		}
	}
	if json.Unmarshal(msg, &out) != nil || out.Response.ID != 4 || out.Response.Error.Code != -32004 ||
		!strings.Contains(out.Response.Error.Message, "no debugger agent") {
		t.Fatalf("no-agent message %s", msg)
	}
}
