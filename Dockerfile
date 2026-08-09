# Release Sentinel control plane — long-running Node process (not static hosting).
# Requires SWYTCHCODE_TOKEN plus the usual GitHub/Netlify/Jira/Notion/LLM secrets.
FROM node:20-bookworm-slim

WORKDIR /app

# System deps some native packages expect; keep the image small otherwise.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# swytchcode CLI is required by @swytchcode/runtime (spawnSync).
# tsx is a production dependency so worker threads inherit a resolvable loader.
RUN npm ci --omit=dev \
  && npm install swytchcode@^2 --no-save \
  && npm cache clean --force

# App source + Swytchcode tooling (methods already enabled in tooling.json).
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY .swytchcode ./.swytchcode

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Boot Node with the same absolute tsx loader flags the worker thread uses.
# `npx tsx` works locally but worker_threads on Render need resolvable paths.
CMD ["node", "--require", "tsx/dist/preflight.cjs", "--import", "tsx/dist/loader.mjs", "src/server.ts"]
