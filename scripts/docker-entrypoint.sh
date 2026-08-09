#!/bin/sh
set -e

# Integration bundles are gitignored (large, re-fetchable). tooling.json +
# manifest.json ship in the image; we fetch wrekenfiles on first boot.
MARKER=".swytchcode/integrations/GitHub/github/1.1.4/wrekenfile.yaml"
if [ ! -f "$MARKER" ]; then
  if [ -z "${SWYTCHCODE_TOKEN:-}" ]; then
    echo "SWYTCHCODE_TOKEN is required to fetch Swytchcode integrations" >&2
    exit 1
  fi
  echo "Fetching Swytchcode integration bundles..."
  # --non-interactive avoids the demo prompt that `bootstrap` can hit under npx.
  npx swytchcode get GitHub --non-interactive --yes
  npx swytchcode get Jira --non-interactive --yes
  npx swytchcode get Netlify --non-interactive --yes
  npx swytchcode get Notion --non-interactive --yes
fi

exec npx tsx src/server.ts
