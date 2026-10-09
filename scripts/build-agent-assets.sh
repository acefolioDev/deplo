#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
assets="$root/apps/web/public/agent"
mkdir -p "$assets"
for arch in amd64 arm64; do
  (cd "$root/agent" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" \
    go build -trimpath -buildvcs=false -ldflags='-s -w' \
    -o "$assets/deplo-agent-linux-$arch" ./cmd/deplo-agent)
done
cd "$assets"
if command -v sha256sum >/dev/null; then
  sha256sum deplo-agent-linux-* > SHA256SUMS
else
  shasum -a 256 deplo-agent-linux-* > SHA256SUMS
fi
printf 'Built Linux agent assets and SHA256SUMS in %s\n' "$assets"
