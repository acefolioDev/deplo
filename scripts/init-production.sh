#!/usr/bin/env bash
set -Eeuo pipefail

domain="${1:-}"
domain="$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]')"
valid_domain=true
if [[ "$domain" != *.* || "${#domain}" -gt 253 ]]; then
  valid_domain=false
else
  IFS=. read -ra labels <<< "$domain"
  for label in "${labels[@]}"; do
    if [[ "${#label}" -gt 63 || ! "$label" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
      valid_domain=false
      break
    fi
  done
  [[ "$domain" != *. ]] || valid_domain=false
fi
if [[ "$valid_domain" != true ]]; then
  printf 'Usage: bash scripts/init-production.sh deplo.example.com\n' >&2
  exit 1
fi
if [[ -e .env ]]; then
  printf '.env already exists; keeping its secrets for future updates.\n' >&2
  exit 1
fi
command -v openssl >/dev/null || { printf 'openssl is required to generate secrets.\n' >&2; exit 1; }
umask 077
{
  printf 'DEPLO_DOMAIN=%s\n' "$domain"
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  printf 'ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)"
  printf 'REGISTRATION_CODE=%s\n' "$(openssl rand -hex 24)"
} > .env
printf 'Created private .env for %s. Back it up securely.\n' "$domain"
