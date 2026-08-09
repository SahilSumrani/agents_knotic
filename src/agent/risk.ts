import OpenAI from "openai";
import type { Config } from "../config.ts";
import type { EnrichedCommit, RiskFeatures, RiskVerdict } from "../types.ts";
import { heuristicScore } from "./features.ts";

/**
 * The judgement call in the loop: given commit evidence, decide whether to ship.
 *
 * The model is constrained by a strict JSON schema so the pipeline gets a typed
 * verdict rather than prose it has to parse. Its score is then floored by the
 * heuristic, so the agent cannot be talked into shipping over a failing check.
 */

const SYSTEM_PROMPT = `You are a release-risk reviewer for a continuous deployment pipeline.
You are given structured evidence about commits that are candidates for deployment to production.

Score the risk of deploying these changes right now, from 0 (trivially safe) to 100 (do not ship).

Weigh the evidence:
- Failing or pending CI checks are the strongest negative signal.
- Changes to dependency manifests, build config, CI workflows, infrastructure or database migrations carry more risk than isolated application code.
- Large diffs and many touched files raise risk.
- Commit messages signalling urgency, work-in-progress or reverts raise risk.
- Small, focused changes with passing checks are low risk.

Choose an action:
- "SHIP" when the change is safe to deploy with no follow-up.
- "SHIP_WITH_TICKET" when it is acceptable to deploy but a human should review something afterwards.
- "HOLD" when it should not be deployed until a human intervenes.

Write the rationale for an engineer reading an incident report later: reference the specific
evidence that drove the score. Be concise and concrete. Never invent facts that are not in the evidence.`;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["riskScore", "action", "rationale", "concerns", "ticketSummary", "ticketDescription"],
  properties: {
    riskScore: { type: "integer", minimum: 0, maximum: 100 },
    action: { type: "string", enum: ["SHIP", "SHIP_WITH_TICKET", "HOLD"] },
    rationale: { type: "string" },
    concerns: { type: "array", items: { type: "string" } },
    ticketSummary: {
      type: "string",
      description: "A one-line Jira summary for the follow-up or blocking ticket.",
    },
    ticketDescription: {
      type: "string",
      description: "A short Jira description explaining what a human needs to check.",
    },
  },
} as const;

/** Compact evidence payload — full diffs would be costly and add little signal. */
function buildEvidence(commits: EnrichedCommit[], features: RiskFeatures) {
  return {
    features,
    commits: commits.map((commit) => ({
      sha: commit.shortSha,
      message: commit.message,
      author: commit.author,
      additions: commit.additions,
      deletions: commit.deletions,
      checks: commit.checks,
      pullRequests: commit.pullRequests.map((pull) => pull.title),
      files: commit.files.slice(0, 25).map((file) => ({
        name: file.filename,
        status: file.status,
        churn: file.additions + file.deletions,
      })),
    })),
  };
}

export class RiskAssessor {
  private readonly client: OpenAI | undefined;

  constructor(private readonly config: Config) {
    this.client = config.openai.apiKey
      ? new OpenAI({ apiKey: config.openai.apiKey })
      : undefined;
  }

  async assess(
    commits: EnrichedCommit[],
    features: RiskFeatures,
  ): Promise<RiskVerdict> {
    const floor = heuristicScore(features);

    if (!this.client) {
      return this.fallback(features, floor, "no OPENAI_API_KEY configured");
    }

    try {
      const response = await this.client.chat.completions.create({
        model: this.config.openai.model,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify(buildEvidence(commits, features), null, 2),
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "release_risk_verdict",
            strict: true,
            schema: RESPONSE_SCHEMA,
          },
        },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("empty completion");

      const parsed = JSON.parse(content) as Omit<RiskVerdict, "degraded">;
      return this.reconcile(parsed, features, floor);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return this.fallback(features, floor, detail);
    }
  }

  /**
   * Hard evidence overrides model optimism: a failing check or a heuristic score
   * above the threshold cannot come back as SHIP.
   */
  private reconcile(
    verdict: Omit<RiskVerdict, "degraded">,
    features: RiskFeatures,
    floor: number,
  ): RiskVerdict {
    const score = Math.max(verdict.riskScore, floor);
    let action = verdict.action;
    const concerns = [...verdict.concerns];

    if (features.failedChecks > 0 && action !== "HOLD") {
      action = "HOLD";
      concerns.push(
        `overridden to HOLD: ${features.failedChecks} failing check run(s) on the candidate commit`,
      );
    } else if (score >= this.config.agent.riskThreshold && action === "SHIP") {
      action = "HOLD";
      concerns.push(
        `overridden to HOLD: risk score ${score} is at or above the configured threshold of ${this.config.agent.riskThreshold}`,
      );
    }

    return { ...verdict, riskScore: score, action, concerns, degraded: false };
  }

  private fallback(
    features: RiskFeatures,
    score: number,
    reason: string,
  ): RiskVerdict {
    const action =
      features.failedChecks > 0 || score >= this.config.agent.riskThreshold
        ? "HOLD"
        : score >= 35
          ? "SHIP_WITH_TICKET"
          : "SHIP";

    const signals =
      features.riskySignals.length > 0
        ? features.riskySignals.join("; ")
        : "no elevated risk signals detected";

    return {
      riskScore: score,
      action,
      rationale: `Scored by deterministic heuristics because the language model was unavailable (${reason}). Evidence: ${signals}. Diff touched ${features.filesChanged} file(s) across ${features.commitCount} commit(s) with ${features.churn} lines of churn.`,
      concerns: features.riskySignals,
      ticketSummary: `Review release candidate (${features.commitCount} commit(s), risk ${score})`,
      ticketDescription: `The release agent scored this candidate ${score}/100 using heuristics only, because the language model was unavailable (${reason}).\n\nSignals: ${signals}`,
      degraded: true,
    };
  }
}
