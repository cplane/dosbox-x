package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// A still screen sends nothing for a while; the next small message (a pong)
// must still go out. A write deadline left over from an earlier write used
// to make it fail and drop the connection every ~10 s.
func TestQuietConnectionStaysUp(t *testing.T) {
	old := writeTimeout
	writeTimeout = 200 * time.Millisecond
	t.Cleanup(func() { writeTimeout = old })

	hub := NewHub(nil, 75, 60)
	in := NewInputWriter(nil)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveWS(hub, in, NewAgent(filepath.Join(t.TempDir(), "none.sock")), w, r)
	}))
	defer srv.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.WriteMessage(websocket.TextMessage, []byte(`{"hello":{"text":1}}`))

	// Something is written first (the deadline gets set), then nothing for
	// longer than writeTimeout.
	conn.WriteMessage(websocket.TextMessage, []byte(`{"ping":1}`))
	readPong(t, conn)
	time.Sleep(3 * writeTimeout)
	conn.WriteMessage(websocket.TextMessage, []byte(`{"ping":2}`))
	if got := readPong(t, conn); got != 2 {
		t.Fatalf("pong %v", got)
	}
}

func readPong(t *testing.T, conn *websocket.Conn) float64 {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("connection dropped: %v", err)
		}
		if kind != websocket.TextMessage {
			continue
		}
		var m struct {
			Type string
			T    float64
		}
		if json.Unmarshal(data, &m) == nil && m.Type == "pong" {
			return m.T
		}
	}
}
