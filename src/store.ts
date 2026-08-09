import type { RunState } from "./types.ts";

/**
 * In-memory history of runs plus the SSE subscriber list.
 *
 * Deliberately not persisted: a run's durable artefacts are the Jira issues, the
 * Netlify deploys and the Notion report, so a restart losing the dashboard
 * timeline costs nothing that matters.
 */

const MAX_RUNS = 25;

export type Subscriber = (payload: string) => void;

export class RunStore {
  private runs: RunState[] = [];
  private subscribers = new Set<Subscriber>();
  private activeRunId: string | undefined;

  get active(): boolean {
    return this.activeRunId !== undefined;
  }

  markActive(runId: string | undefined): void {
    this.activeRunId = runId;
  }

  upsert(run: RunState): void {
    const index = this.runs.findIndex((candidate) => candidate.id === run.id);
    if (index >= 0) this.runs[index] = run;
    else this.runs.unshift(run);
    if (this.runs.length > MAX_RUNS) this.runs.length = MAX_RUNS;
  }

  list(): RunState[] {
    return this.runs;
  }

  latest(): RunState | undefined {
    return this.runs[0];
  }

  get(id: string): RunState | undefined {
    return this.runs.find((run) => run.id === id);
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const subscriber of this.subscribers) {
      try {
        subscriber(payload);
      } catch {
        // A dead client is dropped when its own close handler fires.
      }
    }
  }
}
