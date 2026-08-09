# Release Sentinel control plane — long-running Node process (not static hosting).
# Requires SWYTCHCODE_TOKEN plus the usual GitHub/Netlify/Jira/Notion/LLM secrets.
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# Bump when npm layer cache must be invalidated on Render.
ARG NPM_CACHE_BUST=2026-08-10-bootstrap
RUN echo "npm-cache-bust=$NPM_CACHE_BUST" \
  && npm ci --omit=dev \
  && npm install swytchcode@^2 --no-save \
  && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY .swytchcode ./.swytchcode
COPY scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
RUN chmod +x ./scripts/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Bundles are not in git; entrypoint runs `swytchcode bootstrap` on first boot
# using SWYTCHCODE_TOKEN from the Render environment, then starts the server.
CMD ["./scripts/docker-entrypoint.sh"]
