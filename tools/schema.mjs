#!/usr/bin/env node
/**
 * Prints the Summary / Inputs / HTTP Headers sections of `swytchcode info <id>`
 * while dropping the response-schema block, which is often thousands of lines
 * and drowns out the request contract we actually need when wiring a method.
 *
 * Usage: node tools/schema.mjs <canonical_id> [...more ids]
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const run = promisify(execFile);

// Invoke the CLI's JS entrypoint with the current node binary. Spawning the
// .cmd/.ps1 shim needs shell:true on Windows, which intermittently hangs here.
function resolveCli() {
  const require = createRequire(import.meta.url);
  const candidates = [
    process.env.SWYTCHCODE_BIN,
    `${process.env.APPDATA ?? ""}\\npm\\node_modules\\swytchcode\\bin\\swytchcode.js`,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      require.resolve(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error("could not locate swytchcode.js; set SWYTCHCODE_BIN");
}

const CLI = resolveCli();

async function describe(id) {
  let raw;
  try {
    const { stdout } = await run(process.execPath, [CLI, "info", id], {
      maxBuffer: 64 * 1024 * 1024,
    });
    raw = stdout;
  } catch (err) {
    return `\n### ${id}\n  !! ${(err.stderr || err.message).trim()}`;
  }

  const kept = [];
  let skipping = false;

  for (const line of raw.split(/\r?\n/)) {
    // The response schema starts at "Output:" and runs until the header block.
    if (/^Output:/.test(line)) {
      skipping = true;
      kept.push("Output: <omitted>");
      continue;
    }
    if (/^HTTP Headers/.test(line)) skipping = false;
    if (/^Suffixes such as/.test(line)) continue;
    if (!skipping) kept.push(line);
  }

  return `\n### ${id}\n${kept.join("\n").replace(/\n{3,}/g, "\n\n").trim()}`;
}

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("usage: node tools/schema.mjs <canonical_id> [...]");
  process.exit(1);
}

const results = await Promise.all(ids.map(describe));
console.log(results.join("\n"));
