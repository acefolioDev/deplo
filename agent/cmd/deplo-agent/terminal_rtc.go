package main

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// A data channel is an optional LAN path. The WebSocket remains connected for
// authorization, session control, and fallback when a direct path is unavailable.
type terminalRTC struct {
	peer    *webrtc.PeerConnection
	mu      sync.RWMutex
	channel *webrtc.DataChannel
	done    chan struct{}
	once    sync.Once
}

func startTerminalRTC(process *terminalProcess, offer string, answer func(string)) (*terminalRTC, error) {
	peer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, err
	}
	rtc := &terminalRTC{peer: peer, done: make(chan struct{})}
	peer.OnDataChannel(func(channel *webrtc.DataChannel) {
		if channel.Label() != "terminal" {
			_ = channel.Close()
			return
		}
		rtc.mu.Lock()
		rtc.channel = channel
		rtc.mu.Unlock()
		channel.OnMessage(func(message webrtc.DataChannelMessage) {
			select {
			case <-process.stop:
				return
			default:
			}
			if message.IsString {
				value := string(message.Data)
				if strings.HasPrefix(value, "ping:") {
					if _, err := strconv.ParseInt(strings.TrimPrefix(value, "ping:"), 10, 64); err == nil {
						_ = channel.SendText("pong:" + strings.TrimPrefix(value, "ping:"))
					}
				}
				return
			}
			if len(message.Data) > 0 && len(message.Data) <= 4096 {
				_, _ = process.file.Write(message.Data)
			}
		})
	})
	if err = peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		_ = peer.Close()
		return nil, err
	}
	local, err := peer.CreateAnswer(nil)
	if err != nil {
		_ = peer.Close()
		return nil, err
	}
	complete := webrtc.GatheringCompletePromise(peer)
	if err = peer.SetLocalDescription(local); err != nil {
		_ = peer.Close()
		return nil, err
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		select {
		case <-complete:
			if description := peer.LocalDescription(); description != nil {
				answer(description.SDP)
			}
		case <-ctx.Done():
		case <-process.stop:
		case <-rtc.done:
		}
	}()
	return rtc, nil
}

func (rtc *terminalRTC) send(chunk []byte) bool {
	if rtc == nil {
		return false
	}
	rtc.mu.RLock()
	channel := rtc.channel
	rtc.mu.RUnlock()
	if channel == nil || channel.ReadyState() != webrtc.DataChannelStateOpen || channel.BufferedAmount() > 1_000_000 {
		return false
	}
	return channel.Send(chunk) == nil
}

func (rtc *terminalRTC) close() {
	if rtc != nil && rtc.peer != nil {
		rtc.once.Do(func() {
			close(rtc.done)
			_ = rtc.peer.Close()
		})
	}
}
