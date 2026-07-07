FROM node:22-slim

# Fallback build tools only. better-sqlite3 (^12) and opencode-ai ship prebuilt
# binaries for linux-x64/arm64, so a normal install compiles nothing — these are
# kept purely as a safety net if a prebuild is ever unavailable for this arch.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install all deps (tsx is a devDep but required at runtime — no compile step).
# `npm install` from package.json only: workspace members carry no standalone
# lockfile (the root package-lock.json is the single source of truth, but it
# lives outside this build context).
COPY package.json ./
RUN npm install --no-audit --no-fund

# Copy TypeScript source only (test/ and data/ are excluded)
COPY src/ ./src/
COPY tsconfig.json ./

# Create writable data directory for SQLite (flow.db)
# Volume mount at /app/data preserves ownership on first run.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 7500

CMD ["node_modules/.bin/tsx", "src/index.ts"]
