#!/usr/bin/env bash
# setup.sh — Flow one-shot setup: deps, environment checks, coding CLI, and
# the `flow` command on your PATH. Run it once; you're done.
#
# Usage:
#   ./setup.sh [OPTIONS]                          # from inside a checkout
#   curl -fsSL https://<host>/setup.sh | bash     # standalone: clones the repo first
#
# Options:
#   --alias <name>     Command name to register (default: flow). Use flow-dev,
#                      flow-test-1, … to run several checkouts side by side.
#   --branch <name>    Clone this branch into its own managed checkout
#                      (~/.flow/checkouts/<alias>) instead of using the current
#                      one. Alias defaults to flow-<branch> if --alias is omitted.
#   --help             Show this help and exit.
#
# Examples:
#   ./setup.sh                                    # this checkout → `flow`
#   ./setup.sh --alias flow-dev                   # this checkout → `flow-dev`
#   ./setup.sh --alias flow-test-1 --branch feat  # clone feat → `flow-test-1`
#   curl -fsSL https://<host>/setup.sh | bash -s -- --branch dev --alias flow-dev
#
# Standalone mode (curl | bash, or the script copied outside a checkout) clones
# from https://github.com/samyakkkk/flow.git — override with FLOW_REPO=<url>.
#
# Each aliased checkout is fully independent (own deps, own data/ projects).
# Don't `up` the SAME project name from two checkouts at once — they'd race
# for the same ports.
#
# Platform: macOS and Linux natively; Windows via Git Bash or WSL2.

set -euo pipefail

ALIAS_NAME=""
BRANCH=""

show_help() {
  # Print the header comment block (everything between the shebang and the
  # first non-comment line), stripping the leading "# ".
  awk 'NR>1 && !/^#/{exit} NR>1{sub(/^# ?/,""); print}' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --alias)   ALIAS_NAME="${2:-}"; shift 2 ;;
    --branch)  BRANCH="${2:-}"; shift 2 ;;
    --help|-h) show_help; exit 0 ;;
    *) echo "Unknown option: $1  (run with --help for usage)"; exit 1 ;;
  esac
done

# Where the script itself lives. Under `curl | bash` BASH_SOURCE is unset and
# this resolves to the cwd — which is fine, because standalone detection below
# only cares whether that directory is a Flow checkout.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" && pwd)"

# Canonical repo for standalone installs (curl | bash). FLOW_REPO overrides.
REPO_URL="${FLOW_REPO:-https://github.com/samyakkkk/flow.git}"

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

# ── 1. Resolve the checkout this setup targets ───────────────────────────────
# Three ways in:
#   in-checkout, no --branch  → set up the checkout the script lives in
#   in-checkout, --branch     → clone that branch of THIS repo's origin into
#                               ~/.flow/checkouts/<alias> (independent install)
#   standalone (curl | bash)  → clone REPO_URL (--branch or its default branch)
#                               into ~/.flow/checkouts/<alias>
command -v git &>/dev/null || fail "git not found — install it first."

IN_CHECKOUT=false
[[ -f "$SCRIPT_DIR/bin/flow.mjs" ]] && IN_CHECKOUT=true

if [[ "$IN_CHECKOUT" == true && -z "$BRANCH" ]]; then
  ROOT_DIR="$SCRIPT_DIR"
  ALIAS_NAME="${ALIAS_NAME:-flow}"
else
  if [[ "$IN_CHECKOUT" == true ]]; then
    ORIGIN="$(git -C "$SCRIPT_DIR" remote get-url origin 2>/dev/null || echo "$SCRIPT_DIR")"
  else
    ORIGIN="$REPO_URL"
  fi
  if [[ -n "$BRANCH" ]]; then
    ALIAS_NAME="${ALIAS_NAME:-flow-$(echo "$BRANCH" | tr '/' '-')}"
  else
    ALIAS_NAME="${ALIAS_NAME:-flow}"
  fi
  ROOT_DIR="$HOME/.flow/checkouts/$ALIAS_NAME"

  hdr "Checkout: $ALIAS_NAME (${BRANCH:-default branch})"
  if [[ -d "$ROOT_DIR/.git" ]]; then
    info "Updating existing checkout at $ROOT_DIR"
    if [[ -n "$BRANCH" ]]; then
      git -C "$ROOT_DIR" fetch origin "$BRANCH" \
        || fail "Could not fetch branch '$BRANCH' from $ORIGIN"
      git -C "$ROOT_DIR" checkout "$BRANCH" \
        || fail "Could not check out branch '$BRANCH' in $ROOT_DIR"
      git -C "$ROOT_DIR" pull --ff-only origin "$BRANCH" \
        || warn "Could not fast-forward — local commits in $ROOT_DIR? Continuing with what's there."
    else
      git -C "$ROOT_DIR" pull --ff-only \
        || warn "Could not fast-forward — local commits in $ROOT_DIR? Continuing with what's there."
    fi
  else
    info "Cloning $ORIGIN${BRANCH:+ @ $BRANCH} → $ROOT_DIR"
    mkdir -p "$(dirname "$ROOT_DIR")"
    git clone ${BRANCH:+--branch "$BRANCH"} "$ORIGIN" "$ROOT_DIR" \
      || fail "Could not clone${BRANCH:+ branch '$BRANCH'} from $ORIGIN"
  fi
  ok "Checkout ready: $ROOT_DIR"
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
# --include=dev ALWAYS: `flow up` runs services through tsx, a devDependency.
# A shell with NODE_ENV=production would otherwise silently skip it and break
# the runtime, not just the tests.
hdr "Dependencies"
info "Running npm install…"
npm install --include=dev --prefix "$ROOT_DIR" 2>&1 | tail -3
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

# ── 6. Register the command ──────────────────────────────────────────────────
hdr "Command: $ALIAS_NAME"

FLOW_BIN="$ROOT_DIR/bin/flow.mjs"
[[ -f "$FLOW_BIN" ]] || fail "bin/flow.mjs not found in $ROOT_DIR — is this a Flow checkout?"

# Find or create a user bin directory that's on PATH.
BIN_DIR=""
for candidate_dir in "$HOME/.local/bin" "$HOME/bin" "/usr/local/bin"; do
  if [[ -d "$candidate_dir" && ":$PATH:" == *":$candidate_dir:"* && -w "$candidate_dir" ]]; then
    BIN_DIR="$candidate_dir"
    break
  fi
done

if [[ -z "$BIN_DIR" ]]; then
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
  warn "Created $BIN_DIR"
  warn "Add it to your shell profile so the command is available:"
  warn "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc  # or ~/.bashrc"
fi

WRAPPER="$BIN_DIR/$ALIAS_NAME"
cat > "$WRAPPER" <<WRAPPER_EOF
#!/usr/bin/env bash
# Flow CLI — auto-generated by setup.sh
# Checkout: $ROOT_DIR
exec node "$FLOW_BIN" "\$@"
WRAPPER_EOF
chmod +x "$WRAPPER"
ok "Registered '$ALIAS_NAME' → $FLOW_BIN"

if command -v "$ALIAS_NAME" &>/dev/null; then
  ok "'$ALIAS_NAME' is reachable on PATH"
else
  warn "Open a new terminal (or 'source ~/.zshrc') to pick up the new command."
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}Setup complete!${NC}"
echo -e "  Run: ${BOLD}$ALIAS_NAME up mycompany${NC}   # starts Flow, prints your dashboard URL"
echo ""
