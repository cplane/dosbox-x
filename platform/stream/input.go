package main

import (
	"context"
	"log"
	"time"
)

// InputEvent is one change requested by a browser client or the control API.
type InputEvent struct {
	Key     int  // set-1 scancode (0x80|code for E0-extended keys), -1 if none
	Down    bool // key state
	DX, DY  float32
	Buttons int // mouse button mask (bit0 L, bit1 R, bit2 M), -1 if unchanged

	// Done, if set, makes this a barrier: it carries no input and is closed
	// once every event queued before it has been published (and consumed,
	// or timed out waiting for DOSBox-X).
	Done chan struct{}
}

// InputWriter serializes events into the Game Link input block. DOSBox-X
// only sees the key *state* each time it polls, so every key transition
// is published and then held until DOSBox-X has consumed it; otherwise a
// quick press+release between two polls would be lost. DOSBox-X also
// holds the block unconsumed (up to 1 s) while its keyboard queue is
// nearly full, so waiting here is the back-pressure that keeps a slow
// guest from losing keys.
type InputWriter struct {
	gl     *Gamelink
	events chan InputEvent
	state  InputState
}

func NewInputWriter(gl *Gamelink) *InputWriter {
	return &InputWriter{gl: gl, events: make(chan InputEvent, 512)}
}

// Send queues ev without blocking (browser input); it is dropped if the
// queue is full.
func (w *InputWriter) Send(ev InputEvent) {
	select {
	case w.events <- ev:
	default:
		log.Printf("input queue full, dropping %+v", ev)
	}
}

// SendWait queues events, blocking while the queue is full, and returns
// once all of them have been delivered to DOSBox-X.
func (w *InputWriter) SendWait(ctx context.Context, evs ...InputEvent) error {
	for _, ev := range evs {
		select {
		case w.events <- ev:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	done := make(chan struct{})
	select {
	case w.events <- InputEvent{Key: -1, Buttons: -1, Done: done}:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (w *InputWriter) Run() {
	for ev := range w.events {
		if ev.Done != nil {
			close(ev.Done)
			continue
		}
		var dx, dy float32
		var barrier chan struct{}
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
			if next.Done != nil {
				barrier = next.Done
				break
			}
			apply(next)
			if next.Key >= 0 || next.Buttons >= 0 {
				break
			}
		}
		if err := w.gl.WriteInput(w.state, dx, dy); err != nil {
			log.Printf("input: %v", err)
		} else if changed {
			w.waitConsumed(2 * time.Second)
		}
		if barrier != nil {
			close(barrier)
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
