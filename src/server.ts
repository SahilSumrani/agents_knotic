import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import express from "express";
import { checkReadiness, loadConfig } from "./config.ts";
import { RunStore } from "./store.ts";
import type { WorkerEvent } from "./types.ts";

/**
 * HTTP surface and live dashboard.
 *
 * The server never runs the pipeline itself; it spawns the worker (see worker.ts
 * for why) and fans worker messages out to browsers over SSE.
 */

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const config = loadConfig();
const store = new RunStore();
const app = express();

app.use(express.json());
app.use(express.static(join(here, "..", "public")));

let currentWorker: Worker | undefined;

/**
 * Absolute tsx loader flags for worker_threads.
 *
 * Use the package export paths (`tsx/preflight`, `tsx`), not `tsx/dist/...`,
 * which Node rejects with ERR_PACKAGE_PATH_NOT_EXPORTED. Resolving to absolute
 * filesystem paths matches how the `tsx` CLI itself boots Node.
 */
function workerExecArgv(): string[] {
  const preflight = require.resolve("tsx/preflight");
  const loader = pathToFileURL(require.resolve("tsx")).href;
  return ["--require", preflight, "--import", loader];
}

function startRun(trigger: "manual" | "poll"): { started: boolean; reason?: string } {
  // One run at a time: concurrent runs would race on the same Netlify site and
  // could roll back a deploy another run is still verifying.
  if (currentWorker) return { started: false, reason: "a run is already in progress" };

  const execArgv = workerExecArgv();
  console.log(`[worker] spawning with execArgv=${JSON.stringify(execArgv)}`);

  const worker = new Worker(join(here, "worker.ts"), {
    workerData: { trigger },
    execArgv,
  });
  currentWorker = worker;

  worker.on("message", (event: WorkerEvent) => {
    if (event.type === "log") {
      store.broadcast("log", event);
      return;
    }
    store.upsert(event.run);
    store.markActive(event.type === "run:finished" ? undefined : event.run.id);
    store.broadcast(event.type === "run:finished" ? "finished" : "run", event.run);
  });

  const release = () => {
    currentWorker = undefined;
    store.markActive(undefined);
  };

  worker.on("error", (error) => {
    // Also to the console: a worker that dies before its first message leaves
    // nothing in the run history, so the terminal is the only place to see why.
    console.error(`[worker] ${error.stack ?? error.message}`);
    store.broadcast("log", {
      type: "log",
      at: new Date().toISOString(),
      level: "error",
      message: `worker error: ${error.message}`,
    });
    release();
  });

  worker.on("exit", (code) => {
    if (code !== 0) console.error(`[worker] exited with code ${code}`);
    release();
    store.broadcast("idle", { active: false });
  });

  return { started: true };
}

app.get("/api/state", (_req, res) => {
  res.json({
    repo: `${config.github.owner}/${config.github.repo}`,
    branch: config.github.branch,
    siteId: config.netlify.siteId,
    riskThreshold: config.agent.riskThreshold,
    dryRun: config.agent.dryRun,
    model: `${config.llm.provider}:${config.llm.model}`,
    readiness: checkReadiness(config),
    active: store.active,
    runs: store.list(),
  });
});

app.post("/api/runs", (_req, res) => {
  const result = startRun("manual");
  if (!result.started) {
    res.status(409).json({ error: result.reason });
    return;
  }
  res.status(202).json({ ok: true });
});

app.get("/api/runs/:id", (req, res) => {
  const run = store.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  res.json(run);
});

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // Without this, a proxy may buffer the stream and defeat the point of SSE.
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");

  const unsubscribe = store.subscribe((payload) => res.write(payload));

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.listen(config.server.port, () => {
  const problems = checkReadiness(config);
  const blocking = problems.filter((problem) => problem.blocking);

  console.log(`Release Sentinel listening on http://localhost:${config.server.port}`);
  if (problems.length === 0) {
    console.log("All integrations configured.");
    return;
  }
  console.log("Configuration gaps:");
  for (const problem of problems) {
    console.log(`  ${problem.blocking ? "[blocking]" : "[degraded]"} ${problem.service}: ${problem.detail}`);
  }
  if (blocking.length > 0) {
    console.log("Fill in .env before starting a run (see .env.example).");
  }
});
