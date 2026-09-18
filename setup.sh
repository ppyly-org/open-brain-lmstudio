#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi
chmod 600 .env

generate_secret() {
  openssl rand -base64 32 | tr -d '\n'
}

set_env_secret() {
  local key="$1"
  local placeholder="$2"
  local current
  current="$(grep -E "^${key}=" .env | head -n1 | cut -d= -f2-)"
  if [[ "$current" == "$placeholder" || -z "$current" ]]; then
    local value
    value="$(generate_secret)"
    if grep -qE "^${key}=" .env; then
      sed -i "s|^${key}=.*|${key}=${value}|" .env
    else
      echo "${key}=${value}" >> .env
    fi
    echo "Generated ${key}"
  else
    echo "${key} already set, leaving it alone"
  fi
}

set_env_secret "POSTGRES_PASSWORD" "CHANGE-ME-run-setup-sh"
set_env_secret "MCP_ACCESS_KEY" "CHANGE-ME-run-setup-sh"

mcp_port="$(grep -E '^MCP_PORT=' .env | head -n1 | cut -d= -f2-)"
mcp_port="${mcp_port:-8000}"
mcp_key="$(grep -E '^MCP_ACCESS_KEY=' .env | head -n1 | cut -d= -f2-)"

cat <<EOF

Setup complete.

MCP endpoint:    http://localhost:${mcp_port}
MCP access key:  ${mcp_key}

Before running 'docker compose up -d', edit .env and set EMBEDDING_MODEL and
CHAT_MODEL to model identifiers loaded in your LM Studio instance, and
LM_STUDIO_URL if LM Studio runs on a different machine than this one.
EOF
