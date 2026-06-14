#!/usr/bin/env bash
set -Eeuo pipefail

NODE_MAJOR="${NODE_MAJOR:-24}"
PNPM_VERSION="${PNPM_VERSION:-11.4.0}"

log() {
  printf '[setup-ubuntu] %s\n' "$*"
}

fail() {
  printf '[setup-ubuntu] ERROR: %s\n' "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi

  if command_exists sudo; then
    sudo -n "$@"
    return
  fi

  fail "run as root or configure passwordless sudo for non-interactive setup"
}

detect_ubuntu() {
  [ -r /etc/os-release ] || fail "cannot detect OS: /etc/os-release not found"
  # shellcheck disable=SC1091
  . /etc/os-release

  [ "${ID:-}" = "ubuntu" ] || fail "unsupported OS '${ID:-unknown}'; this script targets Ubuntu"
}

node_major_version() {
  node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'
}

install_system_packages() {
  export DEBIAN_FRONTEND=noninteractive

  log "Installing Ubuntu build dependencies"
  run_as_root apt-get update
  run_as_root apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gnupg \
    python3 \
    build-essential
}

install_node() {
  local installed_major
  installed_major="$(node_major_version || true)"

  if [ -n "$installed_major" ] && [ "$installed_major" -ge "$NODE_MAJOR" ]; then
    log "Node $(node --version) already satisfies Node ${NODE_MAJOR}+"
    return
  fi

  log "Installing Node.js ${NODE_MAJOR}.x from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | run_as_root bash -
  run_as_root apt-get install -y --no-install-recommends nodejs
}

install_pnpm() {
  log "Enabling Corepack and preparing pnpm ${PNPM_VERSION}"
  run_as_root corepack enable
  run_as_root corepack prepare "pnpm@${PNPM_VERSION}" --activate
}

install_project_dependencies() {
  local script_dir repo_root
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(cd -- "${script_dir}/.." && pwd)"

  cd "$repo_root"

  log "Installing project dependencies in ${repo_root}"
  pnpm install --frozen-lockfile

  log "Installed versions:"
  node --version
  pnpm --version
}

main() {
  detect_ubuntu
  install_system_packages
  install_node
  install_pnpm
  install_project_dependencies
}

main "$@"
