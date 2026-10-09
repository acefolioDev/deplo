package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"deplo/agent/internal/docker"
	"deplo/agent/internal/metrics"
)

const version = "0.1.0"

type config struct {
	URL            string
	CredentialFile string
	PairToken      string
	Caddyfile      string
	CaddySites     string
}
type identity struct {
	ServerID   string `json:"serverId"`
	Credential string `json:"credential"`
	Pending    bool   `json:"pending,omitempty"`
}
type job struct {
	ID                   string            `json:"id"`
	Kind                 string            `json:"kind"`
	DeploymentID         string            `json:"deploymentId"`
	Lease                string            `json:"lease"`
	EnvironmentID        string            `json:"environmentId"`
	ImageRef             string            `json:"imageRef"`
	Port                 int               `json:"port"`
	MemoryMB             int64             `json:"memoryMb"`
	CPUQuota             int64             `json:"cpuQuota"`
	HealthPath           string            `json:"healthPath"`
	VolumePath           string            `json:"volumePath"`
	RegistryUsername     string            `json:"registryUsername"`
	RegistryToken        string            `json:"registryToken"`
	PreviousDeploymentID string            `json:"previousDeploymentId"`
	Variables            map[string]string `json:"variables"`
	Domains              []string          `json:"domains"`
}
type api struct {
	cfg      config
	http     *http.Client
	identity identity
	docker   *docker.Client
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg := config{URL: strings.TrimRight(os.Getenv("DEPLO_URL"), "/"), CredentialFile: env("DEPLO_CREDENTIAL_FILE", "/var/lib/deplo-agent/identity.json"), PairToken: os.Getenv("DEPLO_PAIR_TOKEN"), Caddyfile: env("DEPLO_CADDYFILE", "/etc/caddy/Caddyfile"), CaddySites: env("DEPLO_CADDY_SITES", "/etc/caddy/deplo")}
	if cfg.URL == "" || (!strings.HasPrefix(cfg.URL, "https://") && !strings.HasPrefix(cfg.URL, "http://127.0.0.1:") && !strings.HasPrefix(cfg.URL, "http://localhost:")) {
		logger.Error("DEPLO_URL must use HTTPS (localhost is allowed for development)")
		os.Exit(1)
	}
	a := &api{cfg: cfg, http: &http.Client{Timeout: 40 * time.Second}, docker: docker.New("/var/run/docker.sock")}
	id, err := readIdentity(cfg.CredentialFile)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		logger.Error("cannot read identity", "error", err)
		os.Exit(1)
	}
	if id.Credential == "" {
		if cfg.PairToken == "" {
			logger.Error("agent is not paired; set DEPLO_PAIR_TOKEN for first start")
			os.Exit(1)
		}
		var paired identity
		if err := a.request(context.Background(), "POST", "/api/agent/pair", map[string]any{"token": cfg.PairToken}, &paired, false); err != nil {
			logger.Error("pairing failed", "error", err)
			os.Exit(1)
		}
		if err := writeIdentity(cfg.CredentialFile, paired); err != nil {
			logger.Error("cannot save identity", "error", err)
			os.Exit(1)
		}
		id = paired
		logger.Info("paired", "serverId", id.ServerID)
	}
	a.identity = id
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if os.Getenv("DEPLO_ROTATE_CREDENTIAL") == "1" && !id.Pending {
		var rotated struct {
			Credential string `json:"credential"`
		}
		if err := a.request(ctx, "POST", "/api/agent/rotate", map[string]any{}, &rotated, true); err != nil {
			logger.Error("credential rotation failed", "error", err)
			os.Exit(1)
		}
		id.Credential = rotated.Credential
		id.Pending = true
		if err := writeIdentity(cfg.CredentialFile, id); err != nil {
			logger.Error("cannot persist new credential; old credential remains valid", "error", err)
			os.Exit(1)
		}
		a.identity = id
	}
	logger.Info("agent started", "version", version, "serverId", id.ServerID)
	nextHeartbeat := time.Time{}
	idle := 2 * time.Second
	for ctx.Err() == nil {
		if a.identity.Pending {
			if err := a.request(ctx, "POST", "/api/agent/confirm-rotation", map[string]any{}, nil, true); err != nil {
				logger.Warn("rotation confirmation pending", "error", err)
				select {
				case <-ctx.Done():
					break
				case <-time.After(10 * time.Second):
				}
				continue
			}
			a.identity.Pending = false
			if err := writeIdentity(cfg.CredentialFile, a.identity); err != nil {
				logger.Warn("rotation confirmed but identity flag not saved", "error", err)
			}
			logger.Info("credential rotation confirmed")
		}
		if time.Now().After(nextHeartbeat) {
			m := metrics.Collect()
			dockerReady := a.docker.Ping(ctx) == nil
			caddyReady := caddyAvailable(ctx, cfg)
			containers := []docker.ContainerMetric{}
			if dockerReady {
				if observed, err := a.docker.ManagedStats(ctx); err == nil {
					containers = observed
				}
			}
			metricReport := map[string]any{"cpuPercent": m.CPUPercent, "memoryUsed": m.MemoryUsed, "memoryTotal": m.MemoryTotal, "diskUsed": m.DiskUsed, "diskTotal": m.DiskTotal, "containers": containers}
			err := a.request(ctx, "POST", "/api/agent/heartbeat", map[string]any{"version": version, "architecture": runtime.GOARCH, "dockerAvailable": dockerReady, "caddyAvailable": caddyReady, "metrics": metricReport}, nil, true)
			if err != nil {
				logger.Warn("heartbeat failed", "error", err)
			}
			nextHeartbeat = time.Now().Add(2 * time.Minute)
		}
		var reply struct {
			Job *job `json:"job"`
		}
		if err := a.request(ctx, "POST", "/api/agent/jobs/lease", map[string]any{}, &reply, true); err != nil {
			logger.Warn("job poll failed", "error", err)
			idle = min(idle*2, 30*time.Second)
		} else if reply.Job != nil {
			idle = 2 * time.Second
			j := reply.Job
			logger.Info("job accepted", "jobId", j.ID, "kind", j.Kind)
			operationCtx, cancel := context.WithTimeout(ctx, 12*time.Minute)
			result, digest, runErr := a.execute(operationCtx, *j)
			cancel()
			message := "Completed"
			if runErr != nil {
				message = redact(runErr.Error(), *j)
				if len(message) > 1000 {
					message = message[:1000]
				}
				logger.Error("job failed", "jobId", j.ID, "error", message)
			}
			reportErr := a.request(ctx, "POST", "/api/agent/jobs/"+j.ID+"/complete", map[string]any{"lease": j.Lease, "success": runErr == nil, "message": message, "imageDigest": digest, "result": result}, nil, true)
			if reportErr != nil {
				logger.Error("job result could not be reported; retry is safe by resource identity", "jobId", j.ID, "error", reportErr)
			}
			continue
		} else {
			idle = min(idle*2, 30*time.Second)
		}
		jitter, _ := rand.Int(rand.Reader, big.NewInt(1000))
		wait := idle + time.Duration(jitter.Int64())*time.Millisecond
		if until := time.Until(nextHeartbeat); until < wait {
			wait = max(until, 0)
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
	logger.Info("agent stopped")
}
func env(key, defaultValue string) string {
	if x := os.Getenv(key); x != "" {
		return x
	}
	return defaultValue
}
func redact(message string, j job) string {
	for _, value := range j.Variables {
		if value != "" {
			message = strings.ReplaceAll(message, value, "[REDACTED]")
		}
	}
	for _, value := range []string{j.RegistryToken, j.Lease} {
		if value != "" {
			message = strings.ReplaceAll(message, value, "[REDACTED]")
		}
	}
	return message
}
func fileExists(path string) bool { _, err := os.Stat(path); return err == nil }
func caddyAvailable(ctx context.Context, cfg config) bool {
	if !fileExists(cfg.Caddyfile) || !fileExists(cfg.CaddySites) {
		return false
	}
	checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(checkCtx, "GET", "http://127.0.0.1:2019/config/", nil)
	if err != nil {
		return false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == 200
}
func readIdentity(path string) (identity, error) {
	var x identity
	b, e := os.ReadFile(path)
	if e != nil {
		return x, e
	}
	e = json.Unmarshal(b, &x)
	return x, e
}
func writeIdentity(path string, x identity) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	b, err := json.Marshal(x)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".identity-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err != nil {
		f.Close()
		return err
	}
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
func (a *api) request(ctx context.Context, method, path string, payload any, out any, authorized bool) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, a.cfg.URL+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if authorized {
		req.Header.Set("Authorization", "Bearer "+a.identity.Credential)
	}
	resp, err := a.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("control plane returned HTTP %d: %s", resp.StatusCode, string(data))
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}
func (a *api) execute(ctx context.Context, j job) (any, string, error) {
	switch j.Kind {
	case "deploy":
		spec := docker.Spec{DeploymentID: j.DeploymentID, EnvironmentID: j.EnvironmentID, ImageRef: j.ImageRef, Port: j.Port, MemoryMB: j.MemoryMB, CPUQuota: j.CPUQuota, HealthPath: j.HealthPath, VolumePath: j.VolumePath, RegistryUsername: j.RegistryUsername, RegistryToken: j.RegistryToken, Variables: j.Variables, Domains: j.Domains, PreviousDeploymentID: j.PreviousDeploymentID, Caddyfile: a.cfg.Caddyfile, CaddySites: a.cfg.CaddySites,
			Progress: func(message string) {
				progressCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
				defer cancel()
				_ = a.request(progressCtx, "POST", "/api/agent/jobs/"+j.ID+"/progress", map[string]any{"lease": j.Lease, "message": message}, nil, true)
			}}
		digest, err := a.docker.Deploy(ctx, spec)
		return nil, digest, err
	case "stop":
		return nil, "", a.docker.Stop(ctx, j.PreviousDeploymentID)
	case "restart":
		return nil, "", a.docker.Restart(ctx, j.PreviousDeploymentID)
	case "logs":
		logs, err := a.docker.Logs(ctx, j.PreviousDeploymentID, 200, 32<<10)
		return map[string]any{"lines": logs}, "", err
	default:
		return nil, "", fmt.Errorf("unsupported job kind")
	}
}
