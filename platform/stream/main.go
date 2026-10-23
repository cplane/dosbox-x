// Command stream is the dos-box sidecar: it streams DOSBox-X frames from
// Game Link shared memory to browsers over WebSocket (JPEG) and feeds
// keyboard/mouse input from the browser back into Game Link.
//
// Endpoints:
//
//	GET /             test player page
//	GET /ws           WebSocket: server->client binary strip updates (hub.go)
//	                  and text
//	                  {"type":"meta",...}; client->server text JSON
//	                  {"k":<scancode>,"d":true|false} key down/up,
//	                  {"m":[dx,dy]} relative mouse, {"a":[x,y]} absolute mouse
//	                  (0..1 across the frame), {"b":<mask>} buttons,
//	                  {"ack":1} per frame drawn (enables flow control: at most
//	                  FRAME_WINDOW frames in flight), {"ping":t} -> text
//	                  {"type":"pong","t":t,"encodeMs":…,"fps":…}
//	GET /snapshot.jpg latest frame
//	GET /healthz      200 once frames are flowing
//
// Control API for agents and scripts (control.go): POST /type, /keys,
// /mouse, /click, /rescan; GET /snapshot.png; GET|PUT /files/<path>.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync"
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
	hub := NewHub(gl, envInt("JPEG_QUALITY", 75), envInt("MAX_FPS", 60))
	hub.text = NewTextMirror(env("GAMELINK_TEXT", "/dev/shm/DWD_GAMELINK_TEXT_R1"))
	con := NewConStream(env("GAMELINK_CON", "/dev/shm/DWD_GAMELINK_CON_R1"))
	frameWindow = envInt("FRAME_WINDOW", 3)
	in := NewInputWriter(gl)
	go hub.Run()
	go in.Run()
	agent := NewAgent(env("AGENT_SOCK", "/dev/shm/dosbox-agent.sock"))
	pump := NewConPump(hub, con)
	go pump.Run()
	heat := NewHeatPump(hub, env("GAMELINK_HEAT", "/dev/shm/DWD_GAMELINK_HEAT_R1"))
	go heat.Run()
	mem := NewMemPump(hub, env("GAMELINK_MEM", "/dev/shm/DWD_GAMELINK_MEM_R1"))
	go mem.Run()
	ctl := &Control{
		gl:        gl,
		in:        in,
		text:      hub.text,
		con:       con,
		dataDir:   env("DATA_DIR", "/data/c"),
		maxUpload: int64(envInt("MAX_UPLOAD_MB", 512)) << 20,
	}

	web, _ := fs.Sub(webFS, "web")
	mux := http.NewServeMux()
	mux.Handle("GET /", http.FileServerFS(web))
	ctl.Register(mux)
	agent.Register(mux)
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) { serveWS(hub, in, agent, pump, w, r) })
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
	// The text screen, 409 in graphics modes (headers: X-Text-Size,
	// X-Codepage, X-Cursor "col,row" 0-based when visible):
	//   /screen.txt   UTF-8 text (DOS codepage decoded), one line per row
	//   /screen.ansi  the same with 24-bit colour escapes, for a terminal
	//   /screen.json  per cell: text, fg, bg, blink; palette; cursor
	screen := func(render func(http.ResponseWriter, *TextScreen)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			t, err := hub.Screen()
			if err != nil || t == nil {
				http.Error(w, "the screen is not in a text mode", http.StatusConflict)
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Text-Size", fmt.Sprintf("%dx%d", t.Cols, t.Rows))
			w.Header().Set("X-Codepage", strconv.Itoa(int(t.Codepage)))
			if t.Flags&txtCursorVisible != 0 {
				w.Header().Set("X-Cursor", fmt.Sprintf("%d,%d", t.CursorX, t.CursorY))
			}
			render(w, t)
		}
	}
	mux.HandleFunc("GET /screen.txt", screen(func(w http.ResponseWriter, t *TextScreen) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(w, t.Text())
	}))
	mux.HandleFunc("GET /screen.ansi", screen(func(w http.ResponseWriter, t *TextScreen) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(w, t.ANSI())
	}))
	mux.HandleFunc("GET /screen.json", screen(func(w http.ResponseWriter, t *TextScreen) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(t.JSON())
	}))
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
	K     *int        `json:"k"`
	D     bool        `json:"d"`
	M     *[2]float32 `json:"m"`
	A     *[2]float32 `json:"a"`
	B     *int        `json:"b"`
	Ack   *int        `json:"ack"`
	Ping  *float64    `json:"ping"`
	Hello *struct {
		Text int `json:"text"`
		Con  int `json:"con"` // the console stream too (conpump.go)
	} `json:"hello"`
	// Live heat (heat.go): 1 to get the ticks, 0 to stop.
	Heat *int `json:"heat"`
	// Live memory (mem.go): the 4 KB tiles to watch, the most wanted first; [] to stop.
	Mem *[]uint16 `json:"mem"`
	// RPC: a JSON-RPC request for the debugger agent (agent.go); answered
	// with {"type":"rpc","response":…}.
	RPC json.RawMessage `json:"rpc"`
}

