/**
 * Dashboard client. Renders whatever run state the server streams over SSE;
 * it holds no logic of its own about the agent, so the UI can never disagree
 * with what the pipeline actually did.
 */

const STEP_LABELS = {
  ingest: "Ingest GitHub activity",
  assess: "Assess release risk",
  act: "Act on the verdict",
  verify: "Verify the deploy",
  heal: "Self-heal and roll back",
  report: "Write the report",
};

const els = {
  pulse: document.getElementById("pulse"),
  runButton: document.getElementById("runButton"),
  context: document.getElementById("context"),
  readiness: document.getElementById("readiness"),
  timeline: document.getElementById("timeline"),
  verdict: document.getElementById("verdict"),
  commits: document.getElementById("commits"),
  artifacts: document.getElementById("artifacts"),
  calls: document.getElementById("calls"),
  callCount: document.getElementById("callCount"),
  callsEmpty: document.getElementById("callsEmpty"),
  log: document.getElementById("log"),
  history: document.getElementById("history"),
};

let currentRun = null;
let runs = [];
let active = false;

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

function clockTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function duration(step) {
  if (!step.startedAt || !step.finishedAt) return "";
  const ms = new Date(step.finishedAt) - new Date(step.startedAt);
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function setActive(value) {
  active = value;
  els.pulse.classList.toggle("active", value);
  els.runButton.disabled = value;
  els.runButton.textContent = value ? "Sentinel running…" : "Run Sentinel";
}

function renderContext(state) {
  const chips = [
    ["repo", `${state.repo}@${state.branch}`],
    ["model", state.model],
    ["risk threshold", state.riskThreshold],
    ["netlify site", state.siteId ? state.siteId.slice(0, 8) : "not set"],
  ];
  if (state.dryRun) chips.push(["mode", "dry run"]);

  els.context.innerHTML = chips
    .map(
      ([label, value]) =>
        `<span class="chip">${escapeHtml(label)} <strong>${escapeHtml(value)}</strong></span>`,
    )
    .join("");
}

function renderReadiness(problems) {
  if (!problems || problems.length === 0) {
    els.readiness.classList.add("hidden");
    return;
  }
  els.readiness.classList.remove("hidden");
  const blocking = problems.filter((problem) => problem.blocking).length;
  els.readiness.innerHTML = `
    <h3>${blocking > 0 ? "Setup incomplete — runs will fail" : "Some integrations are not configured and will be skipped"}</h3>
    <ul>${problems
      .map(
        (problem) =>
          `<li><code>${escapeHtml(problem.service)}</code> ${escapeHtml(problem.detail)}${problem.blocking ? " (blocking)" : ""}</li>`,
      )
      .join("")}</ul>`;
}

function renderTimeline(run) {
  const steps = run?.steps ?? Object.keys(STEP_LABELS).map((name) => ({ name, status: "pending" }));
  els.timeline.innerHTML = steps
    .map(
      (step) => `
      <li>
        <span class="dot ${escapeHtml(step.status)}"></span>
        <span>
          <span class="step-name">${escapeHtml(STEP_LABELS[step.name] ?? step.name)}</span>
          ${step.detail || step.error ? `<div class="step-detail">${escapeHtml(step.error ?? step.detail)}</div>` : ""}
        </span>
        <span class="step-time">${escapeHtml(duration(step))}</span>
      </li>`,
    )
    .join("");
}

function renderVerdict(run) {
  const verdict = run?.verdict;
  if (!verdict) {
    els.verdict.className = "verdict empty";
    els.verdict.innerHTML = "No verdict yet for this run.";
    return;
  }

  // Colour tracks severity so the score reads correctly at a glance from across a room.
  const tone =
    verdict.riskScore >= 65 ? "var(--bad)" : verdict.riskScore >= 35 ? "var(--warn)" : "var(--ok)";

  els.verdict.className = "verdict";
  els.verdict.innerHTML = `
    <div class="verdict-head">
      <div class="gauge" style="--pct:${verdict.riskScore};--tone:${tone}">
        <span>${verdict.riskScore}</span>
      </div>
      <div>
        <span class="badge ${escapeHtml(verdict.action)}">${escapeHtml(verdict.action.replace(/_/g, " "))}</span>
        ${verdict.degraded ? '<span class="degraded">heuristic fallback</span>' : ""}
        <div class="step-detail" style="margin-top:6px">risk score out of 100</div>
      </div>
    </div>
    <p class="rationale">${escapeHtml(verdict.rationale)}</p>
    ${
      verdict.concerns?.length
        ? `<ul class="concerns">${verdict.concerns.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>`
        : ""
    }`;
}

function renderCommits(run) {
  const commits = run?.commits ?? [];
  if (commits.length === 0) {
    els.commits.className = "commits empty";
    els.commits.textContent = "No commits ingested yet.";
    return;
  }
  els.commits.className = "commits";
  els.commits.innerHTML = commits
    .map((commit) => {
      const checks =
        commit.checks.failed > 0
          ? `<span class="fail">${commit.checks.failed} failing check(s)</span>`
          : commit.checks.total > 0
            ? `${commit.checks.total} check(s) passing`
            : "no checks";
      const sha = commit.url
        ? `<a href="${escapeHtml(commit.url)}" target="_blank" rel="noreferrer">${escapeHtml(commit.shortSha)}</a>`
        : escapeHtml(commit.shortSha);
      return `
        <div class="commit">
          <div class="commit-msg">${escapeHtml(commit.message)}</div>
          <div class="commit-meta">
            ${sha} · ${escapeHtml(commit.author)} ·
            <span class="add">+${commit.additions}</span>/<span class="del">-${commit.deletions}</span> ·
            ${commit.files.length} file(s) · ${checks}
          </div>
        </div>`;
    })
    .join("");
}

function renderArtifacts(run) {
  const rows = [];
  const add = (label, value, href) => {
    rows.push(`
      <div class="artifact">
        <span class="label">${escapeHtml(label)}</span>
        ${
          href
            ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(value)}</a>`
            : `<span class="value">${escapeHtml(value)}</span>`
        }
      </div>`);
  };

  if (run?.jiraIssue?.key) add("Jira review ticket", run.jiraIssue.key, run.jiraIssue.url);
  if (run?.incidentIssue?.key) add("Jira incident", run.incidentIssue.key, run.incidentIssue.url);
  if (run?.deploy?.id) add(`Deploy (${run.deploy.state})`, run.deploy.id, run.deploy.url);
  if (run?.deploy?.errorMessage) add("Netlify error", run.deploy.errorMessage);
  if (run?.restoredDeploy?.id)
    add("Rolled back to", run.restoredDeploy.id, run.restoredDeploy.url);
  if (run?.notionReportUrl) add("Notion report", "open page", run.notionReportUrl);
  if (run?.outcome) add("Outcome", run.outcome.replace(/_/g, " "));

  if (rows.length === 0) {
    els.artifacts.className = "artifacts empty";
    els.artifacts.textContent =
      "Jira issues, Netlify deploys and the Notion report will appear here as the agent creates them.";
    return;
  }
  els.artifacts.className = "artifacts";
  els.artifacts.innerHTML = rows.join("");
}

function renderCalls(run) {
  const calls = run?.swytchcodeCalls ?? [];
  els.callCount.textContent = calls.length;
  els.callsEmpty.style.display = calls.length === 0 ? "block" : "none";

  els.calls.innerHTML = calls
    .map(
      (call) => `
      <tr>
        <td><span class="tag ${escapeHtml(call.integration)}">${escapeHtml(call.integration)}</span></td>
        <td>${escapeHtml(call.canonicalId)}${call.attempts > 1 ? ` <span class="label">×${call.attempts}</span>` : ""}</td>
        <td class="num">${call.durationMs}</td>
        <td><span class="status-dot ${call.ok ? "ok" : "bad"}" title="${escapeHtml(call.error ?? "ok")}">${call.ok ? "●" : "▲"}</span></td>
      </tr>`,
    )
    .join("");
}

function renderLog(run) {
  const logs = run?.logs ?? [];
  els.log.innerHTML = logs
    .map(
      (entry) => `
      <div class="log-line ${escapeHtml(entry.level)}">
        <span class="log-time">${escapeHtml(clockTime(entry.at))}</span>
        <span class="log-msg">${escapeHtml(entry.message)}</span>
      </div>`,
    )
    .join("");
  els.log.scrollTop = els.log.scrollHeight;
}

function renderHistory() {
  const past = runs.filter((run) => run.finishedAt);
  if (past.length === 0) {
    els.history.className = "history empty";
    els.history.textContent = "No previous runs in this session.";
    return;
  }
  els.history.className = "history";
  els.history.innerHTML = past
    .map((run) => {
      const bits = [];
      if (run.verdict) bits.push(`risk ${run.verdict.riskScore} → ${run.verdict.action}`);
      if (run.commits.length) bits.push(`${run.commits.length} commit(s)`);
      if (run.jiraIssue?.key) bits.push(run.jiraIssue.key);
      if (run.incidentIssue?.key) bits.push(run.incidentIssue.key);
      bits.push(`${run.swytchcodeCalls.length} calls`);
      return `
        <div class="history-row">
          <span class="id">${escapeHtml(run.id)}</span>
          <span class="outcome ${escapeHtml(run.outcome ?? "failed")}">${escapeHtml((run.outcome ?? "failed").replace(/_/g, " "))}</span>
          <span class="label">${escapeHtml(clockTime(run.startedAt))}</span>
          <span class="step-detail">${escapeHtml(bits.join(" · "))}</span>
        </div>`;
    })
    .join("");
}

function renderRun(run) {
  currentRun = run;
  renderTimeline(run);
  renderVerdict(run);
  renderCommits(run);
  renderArtifacts(run);
  renderCalls(run);
  renderLog(run);
}

function upsertRun(run) {
  const index = runs.findIndex((candidate) => candidate.id === run.id);
  if (index >= 0) runs[index] = run;
  else runs.unshift(run);
  renderHistory();
}

async function loadState() {
  const response = await fetch("/api/state");
  const state = await response.json();
  renderContext(state);
  renderReadiness(state.readiness);
  runs = state.runs ?? [];
  setActive(Boolean(state.active));
  renderHistory();
  if (runs[0]) renderRun(runs[0]);
  else renderTimeline(null);
}

els.runButton.addEventListener("click", async () => {
  setActive(true);
  const response = await fetch("/api/runs", { method: "POST" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    setActive(false);
    alert(body.error ?? "could not start a run");
  }
});

const events = new EventSource("/api/events");

events.addEventListener("run", (event) => {
  const run = JSON.parse(event.data);
  setActive(true);
  upsertRun(run);
  renderRun(run);
});

events.addEventListener("finished", (event) => {
  const run = JSON.parse(event.data);
  upsertRun(run);
  renderRun(run);
  setActive(false);
});

events.addEventListener("idle", () => setActive(false));

// Logs also arrive on their own channel so activity keeps flowing even between
// run-state snapshots.
events.addEventListener("log", (event) => {
  const entry = JSON.parse(event.data);
  if (!currentRun) return;
  const last = currentRun.logs[currentRun.logs.length - 1];
  if (last && last.at === entry.at && last.message === entry.message) return;
  currentRun.logs.push(entry);
  renderLog(currentRun);
});

loadState();
