#!/usr/bin/env node
/**
 * Builds site/ into dist/.
 *
 * The asset check is not decoration: it gives the demo a *real* build failure to
 * recover from. Renaming or deleting a referenced asset in a commit makes this
 * script exit non-zero, Netlify reports the deploy as `error`, and Release
 * Sentinel rolls the site back on its own. That is far more honest than faking a
 * failure with a hardcoded `exit 1`.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "site");
const outDir = join(root, "dist");

/** Local (non-absolute, non-protocol) href/src targets referenced by the HTML. */
function localReferences(html) {
  const refs = new Set();
  const pattern = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const ref = match[1];
    if (/^(?:[a-z]+:)?\/\//i.test(ref) || ref.startsWith("#") || ref.startsWith("data:")) {
      continue;
    }
    refs.add(ref.replace(/^\.\//, "").split(/[?#]/)[0]);
  }
  return [...refs];
}

const html = await readFile(join(srcDir, "index.html"), "utf8");
const present = new Set(await readdir(srcDir));
const missing = localReferences(html).filter((ref) => !present.has(ref));

if (missing.length > 0) {
  console.error("Build failed: index.html references assets that do not exist:");
  for (const ref of missing) console.error(`  - ${ref}`);
  console.error("\nAdd the file or remove the reference, then rebuild.");
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(srcDir, outDir, { recursive: true });

// Stamp the build so a deployed page can be told apart from a stale cache.
const stamp = process.env.COMMIT_REF?.slice(0, 7) ?? new Date().toISOString();
await writeFile(
  join(outDir, "index.html"),
  html.replace("<html lang=\"en\">", `<html lang="en" data-build="${stamp}">`),
  "utf8",
);

console.log(`Built ${localReferences(html).length + 1} file(s) into dist/ (build ${stamp})`);
