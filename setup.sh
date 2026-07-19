#!/usr/bin/env bash
# setup.sh — Flow development setup
#
# Usage:
#   ./setup.sh [OPTIONS]
#
# Options:
#   --alias <name>     Register this checkout as a named command (e.g. flow-dev, flow-main).
#                      Creates a wrapper in ~/bin or ~/.local/bin.
#   --branch <name>    Check out this git branch before setup (useful for a fresh worktree).
#   --help             Show this help and exit.
#
# Examples:
#   ./setup.sh                                  # Install deps, check CLIs
#   ./setup.sh --alias flow-dev                 # Also register as 'flow-dev' command
#   ./setup.sh --alias flow-main --branch main  # Checkout main, install, register
#
# Multi-branch dev workflow:
#   git worktree add ../flow-main main
#   cd ../flow-main && ../flow/setup.sh --alias flow-main
#   cd ../flow-dev  && ../flow/setup.sh --alias flow-dev
#   # Now 'flow-main up myproject' and 'flow-dev up myproject' are independent.
#
# Platform:
#   macOS and Linux: run natively.
#   Windows: use Git Bash or WSL2.

set -euo pipefail

ALIAS_NAME=""
BRANCH=""

show_help() {
  sed -n '/^# /s/^# //p' "$0" | head -30
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --alias)   ALIAS_NAME="${2:-}"; shift 2 ;;
    --branch)  BRANCH="${2:-}"; shift 2 ;;
    --help|-h) show_help; exit 0 ;;
    *) echo "Unknown option: $1  (run with --help for usage)"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Colours ──────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; NC=''
fi
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
fail() { echo -e "${RED}✗${NC} $*" >&2; exit 1; }
info() { echo -e "${CYAN}→${NC} $*"; }
hdr()  { echo -e "\n${BOLD}$*${NC}"; }

# ── 1. Branch checkout ───────────────────────────────────────────────────────
if [[ -n "$BRANCH" ]]; then
  hdr "Branch"
  info "Checking out: $BRANCH"
  git -C "$SCRIPT_DIR" checkout "$BRANCH" \
    || fail "Could not check out branch '$BRANCH'. Make sure it exists (git fetch first)."
  ok "On branch $BRANCH"
fi

# ── 2. Node.js version ───────────────────────────────────────────────────────
hdr "Node.js"
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install v22+ from https://nodejs.org"
fi
NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  fail "Node.js v22+ required (found $(node --version)). Upgrade from https://nodejs.org"
fi
ok "$(node --version)"

# ── 3. npm install ───────────────────────────────────────────────────────────
hdr "Dependencies"
info "Running npm install…"
npm install --prefix "$SCRIPT_DIR" 2>&1 | tail -3
ok "Installed"

# ── 4. Coding CLI detection ──────────────────────────────────────────────────
# Flow indexes repos through whichever coding CLI the user already has
# (claude, codex, or opencode). If none is installed, we install opencode via
# a proper signed channel (Homebrew / the official installer) — NEVER the npm
# package: its binary ships unsigned and macOS kills it at exec.

detect_cli() {
  FOUND_CLI=""
  for cli in claude codex opencode; do
    # Skip binaries that live inside Flow's own node_modules (bundled copies).
    # The user's real install must be somewhere else on PATH.
    if command -v "$cli" &>/dev/null; then
      candidate="$(command -v "$cli")"
      real="$(realpath "$candidate" 2>/dev/null || echo "$candidate")"
      if [[ "$real" != *"/node_modules/"* ]]; then
        FOUND_CLI="$cli"
        return 0
      fi
    fi
  done
  return 1
}

install_opencode() {
  local os
  os="$(uname -s)"
  case "$os" in
    Darwin)
      if command -v brew &>/dev/null; then
        info "Installing opencode via Homebrew…"
        brew install sst/tap/opencode && return 0
        warn "Homebrew install failed; trying the official installer…"
      fi
      info "Installing opencode via the official installer…"
      curl -fsSL https://opencode.ai/install | bash && return 0
      ;;
    Linux)
      info "Installing opencode via the official installer…"
      curl -fsSL https://opencode.ai/install | bash && return 0
      if command -v brew &>/dev/null; then
        warn "Official installer failed; trying Homebrew…"
        brew install sst/tap/opencode && return 0
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      # Windows has no Gatekeeper — the npm build runs fine there.
      if command -v npm &>/dev/null; then
        info "Installing opencode via npm…"
        npm install -g opencode-ai@latest && return 0
      fi
      ;;
  esac
  return 1
}

