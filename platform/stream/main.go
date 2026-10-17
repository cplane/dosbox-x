// Command stream is the dos-box sidecar: it streams DOSBox-X frames from
// Game Link shared memory to browsers over WebSocket (JPEG) and feeds
// keyboard/mouse input from the browser back into Game Link.
//
// Endpoints:
//
//	GET /             test player page
//	GET /ws           WebSocket: server->client binary JPEG frames and text
//	                  {"type":"meta",...}; client->server text JSON
//	                  {"k":<scancode>,"d":true|false} key down/up,
//	                  {"m":[dx,dy]} relative mouse, {"b":<mask>} buttons
//	GET /snapshot.jpg latest frame
//	GET /healthz      200 once frames are flowing
package main

import (
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/gorilla/websocket"
)

//go:embed web
var webFS embed.FS

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil && v > 0 {
		return v
	}
	return def
}

func main() {
	gl := NewGamelink(env("GAMELINK_SHM", "/dev/shm/DWD_GAMELINK_MMAP_R4"))
	hub := NewHub(gl, envInt("JPEG_QUALITY", 80), envInt("MAX_FPS", 30))
	in := NewInputWriter(gl)
	go hub.Run()
	go in.Run()

	web, _ := fs.Sub(webFS, "web")
	mux := http.NewServeMux()
	mux.Handle("GET /", http.FileServerFS(web))
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) { serveWS(hub, in, w, r) })
	mux.HandleFunc("GET /snapshot.jpg", func(w http.ResponseWriter, r *http.Request) {
		jpg, _ := hub.Latest()
		if jpg == nil {
			http.Error(w, "no frame yet", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(jpg)
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if _, at := hub.Latest(); time.Since(at) > 10*time.Second {
			http.Error(w, "no recent frames", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok\n"))
	})

	addr := env("LISTEN", ":8080")
	log.Printf("dos-box stream listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

var upgrader = websocket.Upgrader{ReadBufferSize: 1024, WriteBufferSize: 64 * 1024}

type clientMsg struct {
	K *int        `json:"k"`
	D bool        `json:"d"`
	M *[2]float32 `json:"m"`
	B *int        `json:"b"`
}

func serveWS(hub *Hub, in *InputWriter, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	c := hub.add()
	defer hub.remove(c)
	log.Printf("client %s connected", r.RemoteAddr)

	// Release whatever this client still holds when it goes away, so a
	// dropped connection doesn't leave a key stuck down in DOS.
	pressed := map[int]bool{}
	held := 0
	defer func() {
		for k := range pressed {
			in.Send(InputEvent{Key: k, Down: false, Buttons: -1})
		}
		if held != 0 {
			in.Send(InputEvent{Key: -1, Buttons: 0})
		}
		log.Printf("client %s disconnected", r.RemoteAddr)
	}()

	done := make(chan struct{})
	go func() {
		defer close(done)
		ping := time.NewTicker(30 * time.Second)
		defer ping.Stop()
		for {
			var err error
			select {
			case m := <-c.meta:
				err = conn.WriteMessage(websocket.TextMessage, m)
			case f := <-c.frames:
				conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				err = conn.WriteMessage(websocket.BinaryMessage, f)
			case <-ping.C:
				err = conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
			}
			if err != nil {
				conn.Close()
				return
			}
		}
	}()

	conn.SetReadLimit(4096)
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		var m clientMsg
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch {
		case m.K != nil && *m.K > 0 && *m.K < 256:
			if m.D {
				pressed[*m.K] = true
			} else {
				delete(pressed, *m.K)
			}
			in.Send(InputEvent{Key: *m.K, Down: m.D, Buttons: -1})
		case m.M != nil:
			in.Send(InputEvent{Key: -1, DX: m.M[0], DY: m.M[1], Buttons: -1})
		case m.B != nil:
			held = *m.B & 7
			in.Send(InputEvent{Key: -1, Buttons: held})
		}
	}
	conn.Close()
	<-done
}
