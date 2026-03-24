#!/bin/bash
set -euo pipefail

echo "=== Red Alerts — Evolution API Setup ==="

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root or via sudo"
  exit 1
fi

upsert_env_var() {
  local key="$1"
  local value="$2"

  if grep -q "^${key}=" .env; then
    sed -i "s#^${key}=.*#${key}=${value}#" .env
  else
    printf '\n%s=%s\n' "$key" "$value" >> .env
  fi
}

# Install Docker
if ! command -v docker &>/dev/null; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

# Install Docker Compose plugin
if ! docker compose version &>/dev/null; then
  echo "Installing Docker Compose plugin..."
  apt-get update && apt-get install -y docker-compose-plugin
fi

EVOLUTION_IMAGE="evoapicloud/evolution-api:latest"

# Create .env if missing
if [ ! -f .env ]; then
  cp .env.example .env
  upsert_env_var "EVOLUTION_IMAGE" "$EVOLUTION_IMAGE"
  upsert_env_var "EVOLUTION_API_KEY" "$(openssl rand -hex 16)"
  echo "Created .env — edit WHATSAPP_NUMBER or WHATSAPP_CHAT_ID, and ALERT_LOCATIONS before starting"
  echo ""
  cat .env
  echo ""
  echo "Then run: sudo docker compose up -d --build"
else
  upsert_env_var "EVOLUTION_IMAGE" "$EVOLUTION_IMAGE"
  echo ".env exists, starting..."
  docker compose up -d --build
fi

echo ""
echo "=== Next steps ==="
echo "1. Edit .env with your WhatsApp number or a WhatsApp group chat ID"
echo "2. Start or refresh: sudo docker compose up -d --build"
echo "3. Open the local QR endpoint: curl http://127.0.0.1:${POLLER_PUBLISHED_PORT:-3000}/connect"
echo "4. Save the QR PNG locally: curl http://127.0.0.1:${POLLER_PUBLISHED_PORT:-3000}/qr --output evolution-qr.png"
echo "5. Verify locally on the server: curl http://127.0.0.1:${POLLER_PUBLISHED_PORT:-3000}/health"
echo "6. Trigger a test WhatsApp: curl http://127.0.0.1:${POLLER_PUBLISHED_PORT:-3000}/test"
echo "7. Optional remote access: ssh -L 3000:127.0.0.1:${POLLER_PUBLISHED_PORT:-3000} <user>@<server>"
