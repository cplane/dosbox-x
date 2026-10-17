package main

import (
	"log"
	"time"
)

// InputEvent is one change requested by a browser client.
type InputEvent struct {
	Key     int  // set-1 scancode (0x80|code for E0-extended keys), -1 if none
	Down    bool // key state
	DX, DY  float32
	Buttons int // mouse button mask (bit0 L, bit1 R, bit2 M), -1 if unchanged
}

// InputWriter serializes events into the Game Link input block. DOSBox-X
// only sees the key *state* each time it polls, so every key transition
// is published and then held until DOSBox-X has consumed it; otherwise a
// quick press+release between two polls would be lost.
type InputWriter struct {
	gl     *Gamelink
	events chan InputEvent
	state  InputState
}

func NewInputWriter(gl *Gamelink) *InputWriter {
	return &InputWriter{gl: gl, events: make(chan InputEvent, 512)}
}

func (w *InputWriter) Send(ev InputEvent) {
	select {
	case w.events <- ev:
	default:
		log.Printf("input queue full, dropping %+v", ev)
	}
}

func (w *InputWriter) Run() {
	for ev := range w.events {
		var dx, dy float32
		changed := false
		apply := func(ev InputEvent) {
			if ev.Key >= 0 && ev.Key < 256 {
				word, bit := ev.Key/32, uint32(1)<<(ev.Key%32)
				old := w.state.Keys[word]
				if ev.Down {
					w.state.Keys[word] |= bit
				} else {
					w.state.Keys[word] &^= bit
				}
				changed = changed || old != w.state.Keys[word]
			}
			if ev.Buttons >= 0 && uint8(ev.Buttons) != w.state.Buttons {
				w.state.Buttons = uint8(ev.Buttons)
				changed = true
			}
			dx += ev.DX
			dy += ev.DY
		}
		apply(ev)
		// Coalesce queued pure mouse motion into this write.
		for !changed && len(w.events) > 0 {
			next := <-w.events
			if next.Key >= 0 || next.Buttons >= 0 {
				apply(next)
				break
			}
			apply(next)
		}
		if err := w.gl.WriteInput(w.state, dx, dy); err != nil {
			log.Printf("input: %v", err)
			continue
		}
		if changed {
			w.waitConsumed(100 * time.Millisecond)
		}
	}
}

func (w *InputWriter) waitConsumed(max time.Duration) {
	deadline := time.Now().Add(max)
	for time.Now().Before(deadline) {
		if ok, err := w.gl.Consumed(); err != nil || ok {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
}
