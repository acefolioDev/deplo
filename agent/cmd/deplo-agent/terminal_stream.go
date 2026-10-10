package main

import (
	"context"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

type terminalFrame struct {
	Type      string    `json:"type"`
	SessionID string    `json:"sessionId,omitempty"`
	Data      string    `json:"data,omitempty"`
	SDP       string    `json:"sdp,omitempty"`
	ExpiresAt time.Time `json:"expiresAt,omitempty"`
	Cols      uint16    `json:"cols,omitempty"`
	Rows      uint16    `json:"rows,omitempty"`
	Nonce     int64     `json:"nonce,omitempty"`
	ShellUser string    `json:"shellUser,omitempty"`
}

var errTerminalRelayUnavailable = errors.New("terminal websocket relay unavailable")
var errTerminalCredentialRevoked = errors.New("terminal credential revoked")

func (a *api) runTerminalTransport(ctx context.Context, logger *slog.Logger) {
	state := &terminalState{processes: make(map[string]*terminalProcess), rtcs: make(map[string]*terminalRTC)}
	defer state.closeAll()
	for ctx.Err() == nil {
		err := a.runTerminalSocket(ctx, state)
		if errors.Is(err, errTerminalCredentialRevoked) {
			logger.Warn("terminal websocket credential revoked")
			return
		}
		if errors.Is(err, errTerminalRelayUnavailable) {
			logger.Info("terminal websocket relay not configured; using HTTP transport")
			state.closeAll()
			a.runTerminal(ctx, logger)
			return
		}
		if ctx.Err() != nil {
			return
		}
		logger.Warn("terminal websocket disconnected; reconnecting", "error", err)
		if !terminalWait(ctx, 500*time.Millisecond) {
			return
		}
	}
}

type terminalState struct {
	mu        sync.Mutex
	processes map[string]*terminalProcess
	rtcs      map[string]*terminalRTC
}

func (s *terminalState) closeAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, rtc := range s.rtcs {
		rtc.close()
		delete(s.rtcs, id)
	}
	for id, process := range s.processes {
		process.close()
		delete(s.processes, id)
	}
}

func (s *terminalState) get(id string) (*terminalProcess, *terminalRTC) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.processes[id], s.rtcs[id]
}

func (s *terminalState) remove(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rtc := s.rtcs[id]; rtc != nil {
		rtc.close()
		delete(s.rtcs, id)
	}
	if process := s.processes[id]; process != nil {
		process.close()
		delete(s.processes, id)
	}
}

