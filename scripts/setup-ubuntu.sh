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

is_repo_root() {
  [ -f "$1/package.json" ] \
    && [ -f "$1/pnpm-lock.yaml" ] \
    && grep -q '"name": "fentaris"' "$1/package.json"
}

search_upward_for_repo() {
  local dir
  dir="$(cd "$1" 2>/dev/null && pwd)" || return 1

  while [ "$dir" != "/" ]; do
    if is_repo_root "$dir"; then
      printf '%s\n' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done

  return 1
}

search_cloud_workspaces_for_repo() {
  local base candidate matches
  matches=""

  for base in \
    "$PWD" \
    "${GITHUB_WORKSPACE:-}" \
    "${WORKSPACE:-}" \
    "${PROJECT_DIR:-}" \
    "${REPO_DIR:-}" \
    /workspace \
    /workspaces \
    /mnt/data \
    /repo \
    /app \
    /home \
    /root \
    /tmp; do
    [ -n "$base" ] && [ -d "$base" ] || continue
    base="$(cd "$base" && pwd -P)"

    while IFS= read -r candidate; do
      candidate="$(dirname "$candidate")"
      if is_repo_root "$candidate"; then
        case "
$matches
" in
          *"
$candidate
"*) ;;
          *) matches="${matches}${candidate}
" ;;
        esac
      fi
    done < <(find "$base" -maxdepth 5 -name package.json -type f 2>/dev/null)
  done

  if [ "$(printf '%s' "$matches" | sed '/^$/d' | wc -l)" -eq 1 ]; then
    printf '%s' "$matches" | sed '/^$/d'
    return 0
  fi

  return 1
}

resolve_repo_root() {
  local script_path script_dir repo_root
  script_path="${BASH_SOURCE[0]:-$0}"
  script_dir="$(cd -- "$(dirname -- "$script_path")" && pwd)"

  if [ -n "${FENTARIS_REPO_ROOT:-}" ]; then
    repo_root="$(cd "$FENTARIS_REPO_ROOT" && pwd)"
  elif repo_root="$(search_upward_for_repo "$PWD")"; then
    :
  elif repo_root="$(search_upward_for_repo "$script_dir")"; then
    :
  elif repo_root="$(search_cloud_workspaces_for_repo)"; then
    :
  elif command_exists git && repo_root="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null)" && is_repo_root "$repo_root"; then
    :
  else
    fail "repository root not found; set FENTARIS_REPO_ROOT or run from the cloned repository workspace"
  fi

  is_repo_root "$repo_root" || fail "invalid repository root '${repo_root}'; expected the Fentaris package.json and pnpm-lock.yaml"

  printf '%s\n' "$repo_root"
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

  hash -r 2>/dev/null || true

  if [ -x /usr/bin/node ] && [ "$(/usr/bin/node --version | sed -E 's/^v([0-9]+).*/\1/')" -ge "$NODE_MAJOR" ]; then
    export PATH="/usr/bin:${PATH}"
    hash -r 2>/dev/null || true
  fi

  installed_major="$(node_major_version || true)"
  [ -n "$installed_major" ] && [ "$installed_major" -ge "$NODE_MAJOR" ] \
    || fail "Node ${NODE_MAJOR}+ is required, but $(command -v node 2>/dev/null || printf node) reports $(node --version 2>/dev/null || printf unavailable)"
}

install_pnpm() {
  log "Enabling Corepack and preparing pnpm ${PNPM_VERSION}"
  run_as_root corepack enable
  run_as_root corepack prepare "pnpm@${PNPM_VERSION}" --activate
}

install_project_dependencies() {
  local repo_root
  repo_root="$(resolve_repo_root)"

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
