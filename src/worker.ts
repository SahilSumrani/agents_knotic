import { parentPort, workerData } from "node:worker_threads";
import { loadConfig } from "./config.ts";
import { runPipeline } from "./pipeline.ts";
import type { RunState, WorkerEvent } from "./types.ts";

/**
 * Runs one pipeline pass in a worker thread.
 *
 * This exists because `@swytchcode/runtime`'s `exec()` is built on `spawnSync`,
 * which blocks the event loop for the whole duration of the CLI subprocess and
 * its HTTP call. Running the pipeline on the main thread would freeze the
 * Express server and stall the SSE stream for tens of seconds per run, so the
 * dashboard would replay the whole timeline at the end instead of live. Isolating
 * it here keeps the main thread free to serve the UI while the agent works.
 */

if (!parentPort) {
  throw new Error("worker.ts must be started as a worker thread");
}

const port = parentPort;

function post(event: WorkerEvent): void {
  port.postMessage(event);
}

const trigger = (workerData?.trigger ?? "manual") as RunState["trigger"];

try {
  const config = loadConfig();
  const run = await runPipeline(config, trigger, {
    onUpdate: (state) => post({ type: "run:updated", run: structuredClone(state) }),
    onLog: (entry) => post({ type: "log", ...entry }),
  });
  post({ type: "run:finished", run: structuredClone(run) });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  post({
    type: "log",
    at: new Date().toISOString(),
    level: "error",
    message: `worker crashed: ${message}`,
  });
  throw error;
}
