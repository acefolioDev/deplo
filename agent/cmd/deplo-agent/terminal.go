package main

import (
	"context"
	"encoding/base64"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

type terminalSession struct {
	ID        string    `json:"id"`
	ExpiresAt time.Time `json:"expiresAt"`
	Inputs    []string  `json:"inputs"`
	Cols      uint16    `json:"cols"`
	Rows      uint16    `json:"rows"`
	ShellUser string    `json:"shellUser"`
}
type terminalProcess struct {
	id         string
	file       *os.File
	cmd        *exec.Cmd
	output     chan []byte
	done       chan struct{}
	readerDone chan struct{}
	stop       chan struct{}
	closeOnce  sync.Once
	expiresAt  time.Time
	cols       uint16
	rows       uint16
}

func startTerminal(session terminalSession) (*terminalProcess, error) {
	user := session.ShellUser
	if user == "" {
		user = "root"
	}
	var cmd *exec.Cmd
	if user == "root" {
		cmd = exec.Command("/bin/bash", "-l")
	} else {
		cmd = exec.Command("/usr/bin/sudo", "-n", "-iu", user, "/bin/bash", "-l")
	}
	cmd.Dir = "/"
	cmd.Env = []string{"HOME=/root", "USER=" + user, "LOGNAME=" + user, "SHELL=/bin/bash", "TERM=xterm-256color", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: session.Rows, Cols: session.Cols})
	if err != nil {
		return nil, err
	}
	p := &terminalProcess{id: session.ID, file: f, cmd: cmd, output: make(chan []byte, 128), done: make(chan struct{}), readerDone: make(chan struct{}), stop: make(chan struct{}), expiresAt: session.ExpiresAt, cols: session.Cols, rows: session.Rows}
	go func() {
		defer close(p.readerDone)
		buffer := make([]byte, 2048)
		for {
			n, err := f.Read(buffer)
			if n > 0 {
				chunk := append([]byte(nil), buffer[:n]...)
				select {
				case p.output <- chunk:
				case <-p.stop:
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	go func() { _ = cmd.Wait(); close(p.done) }()
	return p, nil
}
func (p *terminalProcess) close() {
	if p == nil {
		return
	}
	p.closeOnce.Do(func() {
		close(p.stop)
		_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
		_ = p.cmd.Process.Kill()
		_ = p.file.Close()
	})
}
func (a *api) runTerminal(ctx context.Context, logger *slog.Logger) {
	var current *terminalProcess
	var pending []byte
	defer func() { current.close() }()
	for ctx.Err() == nil {
		if current != nil && !time.Now().Before(current.expiresAt) {
			current.close()
			current = nil
			pending = nil
		}
		payload := map[string]any{}
		closing := false
		if current != nil {
		drain:
			for len(pending) < 6144 {
				select {
				case chunk := <-current.output:
					pending = append(pending, chunk...)
				default:
					break drain
				}
			}
			select {
			case <-current.done:
				select {
				case <-current.readerDone:
					closing = len(current.output) == 0
				default:
				}
			default:
			}
			if len(pending) > 0 || closing {
				payload["sessionId"] = current.id
				payload["data"] = base64.StdEncoding.EncodeToString(pending)
				payload["closed"] = closing
			}
		}
		var reply struct {
			Session *terminalSession `json:"session"`
		}
		pollCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		err := a.request(pollCtx, "POST", "/api/agent/terminal/poll", payload, &reply, true)
		cancel()
		if err != nil {
			logger.Warn("terminal poll failed", "error", err)
			if strings.Contains(err.Error(), "HTTP 401") {
				current.close()
				return
			}
			if !terminalWait(ctx, 5*time.Second) {
				return
			}
			continue
		}
		pending = nil
		if closing {
			current.close()
			current = nil
		}
		if current != nil && (reply.Session == nil || current.id != reply.Session.ID || time.Now().After(reply.Session.ExpiresAt)) {
			current.close()
			current = nil
			pending = nil
		}
		if reply.Session != nil && current == nil && time.Now().Before(reply.Session.ExpiresAt) {
			current, err = startTerminal(*reply.Session)
			if err != nil {
				logger.Error("terminal start failed", "error", err)
				_ = a.sendTerminalOutput(ctx, reply.Session.ID, "", true)
			}
		}
		if current != nil {
			if current.cols != reply.Session.Cols || current.rows != reply.Session.Rows {
				if err := pty.Setsize(current.file, &pty.Winsize{Rows: reply.Session.Rows, Cols: reply.Session.Cols}); err == nil {
					current.cols = reply.Session.Cols
					current.rows = reply.Session.Rows
				}
			}
			for _, encoded := range reply.Session.Inputs {
				input, decodeErr := base64.StdEncoding.DecodeString(encoded)
				if decodeErr == nil && len(input) <= 4096 {
					_, _ = current.file.Write(input)
				}
			}
		}
		interval := 2 * time.Second
		if current != nil {
			interval = 25 * time.Millisecond
		}
		if !terminalWait(ctx, interval) {
			return
		}
	}
}
func (a *api) sendTerminalOutput(ctx context.Context, id, data string, closed bool) error {
	requestCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return a.request(requestCtx, "POST", "/api/agent/terminal/output", map[string]any{"sessionId": id, "data": data, "closed": closed}, nil, true)
}
func terminalWait(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