func (a *api) runTerminalSocket(ctx context.Context, state *terminalState) error {
	endpoint, err := url.Parse(a.cfg.URL)
	if err != nil {
		return err
	}
	if endpoint.Scheme == "https" {
		endpoint.Scheme = "wss"
	} else {
		endpoint.Scheme = "ws"
	}
	endpoint.Path = "/api/terminal/ws"
	endpoint.RawQuery = "role=agent"
	requestHeaders := http.Header{}
	requestHeaders.Set("Authorization", "Bearer "+a.identity.Credential)
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, response, err := dialer.DialContext(ctx, endpoint.String(), requestHeaders)
	if err != nil {
		if response != nil && response.StatusCode == 401 {
			return errTerminalCredentialRevoked
		}
		if response != nil && (response.StatusCode == 503 || response.StatusCode == 404) {
			return errTerminalRelayUnavailable
		}
		return err
	}
	defer conn.Close()
	conn.SetReadLimit(65536)
	defer func() {
		state.mu.Lock()
		for id, rtc := range state.rtcs {
			rtc.close()
			delete(state.rtcs, id)
		}
		state.mu.Unlock()
	}()
	frames := make(chan terminalFrame, 128)
	incoming := make(chan terminalFrame, 32)
	errorsFromSocket := make(chan error, 2)
	stop := make(chan struct{})
	var pumps sync.WaitGroup
	pumpStops := make(map[string]chan struct{})
	stopPump := func(id string) {
		if done := pumpStops[id]; done != nil {
			close(done)
			delete(pumpStops, id)
		}
	}
	startPump := func(process *terminalProcess) {
		if pumpStops[process.id] != nil {
			return
		}
		pumpStop := make(chan struct{})
		pumpStops[process.id] = pumpStop
		pumps.Add(1)
		go func() {
			defer pumps.Done()
			for {
				select {
				case <-pumpStop:
					return
				case chunk := <-process.output:
					if len(chunk) == 0 {
						continue
					}
					for len(chunk) < 6144 {
						select {
						case more := <-process.output:
							chunk = append(chunk, more...)
						default:
							goto sendChunk
						}
					}
				sendChunk:
					_, rtc := state.get(process.id)
					if rtc == nil || !rtc.send(chunk) {
						select {
						case frames <- terminalFrame{Type: "output", SessionID: process.id, Data: base64.StdEncoding.EncodeToString(chunk)}:
						case <-stop:
							return
						}
					}
				}
			}
		}()
	}
	defer func() {
		close(stop)
		for id := range pumpStops {
			stopPump(id)
		}
		pumps.Wait()
	}()
	go func() {
		for {
			select {
			case <-stop:
				return
			case frame := <-frames:
				if err := conn.WriteJSON(frame); err != nil {
					select {
					case errorsFromSocket <- err:
					default:
					}
					return
				}
			}
		}
	}()
	go func() {
		for {
			var frame terminalFrame
			if err := conn.ReadJSON(&frame); err != nil {
				select {
				case errorsFromSocket <- err:
				default:
				}
				return
			}
			select {
			case incoming <- frame:
			case <-stop:
				return
			}
		}
	}()
	maintenance := time.NewTicker(time.Second)
	defer maintenance.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-errorsFromSocket:
			return err
		case <-maintenance.C:
			state.mu.Lock()
			for id, process := range state.processes {
				expired := !time.Now().Before(process.expiresAt)
				finished := false
				select {
				case <-process.done:
					select {
					case <-process.readerDone:
						finished = len(process.output) == 0
					default:
					}
				default:
				}
				if expired || finished {
					if rtc := state.rtcs[id]; rtc != nil {
						rtc.close()
						delete(state.rtcs, id)
					}
					process.close()
					delete(state.processes, id)
					stopPump(id)
					select {
					case frames <- terminalFrame{Type: "closed", SessionID: id}:
					default:
					}
				}
			}
			state.mu.Unlock()
		case frame := <-incoming:
			switch frame.Type {
			case "open":
				if frame.SessionID == "" || frame.ExpiresAt.Before(time.Now()) ||
					frame.Cols < 20 || frame.Cols > 300 || frame.Rows < 5 || frame.Rows > 100 {
					continue
				}
				process, _ := state.get(frame.SessionID)
				if process == nil {
					process, startErr := startTerminal(terminalSession{
						ID: frame.SessionID, ExpiresAt: frame.ExpiresAt,
						Cols: frame.Cols, Rows: frame.Rows, ShellUser: frame.ShellUser,
					})
					if startErr != nil {
						frames <- terminalFrame{Type: "closed", SessionID: frame.SessionID}
						continue
					}
					state.mu.Lock()
					state.processes[frame.SessionID] = process
					state.mu.Unlock()
				}
				startPump(process)
				frames <- terminalFrame{Type: "started", SessionID: frame.SessionID}
			case "input":
				process, _ := state.get(frame.SessionID)
				if process == nil {
					continue
				}
				input, decodeErr := base64.StdEncoding.DecodeString(frame.Data)
				if decodeErr == nil && len(input) > 0 && len(input) <= 4096 {
					_, _ = process.file.Write(input)
				}
			case "resize":
				process, _ := state.get(frame.SessionID)
				if process == nil ||
					frame.Cols < 20 || frame.Cols > 300 || frame.Rows < 5 || frame.Rows > 100 {
					continue
				}
				if err := pty.Setsize(process.file, &pty.Winsize{Cols: frame.Cols, Rows: frame.Rows}); err == nil {
					process.cols, process.rows = frame.Cols, frame.Rows
				}
			case "close":
				stopPump(frame.SessionID)
				state.remove(frame.SessionID)
			case "rtc-offer":
				process, oldRTC := state.get(frame.SessionID)
				if process == nil || len(frame.SDP) == 0 || len(frame.SDP) > 32000 {
					continue
				}
				if oldRTC != nil {
					oldRTC.close()
				}
				sessionID := frame.SessionID
				candidate, rtcErr := startTerminalRTC(process, frame.SDP, func(sdp string) {
					select {
					case frames <- terminalFrame{Type: "rtc-answer", SessionID: sessionID, SDP: sdp}:
					case <-stop:
					}
				})
				if rtcErr == nil {
					state.mu.Lock()
					state.rtcs[sessionID] = candidate
					state.mu.Unlock()
				}
			case "ping":
				if process, _ := state.get(frame.SessionID); process != nil {
					frames <- terminalFrame{Type: "pong", SessionID: frame.SessionID, Nonce: frame.Nonce}
				}
			}
		}
	}
}
