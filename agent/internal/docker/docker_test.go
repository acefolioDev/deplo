package docker

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"testing"
	"time"
)

func validSpec() Spec {
	return Spec{DeploymentID: "11111111-1111-4111-8111-111111111111", EnvironmentID: "22222222-2222-4222-8222-222222222222", ImageRef: "nginx:alpine", Port: 80, MemoryMB: 128, CPUQuota: 100000, HealthPath: "/"}
}
func TestSpecRejectsDangerousOptions(t *testing.T) {
	cases := []struct {
		name string
		edit func(*Spec)
	}{
		{"invalid image", func(s *Spec) { s.ImageRef = "nginx;rm -rf /" }},
		{"invalid domain", func(s *Spec) { s.Domains = []string{"bad.com\nimport /etc/passwd"} }},
		{"docker socket mount", func(s *Spec) { s.VolumePath = "/var/run/docker.sock" }},
		{"host namespace", func(s *Spec) { s.HealthPath = "/health\nHostNetwork:true" }},
		{"private registry mismatch", func(s *Spec) { s.RegistryToken = "secret"; s.RegistryUsername = "user" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := validSpec()
			tc.edit(&s)
			if err := s.Validate(); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}
func TestPullStreamsAndAuthenticates(t *testing.T) {
	file, err := os.CreateTemp("/tmp", "deplo-sock-*")
	if err != nil {
		t.Fatal(err)
	}
	socket := file.Name()
	file.Close()
	os.Remove(socket)
	defer os.Remove(socket)
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	var sawAuth bool
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/images/create" {
			encoded := r.Header.Get("X-Registry-Auth")
			raw, e := base64.RawURLEncoding.DecodeString(encoded)
			if e != nil {
				t.Errorf("invalid auth: %v", e)
			}
			var auth map[string]string
			_ = json.Unmarshal(raw, &auth)
			sawAuth = auth["username"] == "alice" && auth["password"] == "secret" && auth["serveraddress"] == "ghcr.io"
			for i := 0; i < 1000; i++ {
				_, _ = w.Write([]byte(`{"status":"Downloading"}` + "\n"))
			}
			return
		}
		if r.URL.Path == "/images/ghcr.io/alice/app:v1/json" {
			_, _ = w.Write([]byte(`{"RepoDigests":["ghcr.io/alice/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}`))
			return
		}
		http.NotFound(w, r)
	})}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()
	digest, err := New(socket).Pull(context.Background(), "ghcr.io/alice/app:v1", "alice", "secret")
	if err != nil {
		t.Fatal(err)
	}
	if !sawAuth || digest != "ghcr.io/alice/app@sha256:"+"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Fatalf("unexpected auth or digest: %v %s", sawAuth, digest)
	}
}
func TestManagedStats(t *testing.T) {
	file, err := os.CreateTemp("/tmp", "deplo-stats-*")
	if err != nil {
		t.Fatal(err)
	}
	socket := file.Name()
	file.Close()
	os.Remove(socket)
	defer os.Remove(socket)
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/containers/json":
			if r.URL.Query().Get("filters") != `{"label":["com.deplo.managed=true"]}` {
				t.Error("wrong label filter")
			}
			_, _ = w.Write([]byte(`[{"Id":"c1","State":"running","Labels":{"com.deplo.deployment":"11111111-1111-4111-8111-111111111111"}}]`))
		case "/containers/c1/stats":
			_, _ = w.Write([]byte(`{"cpu_stats":{"cpu_usage":{"total_usage":200},"system_cpu_usage":2000,"online_cpus":2},"precpu_stats":{"cpu_usage":{"total_usage":100},"system_cpu_usage":1000},"memory_stats":{"usage":1048576,"limit":2097152}}`))
		default:
			http.NotFound(w, r)
		}
	})}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()
	items, err := New(socket).ManagedStats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].CPUPercent != 20 || items[0].MemoryUsed != 1048576 || items[0].Status != "running" {
		t.Fatalf("unexpected metrics: %#v", items)
	}
}
func TestDockerLifecycleIntegration(t *testing.T) {
	if os.Getenv("DEPLO_DOCKER_INTEGRATION") != "1" {
		t.Skip("set DEPLO_DOCKER_INTEGRATION=1 on a disposable Docker host")
	}
	c := New("/var/run/docker.sock")
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	if err := c.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		t.Fatal(err)
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	hexID := hex.EncodeToString(raw[:])
	id := hexID[:8] + "-" + hexID[8:12] + "-" + hexID[12:16] + "-" + hexID[16:20] + "-" + hexID[20:]
	s := validSpec()
	s.DeploymentID = id
	defer func() { _ = c.Stop(context.Background(), id); _ = c.Remove(context.Background(), id) }()
	if _, err := c.Deploy(ctx, s); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Deploy(ctx, s); err != nil {
		t.Fatalf("idempotent redeploy failed: %v", err)
	}
	logs, err := c.Logs(ctx, id, 20, 4096)
	if err != nil {
		t.Fatal(err)
	}
	_ = logs
	if err := c.Restart(ctx, id); err != nil {
		t.Fatal(err)
	}
	if err := c.Stop(ctx, id); err != nil {
		t.Fatal(err)
	}
}
