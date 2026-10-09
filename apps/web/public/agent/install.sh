#!/usr/bin/env bash
set -Eeuo pipefail

fail() { printf 'Deplo setup: %s\n' "$*" >&2; exit 1; }
say() { printf 'Deplo setup: %s\n' "$*"; }

[[ $# -ge 1 && $# -le 3 ]] || fail 'usage: sudo bash install.sh https://your-control-plane [--without-caddy] [--enable-root-terminal]'
control_url="${1%/}"
[[ "$control_url" =~ ^https://([a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(:[0-9]+)?$ ]] || fail 'control plane URL must be an HTTPS origin without a path'
with_caddy=1
root_terminal=0
for option in "${@:2}"; do
  case "$option" in
    --without-caddy) with_caddy=0 ;;
    --enable-root-terminal) root_terminal=1 ;;
    *) fail "unknown option: $option" ;;
  esac
done
[[ "${EUID}" -eq 0 ]] || fail 'run this installer with sudo'
[[ -r /etc/os-release ]] || fail 'cannot identify Linux distribution'
# shellcheck source=/dev/null
. /etc/os-release
[[ "${ID:-}" == ubuntu || "${ID:-}" == linuxmint ]] || fail 'supported systems: Ubuntu 24.04 and Ubuntu-based Linux Mint'
base="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
if [[ "${ID:-}" == linuxmint && "${VERSION_ID:-}" == 22.* && "$base" == "${VERSION_CODENAME:-}" ]]; then
  base=noble
fi
[[ "$base" == noble ]] || fail 'this installer currently supports the Ubuntu 24.04 (noble) base'
command -v apt-get >/dev/null || fail 'apt-get is required'
command -v systemctl >/dev/null || fail 'systemd is required'
command -v curl >/dev/null || fail 'curl is required to download the agent'
command -v sha256sum >/dev/null || fail 'sha256sum is required'

case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64) arch=arm64 ;;
  *) fail 'supported CPU architectures: x86-64 and arm64' ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
say 'Downloading and verifying the agent binary'
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  "$control_url/agent/deplo-agent-linux-$arch" -o "$tmp/deplo-agent-linux-$arch"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  "$control_url/agent/SHA256SUMS" -o "$tmp/SHA256SUMS"
(cd "$tmp" && sha256sum --check --ignore-missing SHA256SUMS) || fail 'agent checksum verification failed'

packages=()
command -v docker >/dev/null || packages+=(docker.io)
if ((with_caddy)) && ! command -v caddy >/dev/null; then packages+=(caddy); fi
if ((${#packages[@]})); then
  say "Installing missing Ubuntu packages: ${packages[*]}"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends "${packages[@]}"
fi
systemctl enable --now docker || fail 'Docker did not start; inspect systemctl status docker'
docker info >/dev/null || fail 'Docker is unavailable; inspect journalctl -u docker'

install -d -o root -g root -m 0755 /etc/caddy/deplo
if ((with_caddy)); then
  say 'Preparing the shared Caddy proxy'
  caddyfile=/etc/caddy/Caddyfile
  [[ -f "$caddyfile" ]] || fail 'Caddyfile is missing after package installation'
  cp -p "$caddyfile" "$tmp/Caddyfile.backup"
  if ! grep -Fxq 'import /etc/caddy/deplo/*.caddy' "$caddyfile"; then
    printf '\nimport /etc/caddy/deplo/*.caddy\n' >> "$caddyfile"
  fi
  if ! caddy validate --config "$caddyfile" --adapter caddyfile; then
    cp -p "$tmp/Caddyfile.backup" "$caddyfile"
    fail 'Caddy validation failed; the previous Caddyfile was restored'
  fi
  systemctl enable --now caddy || fail 'Caddy did not start; inspect systemctl status caddy'
  if ! systemctl reload caddy; then
    cp -p "$tmp/Caddyfile.backup" "$caddyfile"
    systemctl reload caddy || true
    fail 'Caddy reload failed; the previous Caddyfile was restored'
  fi
else
  say 'Skipping Caddy; applications with domains will need an HTTPS router later'
fi

say 'Installing the Deplo agent service'
install -d -o root -g root -m 0700 /etc/deplo-agent /var/lib/deplo-agent
if systemctl is-active --quiet deplo-agent; then systemctl stop deplo-agent; fi
install -o root -g root -m 0755 "$tmp/deplo-agent-linux-$arch" /usr/local/bin/deplo-agent

envfile=/etc/deplo-agent/agent.env
if [[ ! -s /var/lib/deplo-agent/identity.json ]]; then
  say 'Open Servers in Deplo now, generate a Pair token, and paste it below.'
  read -r -s -p 'Pair token: ' pair_token </dev/tty
  printf '\n'
  [[ "$pair_token" =~ ^[A-Za-z0-9_-]{30,}$ ]] || fail 'invalid pairing token format'
  (umask 077; printf 'DEPLO_URL=%s\nDEPLO_PAIR_TOKEN=%s\nDEPLO_CREDENTIAL_FILE=/var/lib/deplo-agent/identity.json\n' "$control_url" "$pair_token" > "$envfile")
  unset pair_token
elif [[ ! -f "$envfile" ]]; then
  (umask 077; printf 'DEPLO_URL=%s\nDEPLO_CREDENTIAL_FILE=/var/lib/deplo-agent/identity.json\n' "$control_url" > "$envfile")
fi
sed -i '/^DEPLO_ROOT_TERMINAL=/d' "$envfile"
if ((root_terminal)); then printf 'DEPLO_ROOT_TERMINAL=1\n' >> "$envfile"; fi
chmod 0600 "$envfile"

cat > /etc/systemd/system/deplo-agent.service <<'UNIT'
[Unit]
Description=Deplo deployment agent
After=network-online.target docker.service caddy.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/deplo-agent/agent.env
ExecStart=/usr/local/bin/deplo-agent
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/deplo-agent /etc/caddy/deplo
ProtectHome=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
MemoryMax=128M

[Install]
WantedBy=multi-user.target
UNIT
if ((root_terminal)); then
  # The terminal must be able to administer the host, not a protected systemd view.
  sed -i '/^PrivateTmp=/d; /^ProtectSystem=/d; /^ProtectHome=/d; /^ReadWritePaths=/d; /^MemoryMax=/d; /^NoNewPrivileges=/d; /^RestrictAddressFamilies=/d' /etc/systemd/system/deplo-agent.service
fi
systemctl daemon-reload
systemctl enable --now deplo-agent || fail 'agent did not start; inspect journalctl -u deplo-agent'

if grep -q '^DEPLO_PAIR_TOKEN=' "$envfile"; then
  for _ in {1..30}; do
    [[ -s /var/lib/deplo-agent/identity.json ]] && break
    sleep 1
  done
  if [[ ! -s /var/lib/deplo-agent/identity.json ]]; then
    journalctl -u deplo-agent -n 20 --no-pager >&2 || true
    systemctl stop deplo-agent || true
    sed -i '/^DEPLO_PAIR_TOKEN=/d' "$envfile"
    fail 'pairing did not finish; check the HTTPS URL, token, and agent journal'
  fi
  sed -i '/^DEPLO_PAIR_TOKEN=/d' "$envfile"
  systemctl restart deplo-agent
fi
say 'Agent is installed and paired. Refresh Servers; Online may take a few seconds.'