hdr "Coding CLI"
if detect_cli; then
  ok "Found: $FOUND_CLI → $(command -v "$FOUND_CLI")"
else
  warn "No coding CLI found on PATH (claude, codex, or opencode)."
  echo ""
  echo "  Flow needs one to index your repos. If you have your own, install any of:"
  echo "    Claude Code:  npm install -g @anthropic-ai/claude-code"
  echo "    Codex:        npm install -g @openai/codex"
  echo ""
  DO_INSTALL="y"
  if [[ -t 0 ]]; then
    read -r -p "  Install opencode now? [Y/n] " yn
    [[ "$yn" =~ ^[Nn]$ ]] && DO_INSTALL="n"
  else
    info "Non-interactive shell — installing opencode automatically."
  fi

  if [[ "$DO_INSTALL" == "y" ]]; then
    if install_opencode; then
      # The installer may have put opencode somewhere not yet on PATH
      # (e.g. ~/.opencode/bin) — pick it up for this session and re-detect.
      for extra_dir in "$HOME/.opencode/bin" "$HOME/.local/bin" "/opt/homebrew/bin"; do
        [[ -d "$extra_dir" ]] && export PATH="$extra_dir:$PATH"
      done
      if detect_cli; then
        ok "Installed: $FOUND_CLI → $(command -v "$FOUND_CLI")"
        if [[ "$(command -v opencode)" == "$HOME/.opencode/bin/opencode" ]]; then
          warn "Ensure ~/.opencode/bin is on PATH in your shell profile (the installer usually adds it)."
        fi
      else
        fail "opencode installed but not found on PATH — open a new terminal and re-run setup.sh"
      fi
    else
      fail "Could not install opencode automatically. Install a coding CLI manually and re-run setup.sh"
    fi
  else
    warn "Skipping — Flow will start, but index jobs will fail until a CLI is installed."
  fi
fi

# ── 5. Docker / FalkorDB ─────────────────────────────────────────────────────
hdr "Docker"
if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
  ok "Docker is running"
else
  warn "Docker not running — FalkorDB won't start. Flow needs Docker for its graph store."
  warn "Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
fi

# ── 6. Alias registration ────────────────────────────────────────────────────
if [[ -n "$ALIAS_NAME" ]]; then
  hdr "Alias: $ALIAS_NAME"

  FLOW_BIN="$SCRIPT_DIR/bin/flow.mjs"

  # Find or create a user bin directory that's on PATH.
  BIN_DIR=""
  for candidate_dir in "$HOME/.local/bin" "$HOME/bin" "/usr/local/bin"; do
    if [[ -d "$candidate_dir" ]]; then
      # Check if it's on PATH.
      if [[ ":$PATH:" == *":$candidate_dir:"* ]]; then
        BIN_DIR="$candidate_dir"
        break
      fi
    fi
  done

  if [[ -z "$BIN_DIR" ]]; then
    BIN_DIR="$HOME/.local/bin"
    mkdir -p "$BIN_DIR"
    warn "Created $BIN_DIR"
    warn "Add it to your shell profile so the alias is available:"
    warn "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc  # or ~/.bashrc"
  fi

  WRAPPER="$BIN_DIR/$ALIAS_NAME"
  cat > "$WRAPPER" <<WRAPPER_EOF
#!/usr/bin/env bash
# Flow CLI alias — auto-generated by setup.sh
# Checkout: $SCRIPT_DIR
exec node "$FLOW_BIN" "\$@"
WRAPPER_EOF
  chmod +x "$WRAPPER"
  ok "Registered '$ALIAS_NAME' → $FLOW_BIN"

  if command -v "$ALIAS_NAME" &>/dev/null 2>&1; then
    ok "'$ALIAS_NAME' is reachable on PATH"
  else
    warn "Run 'source ~/.zshrc' (or open a new terminal) to pick up the new command."
  fi
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}Setup complete!${NC}"
if [[ -n "$ALIAS_NAME" ]]; then
  echo "  Run: ${BOLD}$ALIAS_NAME --help${NC}"
  echo "  Run: ${BOLD}$ALIAS_NAME project create <name>${NC}"
else
  echo "  Run: ${BOLD}node $SCRIPT_DIR/bin/flow.mjs --help${NC}"
fi
echo ""
