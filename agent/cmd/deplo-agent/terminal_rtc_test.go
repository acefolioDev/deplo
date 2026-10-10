package main

import (
	"os"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestTerminalRTCDataChannel(t *testing.T) {
	input, output, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	defer output.Close()
	process := &terminalProcess{file: output, stop: make(chan struct{})}
	defer close(process.stop)

	browser, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer browser.Close()
	channel, err := browser.CreateDataChannel("terminal", nil)
	if err != nil {
		t.Fatal(err)
	}
	opened := make(chan struct{})
	received := make(chan string, 1)
	channel.OnOpen(func() { close(opened) })
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		received <- string(message.Data)
	})
	offer, err := browser.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(browser)
	if err := browser.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		t.Fatal("browser candidate gathering timed out")
	}
	answers := make(chan string, 1)
	rtc, err := startTerminalRTC(process, browser.LocalDescription().SDP, func(sdp string) {
		answers <- sdp
	})
	if err != nil {
		t.Fatal(err)
	}
	defer rtc.close()
	select {
	case answer := <-answers:
		if err := browser.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("agent answer timed out")
	}
	select {
	case <-opened:
	case <-time.After(5 * time.Second):
		t.Fatal("direct channel did not open")
	}
	if err := channel.Send([]byte{3}); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 1)
	if _, err := input.Read(got); err != nil || got[0] != 3 {
		t.Fatalf("control input = %v, %v", got, err)
	}
	if !rtc.send([]byte("output")) {
		t.Fatal("agent output was not sent directly")
	}
	select {
	case got := <-received:
		if got != "output" {
			t.Fatalf("output = %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("browser output timed out")
	}
}
