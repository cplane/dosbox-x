package main

import "testing"

func TestConBroadcast(t *testing.T) {
	h := NewHub(nil, 75, 60)
	c := h.add()
	defer h.remove(c)
	// Not subscribed: nothing arrives.
	h.broadcastCon([]byte("x"), false)
	if len(c.conOut) != 0 {
		t.Fatal("chunk before hello")
	}
	h.subscribeCon(c, []byte("tail"))
	h.broadcastCon([]byte("abc"), false)
	if got := string(<-c.conOut); got != "C\x01\x00tail" {
		t.Fatalf("tail frame %q", got)
	}
	if got := string(<-c.conOut); got != "C\x01\x00abc" {
		t.Fatalf("chunk frame %q", got)
	}
	// A full queue drops chunks; the next delivered one says so.
	for i := 0; i < cap(c.conOut)+5; i++ {
		h.broadcastCon([]byte("f"), false)
	}
	for len(c.conOut) > 0 {
		<-c.conOut
	}
	h.broadcastCon([]byte("z"), false)
	if got := string(<-c.conOut); got != "C\x01\x01z" {
		t.Fatalf("after overrun %q", got)
	}
}
