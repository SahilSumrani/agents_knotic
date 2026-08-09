import { loadConfig } from "./config.ts";
import { runPipeline } from "./pipeline.ts";
import type { RunState, WorkerEvent } from "./types.ts";

/**
 * Runs one pipeline pass in a child process.
 *
 * This exists because `@swytchcode/runtime`'s `exec()` is built on `spawnSync`,
 * which blocks the event loop. Isolating the pipeline here keeps the Express
 * server free to serve the UI and SSE stream while the agent works.
 *
 * Implemented as a child process (not a worker_thread) because Node on Render
 * does not reliably apply the tsx loader inside worker_threads, which produced
 * ERR_UNKNOWN_FILE_EXTENSION for worker.ts. A child process booted the same
 * way as the server (`node --import tsx …`) loads TypeScript correctly.
 */

function post(event: WorkerEvent): void {
  if (typeof process.send === "function") {
    process.send(event);
    return;
  }
  // Fallback when someone runs the file directly in a terminal.
  console.log(JSON.stringify(event));
}

const triggerArg = process.argv[2];
const trigger = (
  triggerArg === "poll" || triggerArg === "manual" ? triggerArg : "manual"
) as RunState["trigger"];

try {
  const config = loadConfig();
  const run = await runPipeline(config, trigger, {
    onUpdate: (state) => post({ type: "run:updated", run: structuredClone(state) }),
    onLog: (entry) => post({ type: "log", ...entry }),
  });
  post({ type: "run:finished", run: structuredClone(run) });
  process.exitCode = 0;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  post({
    type: "log",
    at: new Date().toISOString(),
    level: "error",
    message: `worker crashed: ${message}`,
  });
  process.exitCode = 1;
}
