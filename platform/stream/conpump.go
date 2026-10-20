package main

import (
	"sync"
	"time"
)

// The console stream over the player socket: a client that says
// {"hello":{"con":1}} gets what DOS writes to CON as it happens, so a
// terminal in the browser shows a program's output while it runs, not
// when it ends (/run). A binary message is one chunk:
//
//	"C" 1 flags:u8 bytes...   flags bit 0: bytes were lost before these
//	                          (the ring or the client's queue overran)
//
// On hello the client first gets the last few KB, so the terminal opens
// with the recent history instead of blank.
const conTail = 8192

type ConPump struct {
	hub *Hub
	con *ConStream
	mu  sync.Mutex
	pos uint64 // the stream position everything up to which was forwarded
	ok  bool   // pos is valid (the stream has been seen)
}

func NewConPump(hub *Hub, con *ConStream) *ConPump { return &ConPump{hub: hub, con: con} }

func conFrame(data []byte, lost bool) []byte {
	b := make([]byte, 3+len(data))
	b[0], b[1] = 'C', 1
	if lost {
		b[2] = 1
	}
	copy(b[3:], data)
	return b
}

// Run polls the stream and forwards new bytes to the clients that want them.
func (p *ConPump) Run() {
	t := time.NewTicker(16 * time.Millisecond)
	defer t.Stop()
	for range t.C {
		p.mu.Lock()
		if !p.ok {
			// Start from now: what came before is history (the hello tail).
			if pos, err := p.con.Pos(); err == nil {
				p.pos, p.ok = pos, true
			}
			p.mu.Unlock()
			continue
		}
		raw, next, lost, err := p.con.ReadFrom(p.pos)
		if err == nil {
			p.pos = next
		}
		p.mu.Unlock()
		if err != nil || len(raw) == 0 {
			continue
		}
		p.hub.broadcastCon(raw, lost)
	}
}

// wantCon subscribes c and sends it the recent tail of the stream first.
func (p *ConPump) wantCon(c *client) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var tail []byte
	if p.ok {
		start := uint64(0)
		if p.pos > conTail {
			start = p.pos - conTail
		}
		if raw, _, _, err := p.con.ReadFrom(start); err == nil {
			tail = raw
		}
	}
	p.hub.subscribeCon(c, tail)
}

// subscribeCon marks c as wanting the console stream, with its history.
func (h *Hub) subscribeCon(c *client, tail []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	c.con = true
	if len(tail) > 0 {
		select {
		case c.conOut <- conFrame(tail, false):
		default:
		}
	}
}

// broadcastCon hands a chunk to every subscribed client; one whose queue
// is full drops it and is told so with the next chunk it gets.
func (h *Hub) broadcastCon(data []byte, lost bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		if !c.con {
			continue
		}
		select {
		case c.conOut <- conFrame(data, lost || c.conLost):
			c.conLost = false
		default:
			c.conLost = true
		}
	}
}