// frameWindow is how many frames may be on their way to a client that acks
// them. A slow or stalled link then holds a few frames, not seconds of them:
// while the window is full, the frame waiting to go is replaced by newer ones.
var frameWindow = 3

// writeTimeout bounds each write to a client (a stuck link is dropped).
var writeTimeout = 10 * time.Second

func serveWS(hub *Hub, in *InputWriter, agent *Agent, pump *ConPump, w http.ResponseWriter, r *http.Request) {
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

	acks := make(chan int, 64)
	// The first update waits briefly for the client's hello: one that draws
	// text then gets text right away, not a full screen of strips first.
	hello := make(chan struct{})
	var helloOnce sync.Once
	pongs := make(chan []byte, 8)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ping := time.NewTicker(30 * time.Second)
		defer ping.Stop()
		select {
		case <-hello:
		case <-time.After(250 * time.Millisecond):
		}
		// Every write gets its own deadline: one left over from an earlier
		// write would make a later one (a pong on a still screen) fail.
		write := func(kind int, b []byte) error {
			conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			return conn.WriteMessage(kind, b)
		}
		dirty := false // the hub has strips this client still needs
		flow, inFlight := false, 0
		for {
			var err error
			if dirty && (!flow || inFlight < frameWindow) {
				dirty = false
				if msg := hub.take(c); msg != nil {
					err = write(websocket.BinaryMessage, msg)
					inFlight++
				}
			} else {
				select {
				case m := <-c.meta:
					err = write(websocket.TextMessage, m)
				case <-c.notify:
					dirty = true
				case n := <-acks:
					if !flow {
						flow, inFlight = true, 0 // the client acks: count from here
					} else if inFlight -= n; inFlight < 0 {
						inFlight = 0
					}
					dirty = true // strips may have piled up while the window was full
				case p := <-pongs:
					err = write(websocket.TextMessage, p)
				case b := <-c.conOut:
					err = write(websocket.BinaryMessage, b)
				case b := <-c.heatOut:
					err = write(websocket.BinaryMessage, b)
				case b := <-c.memOut:
					err = write(websocket.BinaryMessage, b)
				case <-ping.C:
					err = conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
				}
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
		case m.A != nil:
			in.Send(InputEvent{Key: -1, Buttons: -1, Abs: true, X: m.A[0], Y: m.A[1]})
		case m.M != nil:
			in.Send(InputEvent{Key: -1, DX: m.M[0], DY: m.M[1], Buttons: -1})
		case m.B != nil:
			held = *m.B & 7
			in.Send(InputEvent{Key: -1, Buttons: held})
		case m.Ack != nil:
			select {
			case acks <- max(*m.Ack, 1):
			default:
			}
		case m.Ping != nil:
			enc, fps := hub.Stats()
			p, _ := json.Marshal(map[string]any{"type": "pong", "t": *m.Ping, "encodeMs": enc, "fps": fps})
			select {
			case pongs <- p:
			default:
			}
		case len(m.RPC) > 0:
			go func(req json.RawMessage) {
				select {
				case pongs <- agent.wsRPC(context.Background(), req):
				case <-done:
				}
			}(m.RPC)
		case m.Hello != nil:
			if m.Hello.Text != 0 {
				hub.wantText(c)
			}
			if m.Hello.Con != 0 {
				pump.wantCon(c)
			}
			helloOnce.Do(func() { close(hello) })
		case m.Heat != nil:
			hub.setHeat(c, *m.Heat != 0)
		case m.Mem != nil:
			hub.setMem(c, *m.Mem)
		}
	}
	conn.Close()
	<-done
}
