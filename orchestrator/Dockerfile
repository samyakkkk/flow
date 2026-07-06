FROM node:22-slim

# Build tools required by better-sqlite3 (native module)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install all deps (tsx is a devDep but required at runtime — no compile step)
COPY package.json package-lock.json ./
RUN npm ci

# Copy TypeScript source only (test/ and data/ are excluded)
COPY src/ ./src/
COPY tsconfig.json ./

# Create writable data directory for SQLite (flow.db)
# Volume mount at /app/data preserves ownership on first run.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 7500

CMD ["node_modules/.bin/tsx", "src/index.ts"]
