package main

import (
	"strings"
	"testing"
)

func TestRedactSecrets(t *testing.T) {
	j := job{Variables: map[string]string{"PASSWORD": "my-password"}, RegistryToken: "ghcr-token", Lease: "lease-secret"}
	out := redact("pull my-password with ghcr-token lease-secret", j)
	for _, secret := range []string{"my-password", "ghcr-token", "lease-secret"} {
		if strings.Contains(out, secret) {
			t.Fatalf("secret leaked: %q", secret)
		}
	}
}
