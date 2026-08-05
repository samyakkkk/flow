# Flow server image — runs the SAME `flow` CLI as every other install, in
# prod mode, headless. One container = one deployment (dashboard + per-project
# gateway/orchestrator processes); FalkorDB runs as a sidecar service (see
# docker-compose.yml) and is reached via FALKOR_HOST, so the CLI never touches
# Docker from inside the container.
#
# Build from the REPO ROOT (the compose file does this for you):
#   docker build -f deploy/Dockerfile -t flow .
FROM node:22

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
