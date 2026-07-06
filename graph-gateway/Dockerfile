FROM node:22-slim

WORKDIR /app

# Install dependencies (all deps: tsx is a devDep but needed at runtime)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./

# Journal directory (written to data/journal.jsonl relative to src/)
RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 7433

# tsx runs TypeScript directly — no compile step needed
CMD ["node_modules/.bin/tsx", "src/server.ts"]
