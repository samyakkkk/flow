FROM node:22-slim

WORKDIR /app

# Install all dependencies (including devDeps needed for build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source files needed for Next.js build
COPY src/ ./src/
COPY public/ ./public/
COPY next.config.ts tsconfig.json postcss.config.mjs eslint.config.mjs ./

# Build the Next.js production bundle.
# ORCHESTRATOR_URL, GATEWAY_URL, and FLOW_ADMIN_TOKEN are server-side only
# (no NEXT_PUBLIC_ prefix) — they are NOT baked in at build time.
# Pass them at runtime via environment variables.
RUN npm run build

USER node

EXPOSE 7600

# next start uses the .next/ build artifact from the RUN above
CMD ["npm", "start"]
