#!/usr/bin/env bash
# Generate a self-signed cert for local HTTPS so iOS will allow DeviceOrientation.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/key.pem -out certs/cert.pem \
  -days 365 \
  -subj "/CN=musicaxis.local" \
  -addext "subjectAltName=DNS:localhost,DNS:musicaxis.local,IP:127.0.0.1,$(ipconfig getifaddr en0 2>/dev/null | sed 's/^/IP:/' || echo 'IP:0.0.0.0')"
echo "certs written to ./certs"
