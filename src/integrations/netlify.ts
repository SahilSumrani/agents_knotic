import type { Config } from "../config.ts";
import type { SwytchcodeClient } from "../swytch.ts";
import type { DeployRef } from "../types.ts";
import { asArray, unwrap } from "./response.ts";

/**
 * The deploy half of the loop: trigger, watch, cancel, roll back.
 *
 * Deploys are triggered with `netlify.build.create` (a real git-linked build)
 * rather than the file-digest deploy API. That matters because a build runs the
 * site's actual build command, so broken code produces a genuine `error` state
 * for the agent to recover from — a digest upload of prebuilt files would always
 * succeed and there would be nothing to self-heal.
 */

/** Netlify deploy states that mean the build finished successfully. */
const SUCCESS_STATES = new Set(["ready", "current"]);
/** States that mean it will never succeed. */
const FAILURE_STATES = new Set(["error", "failed", "rejected"]);

interface RawDeploy {
  id?: string;
  state?: string;
  deploy_ssl_url?: string;
  ssl_url?: string;
  deploy_url?: string;
  url?: string;
  admin_url?: string;
  error_message?: string;
  commit_ref?: string;
  created_at?: string;
}

function toDeployRef(raw: RawDeploy | undefined): DeployRef {
  return {
    id: raw?.id ?? "",
    state: raw?.state ?? "unknown",
    url: raw?.deploy_ssl_url ?? raw?.ssl_url ?? raw?.deploy_url ?? raw?.url,
    adminUrl: raw?.admin_url,
    errorMessage: raw?.error_message,
  };
}

export interface DeploySettleResult {
  deploy: DeployRef;
  outcome: "succeeded" | "failed" | "timeout";
}

export class NetlifyIntegration {
  constructor(
    private readonly swytch: SwytchcodeClient,
    private readonly config: Config,
  ) {}

  get configured(): boolean {
    return (
      this.config.netlify.auth !== "Bearer " &&
      Boolean(this.config.netlify.siteId)
    );
  }

  private get auth(): string {
    return this.config.netlify.auth;
  }

  private get siteId(): string {
    return this.config.netlify.siteId;
  }

  async getSite(): Promise<{ name: string; url: string; adminUrl: string }> {
    const raw = await this.swytch.call("netlify.site.get", {
      site_id: this.siteId,
      Authorization: this.auth,
    });
    const site = unwrap<{ name?: string; ssl_url?: string; url?: string; admin_url?: string }>(
      "netlify get site",
      raw,
    );
    return {
      name: site?.name ?? "unknown",
      url: site?.ssl_url ?? site?.url ?? "",
      adminUrl: site?.admin_url ?? "",
    };
  }

  /**
   * Kicks off a build of the linked repo. Returns the deploy id when Netlify
   * reports one; a build request occasionally returns only a build record, in
   * which case the caller falls back to polling the deploy list.
   */
  async triggerBuild(title: string): Promise<{ buildId: string; deployId: string }> {
    const raw = await this.swytch.call(
      "netlify.build.create",
      {
        site_id: this.siteId,
        title: title.slice(0, 100),
        Authorization: this.auth,
      },
      { maxAttempts: 1 },
    );
    const build = unwrap<{ id?: string; deploy_id?: string }>(
      "netlify trigger build",
      raw,
    );
    return { buildId: build?.id ?? "", deployId: build?.deploy_id ?? "" };
  }

  async getDeploy(deployId: string): Promise<DeployRef> {
    const raw = await this.swytch.call("netlify.deploy.get.1", {
      site_id: this.siteId,
      deploy_id: deployId,
      Authorization: this.auth,
    });
    return toDeployRef(unwrap<RawDeploy>("netlify get deploy", raw));
  }

  async listDeploys(limit = 10): Promise<DeployRef[]> {
    const raw = await this.swytch.call("netlify.deploy.get", {
      site_id: this.siteId,
      Authorization: this.auth,
    });
    return asArray<RawDeploy>(unwrap("netlify list deploys", raw))
      .slice(0, limit)
      .map(toDeployRef);
  }

  /** The newest deploy, used to identify a build that we could not get an id for. */
  async latestDeploy(): Promise<DeployRef | undefined> {
    const deploys = await this.listDeploys(1);
    return deploys[0];
  }

  /**
   * The last deploy that successfully published, excluding `excludeId`. This is
   * the rollback target after a failed release.
   */
  async lastGoodDeploy(excludeId?: string): Promise<DeployRef | undefined> {
    const deploys = await this.listDeploys(20);
    return deploys.find(
      (deploy) =>
        deploy.id !== excludeId && SUCCESS_STATES.has(deploy.state.toLowerCase()),
    );
  }

  /** Polls until the deploy reaches a terminal state or the timeout elapses. */
  async waitForDeploy(
    deployId: string,
    onTick?: (deploy: DeployRef) => void,
  ): Promise<DeploySettleResult> {
    const deadline = Date.now() + this.config.agent.deployTimeoutMs;
    let last: DeployRef = { id: deployId, state: "pending" };

    while (Date.now() < deadline) {
      last = await this.getDeploy(deployId);
      onTick?.(last);

      const state = last.state.toLowerCase();
      if (SUCCESS_STATES.has(state)) return { deploy: last, outcome: "succeeded" };
      if (FAILURE_STATES.has(state)) return { deploy: last, outcome: "failed" };

      await new Promise((resolve) =>
        setTimeout(resolve, this.config.agent.deployPollIntervalMs),
      );
    }

    return { deploy: last, outcome: "timeout" };
  }

  async cancelDeploy(deployId: string): Promise<DeployRef> {
    const raw = await this.swytch.call(
      "netlify.cancel.create",
      { deploy_id: deployId, Authorization: this.auth },
      { maxAttempts: 1 },
    );
    return toDeployRef(unwrap<RawDeploy>("netlify cancel deploy", raw));
  }

  /**
   * Cancelling is best-effort during recovery: Netlify rejects the call for a
   * deploy that already reached a terminal state, and that must not derail the
   * rollback that follows.
   */
  async tryCancel(deployId: string): Promise<boolean> {
    try {
      await this.cancelDeploy(deployId);
      return true;
    } catch {
      return false;
    }
  }

  /** Republishes a previous deploy — the actual rollback. */
  async restoreDeploy(deployId: string): Promise<DeployRef> {
    const raw = await this.swytch.call(
      "netlify.deploy.restore.create",
      {
        site_id: this.siteId,
        deploy_id: deployId,
        Authorization: this.auth,
      },
      { maxAttempts: 1 },
    );
    return toDeployRef(unwrap<RawDeploy>("netlify restore deploy", raw));
  }
}

export { SUCCESS_STATES, FAILURE_STATES };
