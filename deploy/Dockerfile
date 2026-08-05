# Flow server image — runs the SAME `flow` CLI as every other install, in
# prod mode, headless. One container = one deployment (dashboard + per-project
# gateway/orchestrator processes); FalkorDB runs as a sidecar service (see
# docker-compose.yml) and is reached via FALKOR_HOST, so the CLI never touches
# Docker from inside the container.
#
# Build from the REPO ROOT (the compose file does this for you):
#   docker build -f deploy/Dockerfile -t flow .
FROM node:22

# The indexer runs through a real coding CLI (opencode), driven headless with
# an OpenRouter key. opencode is NOT bundled with Flow (resolved from PATH), so
# a headless server MUST ship it or every index/answer job fails at spawn with
# "opencode CLI not found on PATH" — even when the user has provided an
# OpenRouter key (OpenRouter is opencode's model provider, not a substitute for
# the binary). Same install path setup.sh uses on Linux.
RUN curl -fsSL https://opencode.ai/install | bash \
    && ln -s /root/.opencode/bin/opencode /usr/local/bin/opencode \
    && opencode --version

WORKDIR /app

# Dependency layer first so code-only changes don't re-run npm install.
COPY package.json package-lock.json ./
COPY scripts/check-node.mjs scripts/check-node.mjs
COPY orchestrator/package.json orchestrator/package.json
COPY graph-gateway/package.json graph-gateway/package.json
COPY dashboard/package.json dashboard/package.json
RUN npm install --no-audit --no-fund

COPY . .

# data/ (projects, auth store, logs, SQLite) lives on a volume.
VOLUME /app/data

ENV FLOW_NO_UPDATE=1 \
    FALKOR_HOST=falkordb \
    FALKOR_PORT=6379 \
    FLOW_PROJECT=main

# Only the dashboard is meant to be published; gateway/orchestrator bind
# 127.0.0.1 inside the container by design.
EXPOSE 7600

ENTRYPOINT ["bash", "deploy/entrypoint.sh"]
