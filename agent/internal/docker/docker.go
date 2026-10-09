package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F-]{36}$`)
var imagePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$`)
var domainPattern = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)

type Spec struct {
	DeploymentID, EnvironmentID, ImageRef string
	Port                                  int
	MemoryMB, CPUQuota                    int64
	HealthPath                            string
	VolumePath                            string
	RegistryUsername, RegistryToken       string
	Variables                             map[string]string
	Domains                               []string
	PreviousDeploymentID                  string
	Caddyfile, CaddySites                 string
	Progress                              func(string)
}

func (s Spec) Validate() error {
	if !uuidPattern.MatchString(s.DeploymentID) || !uuidPattern.MatchString(s.EnvironmentID) {
		return errors.New("invalid deployment identity")
	}
	if !imagePattern.MatchString(s.ImageRef) || strings.Contains(s.ImageRef, "..") || len(s.ImageRef) > 512 {
		return errors.New("invalid image reference")
	}
	if s.Port < 1 || s.Port > 65535 || s.MemoryMB < 32 || s.MemoryMB > 32768 || s.CPUQuota < 10000 || s.CPUQuota > 800000 {
		return errors.New("invalid resource limits")
	}
	if !strings.HasPrefix(s.HealthPath, "/") || strings.ContainsAny(s.HealthPath, "\r\n\t ") || len(s.HealthPath) > 200 {
		return errors.New("invalid health path")
	}
	for k, v := range s.Variables {
		if !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`).MatchString(k) || len(v) > 8192 {
			return errors.New("invalid environment variable")
		}
	}
	for _, d := range s.Domains {
		if !domainPattern.MatchString(d) {
			return errors.New("invalid domain")
		}
	}
	if s.VolumePath != "" {
		if !regexp.MustCompile(`^/[a-zA-Z0-9/_-]+$`).MatchString(s.VolumePath) || strings.Contains(s.VolumePath, "//") || strings.Contains(s.VolumePath, "..") {
			return errors.New("invalid volume path")
		}
		for _, restricted := range []string{"/proc", "/sys", "/dev", "/run", "/var/run"} {
			if s.VolumePath == restricted || strings.HasPrefix(s.VolumePath, restricted+"/") {
				return errors.New("restricted volume path")
			}
		}
	}
	if s.RegistryToken != "" && (s.RegistryUsername == "" || !strings.HasPrefix(s.ImageRef, "ghcr.io/")) {
		return errors.New("registry credential requires GHCR image and username")
	}
	return nil
}

type Client struct{ http *http.Client }
type ContainerMetric struct {
	DeploymentID string  `json:"deploymentId"`
	Status       string  `json:"status"`
	CPUPercent   float64 `json:"cpuPercent"`
	MemoryUsed   uint64  `json:"memoryUsed"`
	MemoryLimit  uint64  `json:"memoryLimit"`
}

func New(socket string) *Client {
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "unix", socket)
	}, MaxIdleConns: 2, IdleConnTimeout: 30 * time.Second}
	return &Client{http: &http.Client{Transport: transport}}
}
func (c *Client) call(ctx context.Context, method, path string, payload any, limit int64) ([]byte, int, error) {
	return c.callHeaders(ctx, method, path, payload, limit, nil)
}
func (c *Client) callHeaders(ctx context.Context, method, path string, payload any, limit int64, headers map[string]string) ([]byte, int, error) {
	var input io.Reader
	if payload != nil {
		data, e := json.Marshal(payload)
		if e != nil {
			return nil, 0, e
		}
		input = bytes.NewReader(data)
	}
	req, e := http.NewRequestWithContext(ctx, method, "http://docker"+path, input)
	if e != nil {
		return nil, 0, e
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, e := c.http.Do(req)
	if e != nil {
		return nil, 0, e
	}
	defer resp.Body.Close()
	data, e := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if e != nil {
		return nil, resp.StatusCode, e
	}
	if int64(len(data)) > limit {
		return nil, resp.StatusCode, errors.New("Docker response exceeds limit")
	}
	if resp.StatusCode >= 400 {
		return nil, resp.StatusCode, fmt.Errorf("Docker HTTP %d: %s", resp.StatusCode, truncate(string(data), 500))
	}
	return data, resp.StatusCode, nil
}
func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
func (c *Client) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	_, _, e := c.call(ctx, "GET", "/_ping", nil, 1024)
	return e
}
func (c *Client) ManagedStats(ctx context.Context) ([]ContainerMetric, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	filter := url.QueryEscape(`{"label":["com.deplo.managed=true"]}`)
	data, _, err := c.call(ctx, "GET", "/containers/json?all=0&limit=20&filters="+filter, nil, 1<<20)
	if err != nil {
		return nil, err
	}
	var containers []struct {
		ID     string            `json:"Id"`
		State  string            `json:"State"`
		Labels map[string]string `json:"Labels"`
	}
	if err = json.Unmarshal(data, &containers); err != nil {
		return nil, err
	}
	result := make([]ContainerMetric, 0, len(containers))
	for _, container := range containers {
		id := container.Labels["com.deplo.deployment"]
		if !uuidPattern.MatchString(id) {
			continue
		}
		m := ContainerMetric{DeploymentID: id, Status: container.State}
		statsData, _, statsErr := c.call(ctx, "GET", "/containers/"+url.PathEscape(container.ID)+"/stats?stream=false", nil, 1<<20)
		if statsErr == nil {
			var stats struct {
				CPUStats struct {
					CPUUsage struct {
						TotalUsage uint64 `json:"total_usage"`
					} `json:"cpu_usage"`
					SystemCPUUsage uint64 `json:"system_cpu_usage"`
					OnlineCPUs     uint64 `json:"online_cpus"`
				} `json:"cpu_stats"`
				PreCPUStats struct {
					CPUUsage struct {
						TotalUsage uint64 `json:"total_usage"`
					} `json:"cpu_usage"`
					SystemCPUUsage uint64 `json:"system_cpu_usage"`
				} `json:"precpu_stats"`
				MemoryStats struct {
					Usage uint64 `json:"usage"`
					Limit uint64 `json:"limit"`
				} `json:"memory_stats"`
			}
			if json.Unmarshal(statsData, &stats) == nil {
				cpuDelta := stats.CPUStats.CPUUsage.TotalUsage - stats.PreCPUStats.CPUUsage.TotalUsage
				systemDelta := stats.CPUStats.SystemCPUUsage - stats.PreCPUStats.SystemCPUUsage
				if systemDelta > 0 {
					cores := stats.CPUStats.OnlineCPUs
					if cores == 0 {
						cores = 1
					}
					m.CPUPercent = float64(cpuDelta) / float64(systemDelta) * float64(cores) * 100
				}
				m.MemoryUsed = stats.MemoryStats.Usage
				m.MemoryLimit = stats.MemoryStats.Limit
			}
		}
		result = append(result, m)
	}
	return result, nil
}
func containerName(id string) string { return "deplo-" + id }

type inspect struct {
	ID    string `json:"Id"`
	Image string `json:"Image"`
	State struct {
		Running bool `json:"Running"`
	} `json:"State"`
	Config struct {
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	NetworkSettings struct {
		IPAddress string `json:"IPAddress"`
		Networks  map[string]struct {
			IPAddress string `json:"IPAddress"`
		} `json:"Networks"`
	} `json:"NetworkSettings"`
}

func (c *Client) inspect(ctx context.Context, id string) (inspect, bool, error) {
	var out inspect
	data, status, e := c.call(ctx, "GET", "/containers/"+url.PathEscape(containerName(id))+"/json", nil, 1<<20)
	if status == 404 {
		return out, false, nil
	}
	if e != nil {
		return out, false, e
	}
	e = json.Unmarshal(data, &out)
	return out, true, e
}
func (c *Client) managed(ctx context.Context, id string) (inspect, error) {
	if !uuidPattern.MatchString(id) {
		return inspect{}, errors.New("invalid container identity")
	}
	x, exists, e := c.inspect(ctx, id)
	if e != nil {
		return x, e
	}
	if !exists {
		return x, errors.New("managed container not found")
	}
	if x.Config.Labels["com.deplo.managed"] != "true" || x.Config.Labels["com.deplo.deployment"] != id {
		return x, errors.New("container identity mismatch")
	}
	return x, nil
}
func (c *Client) Pull(ctx context.Context, ref, username, token string) (string, error) {
	pullCtx, cancel := context.WithTimeout(ctx, 8*time.Minute)
	defer cancel()
	path := "/images/create?fromImage=" + url.QueryEscape(ref)
	req, err := http.NewRequestWithContext(pullCtx, "POST", "http://docker"+path, nil)
	if err != nil {
		return "", err
	}
	if token != "" {
		auth, _ := json.Marshal(map[string]string{"username": username, "password": token, "serveraddress": "ghcr.io"})
		req.Header.Set("X-Registry-Auth", base64.RawURLEncoding.EncodeToString(auth))
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return "", fmt.Errorf("Docker image pull HTTP %d: %s", resp.StatusCode, truncate(string(data), 500))
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 4096), 128<<10)
	for scanner.Scan() {
		var event struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(scanner.Bytes(), &event) == nil && event.Error != "" {
			return "", fmt.Errorf("image pull failed: %s", truncate(event.Error, 300))
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return c.imageDigest(ctx, ref)
}
func (c *Client) imageDigest(ctx context.Context, ref string) (string, error) {
	data, _, e := c.call(ctx, "GET", "/images/"+url.PathEscape(ref)+"/json", nil, 2<<20)
	if e != nil {
		return "", e
	}
	var x struct {
		RepoDigests []string `json:"RepoDigests"`
	}
	if e = json.Unmarshal(data, &x); e != nil {
		return "", e
	}
	if len(x.RepoDigests) > 0 {
		return x.RepoDigests[0], nil
	}
	return ref, nil
}
func (c *Client) Deploy(ctx context.Context, s Spec) (string, error) {
	if e := s.Validate(); e != nil {
		return "", e
	}
	if e := c.Ping(ctx); e != nil {
		return "", e
	}
	existing, exists, e := c.inspect(ctx, s.DeploymentID)
	if e != nil {
		return "", e
	}
	var digest string
	if exists {
		if existing.Config.Labels["com.deplo.managed"] != "true" || existing.Config.Labels["com.deplo.deployment"] != s.DeploymentID {
			return "", errors.New("existing container is not this deployment")
		}
		if existing.Image != "" {
			digest, _ = c.imageDigest(ctx, existing.Image)
		}
	} else {
		if s.Progress != nil {
			s.Progress("Pulling image")
		}
		digest, e = c.Pull(ctx, s.ImageRef, s.RegistryUsername, s.RegistryToken)
		if e != nil {
			return "", e
		}
		env := make([]string, 0, len(s.Variables))
		for k, v := range s.Variables {
			env = append(env, k+"="+v)
		}
		hostConfig := map[string]any{"NetworkMode": "bridge", "Memory": s.MemoryMB * 1024 * 1024, "CpuQuota": s.CPUQuota, "CpuPeriod": 100000, "CapDrop": []string{"ALL"}, "SecurityOpt": []string{"no-new-privileges:true"}, "RestartPolicy": map[string]string{"Name": "unless-stopped"}}
		if s.VolumePath != "" {
			hostConfig["Mounts"] = []map[string]string{{"Type": "volume", "Source": "deplo-data-" + s.EnvironmentID, "Target": s.VolumePath}}
		}
		payload := map[string]any{"Image": s.ImageRef, "Env": env, "Labels": map[string]string{"com.deplo.managed": "true", "com.deplo.deployment": s.DeploymentID, "com.deplo.environment": s.EnvironmentID}, "ExposedPorts": map[string]any{fmt.Sprintf("%d/tcp", s.Port): map[string]any{}}, "HostConfig": hostConfig}
		_, _, e = c.call(ctx, "POST", "/containers/create?name="+url.QueryEscape(containerName(s.DeploymentID)), payload, 1<<20)
		if e != nil {
			return "", e
		}
	}
	if s.Progress != nil {
		s.Progress("Starting container")
	}
	if !existing.State.Running {
		if _, _, e = c.call(ctx, "POST", "/containers/"+containerName(s.DeploymentID)+"/start", nil, 1<<20); e != nil {
			return "", e
		}
	}
	readyCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	if s.Progress != nil {
		s.Progress("Checking application health")
	}
	var ip string
	for readyCtx.Err() == nil {
		x, _, e := c.inspect(readyCtx, s.DeploymentID)
		if e != nil {
			return digest, e
		}
		ip = x.NetworkSettings.IPAddress
		if ip == "" {
			for _, n := range x.NetworkSettings.Networks {
				if n.IPAddress != "" {
					ip = n.IPAddress
					break
				}
			}
		}
		if net.ParseIP(ip) == nil {
			return digest, errors.New("container has no reachable bridge address")
		}
		req, e := http.NewRequestWithContext(readyCtx, "GET", fmt.Sprintf("http://%s:%d%s", ip, s.Port, s.HealthPath), nil)
		if e != nil {
			return digest, e
		}
		client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		response, e := client.Do(req)
		if e == nil {
			io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
			response.Body.Close()
			if response.StatusCode >= 200 && response.StatusCode < 400 {
				break
			}
		}
		select {
		case <-readyCtx.Done():
			return digest, errors.New("readiness deadline exceeded")
		case <-time.After(2 * time.Second):
		}
	}
	if readyCtx.Err() != nil {
		return digest, errors.New("readiness deadline exceeded")
	}
	if len(s.Domains) > 0 || caddySiteExists(filepath.Join(s.CaddySites, s.EnvironmentID+".caddy")) {
		if s.Progress != nil {
			s.Progress("Updating HTTPS routes")
		}
		if e := configureCaddy(ctx, s, ip); e != nil {
			return digest, e
		}
	}
	if s.PreviousDeploymentID != "" && s.PreviousDeploymentID != s.DeploymentID {
		_ = c.Stop(ctx, s.PreviousDeploymentID)
		_ = c.Remove(ctx, s.PreviousDeploymentID)
	}
	return digest, nil
}
func (c *Client) Stop(ctx context.Context, id string) error {
	if _, e := c.managed(ctx, id); e != nil {
		return e
	}
	_, _, e := c.call(ctx, "POST", "/containers/"+containerName(id)+"/stop?t=10", nil, 1<<20)
	return e
}
func (c *Client) Restart(ctx context.Context, id string) error {
	if _, e := c.managed(ctx, id); e != nil {
		return e
	}
	_, _, e := c.call(ctx, "POST", "/containers/"+containerName(id)+"/restart?t=10", nil, 1<<20)
	return e
}
func (c *Client) Remove(ctx context.Context, id string) error {
	if _, e := c.managed(ctx, id); e != nil {
		return e
	}
	_, _, e := c.call(ctx, "DELETE", "/containers/"+containerName(id), nil, 1<<20)
	return e
}
func (c *Client) Logs(ctx context.Context, id string, tail, maxBytes int) ([]string, error) {
	if _, e := c.managed(ctx, id); e != nil {
		return nil, e
	}
	if tail > 200 || tail < 1 || maxBytes > 64<<10 || maxBytes < 1 {
		return nil, errors.New("invalid log limit")
	}
	data, _, e := c.call(ctx, "GET", fmt.Sprintf("/containers/%s/logs?stdout=1&stderr=1&timestamps=1&tail=%d", containerName(id), tail), nil, int64(maxBytes+8*tail))
	if e != nil {
		return nil, e
	}
	var raw bytes.Buffer
	for len(data) >= 8 {
		size := int(binary.BigEndian.Uint32(data[4:8]))
		if size < 0 || size > len(data)-8 {
			break
		}
		raw.Write(data[8 : 8+size])
		data = data[8+size:]
	}
	if raw.Len() == 0 {
		raw.Write(data)
	}
	text := truncate(raw.String(), maxBytes)
	scanner := bufio.NewScanner(strings.NewReader(text))
	scanner.Buffer(make([]byte, 4096), maxBytes)
	lines := make([]string, 0, tail)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
		if len(lines) >= tail {
			break
		}
	}
	return lines, scanner.Err()
}
func configureCaddy(ctx context.Context, s Spec, ip string) error {
	if net.ParseIP(ip) == nil {
		return errors.New("invalid proxy target")
	}
	if _, e := os.Stat(s.Caddyfile); e != nil {
		return fmt.Errorf("Caddyfile unavailable: %w", e)
	}
	config, e := os.ReadFile(s.Caddyfile)
	if e != nil {
		return e
	}
	importLine := "import " + filepath.Join(s.CaddySites, "*.caddy")
	foundImport := false
	for _, line := range strings.Split(string(config), "\n") {
		if strings.TrimSpace(line) == importLine {
			foundImport = true
			break
		}
	}
	if !foundImport {
		return errors.New("Caddyfile must import the Deplo sites directory")
	}
	if e := os.MkdirAll(s.CaddySites, 0755); e != nil {
		return e
	}
	path := filepath.Join(s.CaddySites, s.EnvironmentID+".caddy")
	previous, _ := os.ReadFile(path)
	var b strings.Builder
	for _, domain := range s.Domains {
		fmt.Fprintf(&b, "%s {\n  reverse_proxy %s:%d\n}\n", domain, ip, s.Port)
	}
	temp, e := os.CreateTemp(s.CaddySites, ".deplo-*.caddy")
	if e != nil {
		return e
	}
	defer os.Remove(temp.Name())
	if e = temp.Chmod(0644); e != nil {
		temp.Close()
		return e
	}
	if _, e = temp.WriteString(b.String()); e != nil {
		temp.Close()
		return e
	}
	if e = temp.Sync(); e != nil {
		temp.Close()
		return e
	}
	if e = temp.Close(); e != nil {
		return e
	}
	if e = os.Rename(temp.Name(), path); e != nil {
		return e
	}
	validate := exec.CommandContext(ctx, "caddy", "validate", "--config", s.Caddyfile, "--adapter", "caddyfile")
	output, e := validate.CombinedOutput()
	if e != nil {
		restore(path, previous)
		return fmt.Errorf("Caddy validation failed: %s", truncate(string(output), 500))
	}
	reload := exec.CommandContext(ctx, "caddy", "reload", "--config", s.Caddyfile, "--adapter", "caddyfile")
	output, e = reload.CombinedOutput()
	if e != nil {
		restore(path, previous)
		return fmt.Errorf("Caddy reload failed: %s", truncate(string(output), 500))
	}
	return nil
}
func caddySiteExists(path string) bool { _, err := os.Stat(path); return err == nil }
func restore(path string, previous []byte) {
	if len(previous) > 0 {
		_ = os.WriteFile(path, previous, 0644)
	} else {
		_ = os.Remove(path)
	}
}
