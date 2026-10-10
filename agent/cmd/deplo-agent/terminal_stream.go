package main

import (
	"context"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

type terminalFrame struct {
	Type      string    `json:"type"`
	SessionID string    `json:"sessionId,omitempty"`
	Data      string    `json:"data,omitempty"`
	ExpiresAt time.Time `json:"expiresAt,omitempty"`
	Cols      uint16    `json:"cols,omitempty"`
	Rows      uint16    `json:"rows,omitempty"`
	Nonce     int64     `json:"nonce,omitempty"`
}

var errTerminalRelayUnavailable = errors.New("terminal websocket relay unavailable")
var errTerminalCredentialRevoked = errors.New("terminal credential revoked")

func (a *api) runTerminalTransport(ctx context.Context, logger *slog.Logger) {
	var current *terminalProcess
	defer func() { current.close() }()
	for ctx.Err() == nil {
		err := a.runTerminalSocket(ctx, &current)
		if errors.Is(err, errTerminalCredentialRevoked) {
			logger.Warn("terminal websocket credential revoked")
			return
		}
		if errors.Is(err, errTerminalRelayUnavailable) {
			logger.Info("terminal websocket relay not configured; using HTTP transport")
			current.close()
			current = nil
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

func (a *api) runTerminalSocket(ctx context.Context, current **terminalProcess) error {
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
	conn.SetReadLimit(16384)
	frames := make(chan terminalFrame, 128)
	incoming := make(chan terminalFrame, 32)
	errorsFromSocket := make(chan error, 2)
	stop := make(chan struct{})
	defer close(stop)
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
	for {
		if *current != nil && !time.Now().Before((*current).expiresAt) {
			(*current).close()
			*current = nil
		}
		var output <-chan []byte
		if *current != nil && len(frames) < cap(frames)-4 {
			output = (*current).output
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-errorsFromSocket:
			return err
		case frame := <-incoming:
			switch frame.Type {
			case "open":
				if frame.SessionID == "" || frame.ExpiresAt.Before(time.Now()) ||
					frame.Cols < 20 || frame.Cols > 300 || frame.Rows < 5 || frame.Rows > 100 {
					continue
				}
				if *current != nil && (*current).id != frame.SessionID {
					(*current).close()
					*current = nil
				}
				if *current == nil {
					process, startErr := startTerminal(terminalSession{
						ID: frame.SessionID, ExpiresAt: frame.ExpiresAt,
						Cols: frame.Cols, Rows: frame.Rows,
					})
					if startErr != nil {
						frames <- terminalFrame{Type: "closed", SessionID: frame.SessionID}
						continue
					}
					*current = process
				}
				frames <- terminalFrame{Type: "started", SessionID: frame.SessionID}
			case "input":
				if *current == nil || (*current).id != frame.SessionID {
					continue
				}
				input, decodeErr := base64.StdEncoding.DecodeString(frame.Data)
				if decodeErr == nil && len(input) > 0 && len(input) <= 4096 {
					_, _ = (*current).file.Write(input)
				}
			case "resize":
				if *current == nil || (*current).id != frame.SessionID ||
					frame.Cols < 20 || frame.Cols > 300 || frame.Rows < 5 || frame.Rows > 100 {
					continue
				}
				if err := pty.Setsize((*current).file, &pty.Winsize{Cols: frame.Cols, Rows: frame.Rows}); err == nil {
					(*current).cols, (*current).rows = frame.Cols, frame.Rows
				}
			case "close":
				if *current != nil && (*current).id == frame.SessionID {
					(*current).close()
					*current = nil
				}
			case "ping":
				if *current != nil && (*current).id == frame.SessionID {
					frames <- terminalFrame{Type: "pong", SessionID: frame.SessionID, Nonce: frame.Nonce}
				}
			}
		case chunk := <-output:
			for len(chunk) < 6144 {
				select {
				case more := <-output:
					chunk = append(chunk, more...)
				default:
					goto sendOutput
				}
			}
		sendOutput:
			frames <- terminalFrame{Type: "output", SessionID: (*current).id, Data: base64.StdEncoding.EncodeToString(chunk)}
		case <-time.After(250 * time.Millisecond):
			if *current != nil {
				select {
				case <-(*current).done:
					select {
					case <-(*current).readerDone:
						if len((*current).output) == 0 {
							frames <- terminalFrame{Type: "closed", SessionID: (*current).id}
							(*current).close()
							*current = nil
						}
					default:
					}
				default:
				}
			}
		}
	}
}
