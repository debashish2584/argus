/* Argus Studio — mission control SPA (zero dependencies, ESM)
 *
 * Views:  #/                              fleet
 *         #/project/:name                 project (runs, plans, bugs)
 *         #/project/:name/runs/:runId     run (stages, scenarios, evidence)
 *
 * Live updates: 4s polling while the tab is visible; running runs pulse.
 */

const STAGES = ["analyze", "testplan", "execute", "triage", "fixer", "submit"];
const POLL_MS = 4000;

/* ------------------------------------------------------------------ */
/* utils                                                               */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function relTime(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = (Date.now() - t) / 1000;
  if (s < 45) return "just now";
  if (s < 90) return "1m ago";
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d ago`;
  return new Date(t).toLocaleDateString();
}

function dur(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function tok(n) {
  if (n == null) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

const shortSha = (s) => (s ? s.slice(0, 10) : "");

const verdictLabel = { pass: "pass", "needs-attention": "needs attention", fail: "fail", running: "running" };

/* ------------------------------------------------------------------ */
/* api                                                                 */
/* ------------------------------------------------------------------ */

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j.error || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

/* ------------------------------------------------------------------ */
/* app state                                                           */
/* ------------------------------------------------------------------ */

const app = {
  route: null,
  fleet: null, // { projects: [...] }
  project: null, // { project, plans, plan_histories, runs, bugs }
  run: null, // RunDetail
  runCache: new Map(), // runId -> RunDetail (for bug drawers)
  expandedScenarios: new Set(), // scenario keys expanded in run view
  expandedPlans: new Set(), // plan ids expanded in project view
  runFilter: "all",
  serverOk: null,
};

function evURL(name, runId, scenario, file) {
  return `/api/projects/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/evidence?scenario=${encodeURIComponent(scenario)}&file=${encodeURIComponent(file)}`;
}

/* ------------------------------------------------------------------ */
/* small components (template strings)                                 */
/* ------------------------------------------------------------------ */

function badge(verdict) {
  return `<span class="badge ${esc(verdict)}"><span class="bdot${verdict === "running" ? " dot-pulse" : ""}"></span>${esc(verdictLabel[verdict] ?? verdict)}</span>`;
}

function severityChip(sev) {
  return `<span class="chip sev-${esc(sev)}">${esc(sev)}</span>`;
}

function bugStatusChip(status) {
  const cls = status === "fixed" ? "pass" : status === "dismissed" ? "neutral" : status === "unverified" ? "needs-attention" : "neutral";
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function sparkline(verdicts) {
  const colors = { pass: "var(--green)", "needs-attention": "var(--amber)", fail: "var(--red)", running: "var(--teal)" };
  const n = verdicts.length;
  if (n === 0) return `<span class="chip" style="margin-top:10px">no terminal runs yet</span>`;
  const step = n > 1 ? 88 / (n - 1) : 0;
  const dots = verdicts
    .map((v, i) => {
      const x = n > 1 ? 6 + i * step : 50;
      const cls = v === "running" ? ' class="dot-pulse"' : "";
      return `<circle cx="${x.toFixed(1)}" cy="11" r="3.6" fill="${colors[v] ?? "var(--text-faint)"}"${cls}/>`;
    })
    .join("");
  return `<svg class="sparkline" viewBox="0 0 100 22" width="100" height="22" aria-label="verdict history" role="img">${dots}</svg>`;
}

function flakyDots(outcomes, max = 10) {
  const shown = outcomes.slice(-max);
  const extra = outcomes.length - shown.length;
  const dots = shown
    .map((o) => `<span class="f ${esc(o.status)}" title="${esc(o.run_id)}: ${esc(o.status)}"></span>`)
    .join("");
  const more = extra > 0 ? `<span class="f more" title="+${extra} older runs"></span>` : "";
  return `<span class="flaky" title="pass/fail history (old → recent)">${more}${dots}</span>`;
}

/* ------------------------------------------------------------------ */
/* fleet view                                                          */
/* ------------------------------------------------------------------ */

function fleetCard(p) {
  const latest = p.latest;
  const running = latest && latest.verdict === "running";
  const openBugs = p.open_bugs;
  return `
  <a class="card" href="#/project/${encodeURIComponent(p.name)}" style="${p.exists ? "" : "opacity:.55"}">
    <div class="card-head">
      <span class="card-name">${esc(p.name)}</span>
      ${latest ? badge(latest.verdict) : `<span class="badge neutral">never run</span>`}
    </div>
    ${sparkline(p.verdicts)}
    <div class="card-stats">
      <div class="stat"><span class="num">${p.runs_total}</span><span class="lbl">runs</span></div>
      <div class="stat ${openBugs > 0 ? "warn" : ""}"><span class="num">${openBugs}<span style="color:var(--text-faint);font-size:11px"> / ${p.bugs_total}</span></span><span class="lbl">open bugs</span></div>
      <div class="stat"><span class="num">${p.plans}</span><span class="lbl">plans</span></div>
    </div>
    <div class="card-foot">
      <span class="dot ${running ? "dot-live dot-pulse" : p.exists ? "" : "err"}"></span>
      <span>${p.exists ? (p.last_run_at ? `last run ${relTime(p.last_run_at)}` : "never run") : "path gone"}</span>
      ${latest ? `<span style="margin-left:auto">${esc(shortSha(latest.head))}</span>` : ""}
    </div>
  </a>`;
}

function renderFleet() {
  const projects = app.fleet?.projects ?? [];
  const open = projects.reduce((n, p) => n + p.open_bugs, 0);
  const last = projects.filter((p) => p.last_run_at).sort((a, b) => b.last_run_at.localeCompare(a.last_run_at))[0];
  const head = `
    <div class="view-head">
      <h1 class="view-title">Fleet</h1>
      <span class="chip">${projects.length} project${projects.length === 1 ? "" : "s"}</span>
      ${open ? `<span class="chip sev-P1">${open} open bug${open === 1 ? "" : "s"}</span>` : ""}
    </div>
    <div class="view-sub">${last ? `most recent activity ${relTime(last.last_run_at)} — ${esc(last.name)}` : "no activity yet"}</div>`;
  if (projects.length === 0) {
    return `${head}
    <div class="empty">
      <div class="big">🦉</div>
      <div><b>No projects yet.</b> Register a repository that has a <span class="mono">.argus/</span> workspace<br/>— run <span class="mono">argus init</span> in it first.</div>
      <div class="cta"><button class="btn primary" data-action="add-toggle">+ Add project</button></div>
    </div>`;
  }
  return `${head}<div class="fleet-grid">${projects.map(fleetCard).join("")}</div>`;
}

/* ------------------------------------------------------------------ */
/* project view                                                        */
/* ------------------------------------------------------------------ */

function renderRunsTable() {
  const proj = app.project;
  // runs come enriched from the server: RunRecord + { failures, plans_executed, bug_count }
  const terminal = proj.runs;
  const running = proj.project.latest?.verdict === "running" ? proj.project.latest : null;
  const rows = terminal.map((r) => ({
    id: r.run_id,
    status: r.status,
    started: r.started_at,
    ended: r.ended_at,
    head: r.head,
    plans: r.plans_executed ?? "—",
    fails: r.failures ?? "—",
    bugs: r.bug_count ?? 0,
  }));
  rows.sort((a, b) => b.started.localeCompare(a.started));

  if (running) {
    rows.unshift({
      id: running.run_id,
      started: running.started_at,
      head: running.head,
      plans: "…",
      fails: "…",
      bugs: 0,
      running: true,
    });
  }

  const f = app.runFilter;
  const filtered = rows.filter((r) =>
    f === "all" ? true : f === "running" ? !!r.running : f === "with-bugs" ? r.bugs > 0 : true,
  );

  const body = filtered.length
    ? filtered
        .map((r) => `
        <tr class="clickable" data-action="goto" data-href="#/project/${encodeURIComponent(proj.project.name)}/runs/${encodeURIComponent(r.id)}">
          <td class="mono">${esc(r.id)}${r.running ? ' <span class="dot dot-live dot-pulse" style="display:inline-block;margin-left:4px"></span>' : ""}</td>
          <td>${r.running ? badge("running") : `<span class="badge neutral">${esc(r.status)}</span>`}</td>
          <td>${relTime(r.started)}</td>
          <td class="dim">${dur(r.ended ? new Date(r.ended).getTime() - new Date(r.started).getTime() : null)}</td>
          <td class="mono dim">${esc(shortSha(r.head))}</td>
          <td class="mono dim">${r.plans}</td>
          <td class="mono">${r.bugs}${r.bugs ? ` <span class="chip sev-P1" style="margin-left:4px">${r.bugs} bug${r.bugs === 1 ? "" : "s"}</span>` : ""}</td>
        </tr>`)
        .join("")
    : `<tr><td colspan="7"><div class="empty" style="border:none;background:none">no runs match this filter</div></td></tr>`;

  return `
  <div class="table-wrap">
    <table class="tbl">
      <thead><tr><th>run</th><th>status</th><th>started</th><th>duration</th><th>head</th><th>plans</th><th>bugs</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function renderPlansTable() {
  const proj = app.project;
  const histByPlan = new Map((proj.plan_histories ?? []).map((h) => [h.plan_id, h]));
  if (!proj.plans.length) {
    return `<div class="empty">No test plans yet — run <span class="mono">argus plan</span> in the project.</div>`;
  }
  const rows = proj.plans
    .map((p) => {
      const h = histByPlan.get(p.id);
      const expanded = app.expandedPlans.has(p.id);
      const detail = expanded
        ? `
        <tr><td colspan="7" style="background:var(--bg)">
          <div class="sc-grid">
            <div>
              <h4>Steps (${p.steps.length})</h4>
              <ol class="step-list">${p.steps.map((s) => `<li><span class="mono">${esc(s.action)}</span>${s.detail ? ` — ${esc(s.detail)}` : ""}</li>`).join("")}</ol>
              ${p.preconditions?.length ? `<h4>Preconditions</h4><ol class="step-list">${p.preconditions.map((c) => `<li>${esc(c)}</li>`).join("")}</ol>` : ""}
            </div>
            <div>
              <h4>Spec ${p.spec_ref ? `· <span class="mono">${esc(p.spec_ref)}</span>` : ""}</h4>
              <div class="plan-body">${esc(p.body || "(no narrative)")}</div>
            </div>
          </div>
        </td></tr>`
        : "";
      return `
        <tr class="clickable" data-action="plan-toggle" data-plan="${esc(p.id)}">
          <td class="mono">${esc(p.id)}</td>
          <td><b>${esc(p.title)}</b><br/><span class="dim" style="font-size:11.5px">${(p.tags ?? []).map((t) => `<span class="chip" style="margin-right:4px">${esc(t)}</span>`).join("")}</span></td>
          <td class="dim">${esc(p.module)}</td>
          <td class="dim">${esc(p.priority)}</td>
          <td>${esc(p.status)}</td>
          <td class="mono dim">${p.steps.length}</td>
          <td>${h && h.outcomes.length ? `${flakyDots(h.outcomes)} <span class="mono dim" style="margin-left:6px">${h.pass}✓ ${h.fail}✗</span>` : '<span class="dim">—</span>'}</td>
        </tr>${detail}`;
    })
    .join("");
  return `
  <div class="table-wrap">
    <table class="tbl">
      <thead><tr><th>id</th><th>plan</th><th>module</th><th>priority</th><th>status</th><th>steps</th><th>history (old → recent)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderBugsTable(scope = "project") {
  const proj = app.project;
  const bugs = scope === "project" ? proj.bugs : app.run.bugs;
  if (!bugs.length) return `<div class="empty">No bugs. The eye stays open — for now.</div>`;
  const rows = bugs
    .sort((a, b) => (a.severity === b.severity ? b.created_at.localeCompare(a.created_at) : a.severity.localeCompare(b.severity)))
    .map((b) => `
    <tr class="clickable" data-action="bug-open" data-bug="${esc(b.bug_id)}" data-run="${esc(b.run_id)}">
      <td class="mono">${esc(b.bug_id)}</td>
      <td>${severityChip(b.severity)}</td>
      <td>${esc(b.title)}</td>
      <td>${bugStatusChip(b.status)}</td>
      <td class="mono dim">${esc(b.plan_id)}</td>
      ${scope === "project" ? `<td class="mono dim">${esc(b.run_id)}</td>` : ""}
      <td>${relTime(b.created_at)}</td>
      <td>${b.tracker_ref ? `<a href="${esc(b.tracker_ref)}" target="_blank" rel="noreferrer" data-stop="1">tracker ↗</a>` : '<span class="dim">—</span>'}</td>
    </tr>`).join("");
  return `
  <div class="table-wrap">
    <table class="tbl">
      <thead><tr><th>id</th><th>sev</th><th>title</th><th>status</th><th>plan</th>${scope === "project" ? "<th>run</th>" : ""}<th>created</th><th>tracker</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderProject() {
  const proj = app.project;
  const p = proj.project;
  return `
  <div class="view-head">
    <h1 class="view-title">${esc(p.name)}</h1>
    ${p.latest ? badge(p.latest.verdict) : `<span class="badge neutral">never run</span>`}
    ${p.open_bugs ? `<span class="chip sev-P1">${p.open_bugs} open bug${p.open_bugs === 1 ? "" : "s"}</span>` : ""}
    ${!p.exists ? `<span class="badge fail">path gone</span>` : ""}
  </div>
  <div class="view-sub">${esc(p.path)}${p.latest ? ` · head ${esc(shortSha(p.latest.head))} · ${p.runs_total} run${p.runs_total === 1 ? "" : "s"}` : ""}</div>

  <div class="section">
    <div class="section-head">
      <h3>Run history</h3>
      <div class="filters">
        ${["all", "with-bugs", "running"].map((f) => `<button class="filter-btn ${app.runFilter === f ? "active" : ""}" data-action="run-filter" data-filter="${f}">${f}</button>`).join("")}
      </div>
    </div>
    ${renderRunsTable()}
  </div>

  <div class="section">
    <div class="section-head"><h3>Test plans</h3><span class="hint">click a row for steps + narrative</span></div>
    ${renderPlansTable()}
  </div>

  <div class="section">
    <div class="section-head"><h3>Bugs</h3><span class="hint">click a row for the full report</span></div>
    ${renderBugsTable("project")}
  </div>`;
}

/* ------------------------------------------------------------------ */
/* run view                                                            */
/* ------------------------------------------------------------------ */

function stageTimeline(stages) {
  const byName = new Map(stages.map((s) => [s.stage, s]));
  return `<div class="stage-timeline">
    ${STAGES.map((name, i) => {
      const s = byName.get(name);
      const cls = s ? (s.status === "ok" ? "ok" : s.status === "failed" ? "failed" : "skipped") : "skipped";
      const ico = s ? (s.status === "ok" ? "✓" : s.status === "failed" ? "✗" : "·") : "·";
      const meta = s ? [s.status === "skipped" ? "skipped" : null, s.duration_ms ? dur(s.duration_ms) : null, s.model ? s.model.split("/").pop() : null].filter(Boolean).join(" · ") : "not recorded";
      return `${i > 0 ? `<span class="stage-arrow">→</span>` : ""}
      <div class="stage-cell ${cls}" title="${s ? esc(`${s.agent} · ${s.status}`) : "no record"}">
        <span class="s-name"><span class="s-ico">${ico}</span>${name}</span>
        <span class="s-meta">${esc(meta)}</span>
      </div>`;
    }).join("")}
  </div>`;
}

function scenarioRow(sc) {
  const key = `${sc.run_id}::${sc.plan_id}`;
  const expanded = app.expandedScenarios.has(key);
  const ev = sc.has_evidence;
  const statusCls = sc.status === "pass" ? "pass" : sc.status === "fail" ? "fail" : "needs-attention";
  const evChips = [
    ["screenshot", "shot", ev.screenshot],
    ["video", "video", ev.video],
    ["trace", "trace", ev.trace],
    ["har", "har", ev.har],
    ["console", "console", ev.console],
  ]
    .map(([file, label, on]) => `<span class="chip" style="${on ? "" : "opacity:.35"}">${label}</span>`)
    .join("");
  const detail = expanded
    ? `
    <tr class="sc-detail"><td colspan="6"><div class="sc-grid">
      <div>
        <h4>Steps</h4>
        <div class="table-wrap" style="margin:0">
          <table class="tbl">
            <thead><tr><th>step</th><th>action</th><th>status</th><th>ms</th><th>detail</th></tr></thead>
            <tbody>${
              sc.steps.length
                ? sc.steps.map((st) => `<tr><td class="mono">${esc(st.step_id)}</td><td>${esc(st.action)}</td><td class="${st.status === "fail" ? "tl-fail" : st.status === "skipped" ? "dim" : "tl-ok"}">${esc(st.status)}</td><td class="mono dim">${st.duration_ms ?? "—"}</td><td class="dim">${esc(st.detail ?? "")}</td></tr>`).join("")
                : `<tr><td colspan="5" class="dim">no step detail recorded</td></tr>`
            }</tbody>
          </table>
        </div>
        ${sc.console_errors.length ? `<h4 style="margin-top:14px">Console errors</h4><pre class="code">${esc(sc.console_errors.join("\n"))}</pre>` : ""}
        ${sc.network_failures.length ? `<h4 style="margin-top:14px">Network failures</h4><pre class="code">${esc(sc.network_failures.join("\n"))}</pre>` : ""}
        ${sc.error ? `<h4 style="margin-top:14px">Error</h4><pre class="code">${esc(sc.error)}</pre>` : ""}
      </div>
      <div>
        <h4>Evidence</h4>
        <div class="evidence-bar">
          <button class="ev-btn" data-action="lightbox" data-src="${evURL(app.route.name, app.route.runId, sc.plan_id, "screenshot.png")}" data-cap="${esc(sc.plan_id)} — final screenshot">📷 Screenshot</button>
          ${sc.failed_step_screenshot ? `<button class="ev-btn" data-action="lightbox" data-src="${evURL(app.route.name, app.route.runId, sc.plan_id, sc.failed_step_screenshot)}" data-cap="${esc(sc.plan_id)} — failed step ${esc(sc.failed_step_id)}">🎯 Fail step</button>` : ""}
          <button class="ev-btn video-inline ${expanded ? "open" : ""}" data-action="video-toggle">🎬 Play video</button>
          ${ev.video ? `<a class="ev-btn" href="${evURL(app.route.name, app.route.runId, sc.plan_id, "video.webm")}" download>⬇ Video file</a>` : `<span class="ev-btn off">🎬 Video</span>`}
          ${ev.trace ? `<a class="ev-btn" href="${evURL(app.route.name, app.route.runId, sc.plan_id, "trace.zip")}" download>⬇ Trace</a>` : ""}
          ${ev.har ? `<a class="ev-btn" href="${evURL(app.route.name, app.route.runId, sc.plan_id, "network.har")}" download>⬇ HAR</a>` : ""}
          ${ev.console ? `<a class="ev-btn" href="${evURL(app.route.name, app.route.runId, sc.plan_id, "console.log")}" download>⬇ Console</a>` : ""}
        </div>
        ${ev.video ? `<video class="inline-video" controls preload="none" src="${evURL(app.route.name, app.route.runId, sc.plan_id, "video.webm")}" style="display:none"></video>` : ""}
      </div>
    </div></td></tr>`
    : "";
  return `
  <tr class="sc-row">
    <td><button class="sc-toggle" data-action="sc-toggle" data-key="${esc(key)}" aria-expanded="${expanded}">${expanded ? "▾" : "▸"}</button></td>
    <td class="mono">${esc(sc.plan_id)}</td>
    <td><span class="badge ${statusCls}">${esc(sc.status)}</span></td>
    <td class="mono dim">${sc.failed_step_id ? esc(sc.failed_step_id) : "—"}</td>
    <td class="mono dim">${dur(sc.duration_ms)}</td>
    <td>${evChips}</td>
  </tr>${detail}`;
}

function renderRun() {
  const r = app.run;
  const s = r.summary;
  const llm = r.llm_totals;
  const runDur = r.run.ended_at ? new Date(r.run.ended_at).getTime() - new Date(r.run.started_at).getTime() : null;
  return `
  <div class="view-head">
    <h1 class="view-title mono" style="font-size:17px">${esc(r.run.run_id)} <button class="copy-btn" data-action="copy" data-text="${esc(r.run.run_id)}" title="copy run id">⧉</button></h1>
    ${badge(r.verdict)}
  </div>
  <div class="view-sub">
    ${relTime(r.run.started_at)} · ${dur(runDur)} · head ${esc(shortSha(r.head))} · config ${esc(r.config_hash.slice(0, 8))}${r.argus_version ? ` · argus ${esc(r.argus_version)}` : ""}
  </div>

  ${stageTimeline(r.stages)}

  <div class="summary-row">
    <span class="chip">plans <b>${s?.plans_executed ?? "—"}</b></span>
    <span class="chip">failures <b>${s?.failures ?? "—"}</b></span>
    <span class="chip">bugs <b>${r.bugs.length}</b></span>
    <span class="chip">prs <b>${s?.prs.length ?? 0}</b></span>
    <span class="chip">llm calls <b>${llm.calls}</b></span>
    <span class="chip">tokens <b>${tok(llm.prompt_tokens)} ↓ / ${tok(llm.completion_tokens)} ↑</b></span>
    <span class="chip">llm time <b>${dur(llm.duration_ms)}</b></span>
  </div>

  <div class="section">
    <div class="section-head"><h3>Scenarios</h3><span class="hint">expand for steps + evidence</span></div>
    ${r.scenarios.length ? `
    <div class="table-wrap">
      <table class="tbl">
        <thead><tr><th style="width:28px"></th><th>plan</th><th>status</th><th>failed step</th><th>duration</th><th>evidence</th></tr></thead>
        <tbody>${r.scenarios.map(scenarioRow).join("")}</tbody>
      </table>
    </div>` : `<div class="empty">no scenarios recorded</div>`}
  </div>

  ${r.bugs.length ? `
  <div class="section">
    <div class="section-head"><h3>Bugs</h3><span class="hint">click for the full report + fix + PR</span></div>
    ${renderBugsTable("run")}
  </div>` : ""}

  <div class="section">
    <div class="section-head"><h3>Analyze</h3><span class="hint">what changed and what to test</span></div>
    ${r.analyze.impact?.summary ? `<p style="margin:0 0 10px;color:var(--text-dim)">${esc(r.analyze.impact.summary)}</p>` : ""}
    ${r.analyze.impact?.test_focus?.length ? `<h4 style="margin:8px 0 4px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--text-faint)">Test focus</h4><ol class="step-list">${r.analyze.impact.test_focus.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>` : ""}
    ${r.analyze.changed_files.length ? `<h4 style="margin:12px 0 4px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--text-faint)">Changed files (${r.analyze.changed_files.length})</h4><pre class="code" style="max-height:200px">${esc(r.analyze.changed_files.join("\n"))}</pre>` : ""}
    ${r.analyze.diff ? `<details class="diffbox" style="margin-top:12px"><summary>diff (${r.analyze.diff.length} chars)</summary><pre class="code">${esc(r.analyze.diff)}</pre></details>` : ""}
    ${!r.analyze.impact?.summary && !r.analyze.changed_files.length && !r.analyze.diff ? `<div class="empty" style="padding:18px">no analyze artifacts</div>` : ""}
  </div>

  ${
    r.testplan?.created?.length
      ? `<div class="section"><div class="section-head"><h3>Testplan</h3></div>
        <ul style="margin:0;padding-left:18px;color:var(--text-dim)">
          ${r.testplan.created.map((c) => `<li><a href="#/project/${encodeURIComponent(app.route.name)}">${esc(c.id)}</a> — ${esc(c.title)} <span class="mono dim">${esc(c.file)}</span></li>`).join("")}
        </ul>
        ${r.testplan.notes ? `<p class="dim" style="font-size:12.5px;margin-top:8px">${esc(r.testplan.notes)}</p>` : ""}
      </div>`
      : ""
  }

  <div class="section">
    <div class="section-head"><h3>LLM telemetry</h3></div>
    ${r.llm_calls.length ? `
    <div class="table-wrap">
      <table class="tbl">
        <thead><tr><th>when</th><th>agent</th><th>purpose</th><th>model</th><th>tokens ↓</th><th>tokens ↑</th><th>duration</th><th></th></tr></thead>
        <tbody>${r.llm_calls
          .map((c) => `<tr><td class="dim">${relTime(c.ts)}</td><td class="mono">${esc(c.agent ?? "—")}</td><td class="mono dim">${esc(c.purpose ?? "—")}</td><td class="mono dim" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.model)}">${esc(c.model)}</td><td class="mono">${tok(c.prompt_tokens)}</td><td class="mono">${tok(c.completion_tokens)}</td><td class="mono dim">${dur(c.duration_ms)}</td><td>${c.ok ? '<span class="badge pass">ok</span>' : `<span class="badge fail" title="${esc(c.error ?? "")}">fail</span>`}${c.via_fallback ? ` <span class="chip" title="fallback model used">fb</span>` : ""}</td></tr>`)
          .join("")}</tbody>
      </table>
    </div>` : `<div class="empty" style="padding:18px">no llm calls recorded</div>`}
  </div>`;
}

/* ------------------------------------------------------------------ */
/* bug drawer                                                          */
/* ------------------------------------------------------------------ */

async function openBugDrawer(bugId, runId) {
  const name = app.route.name;
  let detail = app.runCache.get(runId) ?? app.run;
  if (!detail || detail.run.run_id !== runId) {
    detail = (await api("GET", `/api/projects/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}`)).run;
    app.runCache.set(runId, detail);
  }
  const bug = detail.bugs.find((b) => b.bug_id === bugId);
  if (!bug) return toast(`bug ${bugId} not found in run ${runId}`, true);
  const rep = bug.report ?? {};
  const pr = bug.pull_request;
  const ev = rep.evidence ?? {};
  const shot = ev.screenshot ? evURL(name, runId, bug.plan_id, "screenshot.png") : null;
  const vid = ev.video ? evURL(name, runId, bug.plan_id, "video.webm") : null;

  $("#drawerTitle").textContent = `${bugId} · ${bug.severity}`;
  $("#drawerBody").innerHTML = `
    <h4>${esc(bug.title)}</h4>
    <dl class="kv">
      <dt>status</dt><dd>${bugStatusChip(bug.status)}</dd>
      <dt>plan</dt><dd class="mono">${esc(bug.plan_id)}</dd>
      <dt>run</dt><dd class="mono"><a href="#/project/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}">${esc(runId)}</a></dd>
      ${rep.component ? `<dt>component</dt><dd>${esc(rep.component)}</dd>` : ""}
      ${bug.tracker_ref ? `<dt>tracker</dt><dd><a href="${esc(bug.tracker_ref)}" target="_blank" rel="noreferrer">${esc(bug.tracker_ref)}</a></dd>` : ""}
    </dl>

    <h4>Description</h4>
    <pre class="code" style="white-space:pre-wrap;max-height:260px">${esc(rep.description ?? "(no report on disk)")}</pre>

    ${rep.proposed_fix ? `<h4>Proposed fix</h4><pre class="code" style="white-space:pre-wrap">${esc(rep.proposed_fix)}</pre>` : ""}

    <h4>Evidence</h4>
    <div class="evidence-bar">
      ${shot ? `<button class="ev-btn" data-action="lightbox" data-src="${shot}" data-cap="${esc(bugId)} — final state">📷 Screenshot</button>` : ""}
      ${vid ? `<a class="ev-btn" href="${vid}" target="_blank">🎬 Video</a>` : ""}
      ${ev.video_timestamp ? `<span class="chip">t=${esc(ev.video_timestamp)}</span>` : ""}
    </div>
    ${ev.violated_contract ? `<h4>Violated contract</h4><pre class="code" style="white-space:pre-wrap">${esc(ev.violated_contract)}</pre>` : ""}
    ${ev.console_errors?.length ? `<h4>Console errors</h4><pre class="code" style="max-height:180px">${esc(ev.console_errors.join("\n"))}</pre>` : ""}
    ${ev.network_failures?.length ? `<h4>Network failures</h4><pre class="code" style="max-height:180px">${esc(ev.network_failures.join("\n"))}</pre>` : ""}

    ${
      pr
        ? `<h4>Fix / PR</h4>
        <dl class="kv">
          <dt>branch</dt><dd class="mono">${esc(pr.branch)}</dd>
          <dt>status</dt><dd>${pr.status === "opened" ? '<span class="badge pass">opened</span>' : pr.status === "pending-local" ? '<span class="badge needs-attention">pending local</span>' : `<span class="badge neutral">${esc(pr.status)}</span>`}</dd>
          <dt>title</dt><dd>${esc(pr.title)}</dd>
          ${pr.pr_url ? `<dt>link</dt><dd><a href="${esc(pr.pr_url)}" target="_blank" rel="noreferrer">${esc(pr.pr_url)} ↗</a></dd>` : ""}
        </dl>
        <details class="diffbox" style="margin-top:10px"><summary>PR body</summary><pre class="code" style="white-space:pre-wrap">${esc(pr.body)}</pre></details>
        <details class="diffbox" style="margin-top:10px"><summary>commit message</summary><pre class="code" style="white-space:pre-wrap">${esc(pr.commit_message)}</pre></details>`
        : ""
    }`;
  $("#drawer").classList.remove("hidden");
}

function closeDrawer() {
  $("#drawer").classList.add("hidden");
}

/* ------------------------------------------------------------------ */
/* lightbox                                                            */
/* ------------------------------------------------------------------ */

function showLightbox(src, caption) {
  $("#lbImg").src = src;
  $("#lbCaption").textContent = caption ?? "";
  $("#lightbox").classList.remove("hidden");
}

function closeLightbox() {
  $("#lightbox").classList.add("hidden");
  $("#lbImg").src = "";
}

/* ------------------------------------------------------------------ */
/* router + render                                                     */
/* ------------------------------------------------------------------ */

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, "");
  const parts = h.split("/").filter(Boolean);
  if (parts.length === 0) return { view: "fleet" };
  if (parts[0] === "project" && parts[1] && parts.length === 2)
    return { view: "project", name: decodeURIComponent(parts[1]) };
  if (parts[0] === "project" && parts[2] === "runs" && parts[3])
    return { view: "run", name: decodeURIComponent(parts[1]), runId: decodeURIComponent(parts[3]) };
  return { view: "fleet" };
}

function crumbs() {
  const el = $("#crumbs");
  const r = app.route;
  if (!r) return;
  const fleet = `<a class="crumb" href="#/">Fleet</a>`;
  if (r.view === "fleet") {
    el.innerHTML = `<span class="crumb current">Fleet</span>`;
    return;
  }
  const proj = `<a class="crumb ${r.view === "project" ? "current" : ""}" href="#/project/${encodeURIComponent(r.name)}">${esc(r.name)}</a>`;
  el.innerHTML =
    r.view === "run"
      ? `${fleet}<span class="sep">/</span>${proj}<span class="sep">/</span><span class="crumb current mono">${esc(shortSha(r.runId))}</span>`
      : `${fleet}<span class="sep">/</span>${proj}`;
}

async function render() {
  const main = $("#main");
  const scroll = main.scrollTop;
  app.route = parseRoute();
  const r = app.route;
  try {
    if (r.view === "fleet") {
      app.fleet = await api("GET", "/api/projects");
      main.innerHTML = renderFleet();
    } else if (r.view === "project") {
      app.project = await api("GET", `/api/projects/${encodeURIComponent(r.name)}`);
      main.innerHTML = renderProject();
    } else {
      const fresh =
        !app.run || app.run.run.run_id !== r.runId || app.run.route_name !== r.name;
      app.run = await api("GET", `/api/projects/${encodeURIComponent(r.name)}/runs/${encodeURIComponent(r.runId)}`);
      app.run = app.run.run;
      app.run.route_name = r.name;
      if (fresh) app.expandedScenarios.clear();
      app.runCache.set(r.runId, app.run);
      main.innerHTML = renderRun();
    }
    crumbs();
    main.scrollTop = scroll;
    app.serverOk = true;
    paintServerChip();
  } catch (e) {
    main.innerHTML = `<div class="errbox">${esc(e.message)}</div><p class="dim">the studio server may be unreachable, or this project is not registered.</p>`;
    app.serverOk = false;
    paintServerChip();
  }
}

function paintServerChip() {
  const chip = $("#serverChip");
  chip.innerHTML = `<span class="dot ${app.serverOk ? "dot-live" : "err"}"></span>${app.serverOk ? "server ok" : "server down"}`;
}

/* ------------------------------------------------------------------ */
/* live polling                                                        */
/* ------------------------------------------------------------------ */

setInterval(() => {
  if (document.visibilityState !== "visible") return;
  render().catch(() => {});
}, POLL_MS);

/* ------------------------------------------------------------------ */
/* global event handling (delegation — survives re-renders)            */
/* ------------------------------------------------------------------ */

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-action]");
  if (!t) return;
  const a = t.dataset.action;

  if (a === "goto") {
    if (e.target.closest("a[data-stop]")) return;
    location.hash = t.dataset.href;
    return;
  }
  if (a === "sc-toggle") {
    const key = t.dataset.key;
    app.expandedScenarios.has(key) ? app.expandedScenarios.delete(key) : app.expandedScenarios.add(key);
    render().catch(() => {});
    return;
  }
  if (a === "plan-toggle") {
    const id = t.dataset.plan;
    app.expandedPlans.has(id) ? app.expandedPlans.delete(id) : app.expandedPlans.add(id);
    render().catch(() => {});
    return;
  }
  if (a === "run-filter") {
    app.runFilter = t.dataset.filter;
    render().catch(() => {});
    return;
  }
  if (a === "bug-open") {
    e.preventDefault();
    openBugDrawer(t.dataset.bug, t.dataset.run).catch((err) => toast(err.message, true));
    return;
  }
  if (a === "lightbox") {
    showLightbox(t.dataset.src, t.dataset.cap);
    return;
  }
  if (a === "video-toggle") {
    const video = t.closest(".sc-grid")?.querySelector("video.inline-video");
    if (!video) return;
    const open = video.style.display !== "none";
    if (open) video.pause();
    video.style.display = open ? "none" : "block";
    if (!open) video.play().catch(() => {});
    return;
  }
  if (a === "copy") {
    navigator.clipboard?.writeText(t.dataset.text).then(() => toast("copied run id")).catch(() => toast("copy failed", true));
    return;
  }
  if (a === "add-toggle") {
    const form = $("#addForm");
    form.classList.toggle("hidden");
    $("#addToggle").setAttribute("aria-expanded", String(!form.classList.contains("hidden")));
    if (!form.classList.contains("hidden")) $("#addPath").focus();
    return;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeDrawer();
    closeLightbox();
  }
});

$("#drawerClose").addEventListener("click", closeDrawer);
$("#lbClose").addEventListener("click", closeLightbox);
$("#lightbox").addEventListener("click", (e) => {
  if (e.target === $("#lightbox")) closeLightbox();
});

/* ------------------------------------------------------------------ */
/* add project                                                         */
/* ------------------------------------------------------------------ */

$("#addProjectForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("#addError");
  const name = $("#addName").value.trim();
  const p = $("#addPath").value.trim();
  if (!name || !p) return;
  try {
    await api("POST", "/api/projects", { name, path: p });
    $("#addName").value = "";
    $("#addPath").value = "";
    $("#addForm").classList.add("hidden");
    if (errEl) errEl.remove();
    toast(`registered '${name}'`);
    render().catch(() => {});
  } catch (err) {
    let el = $("#addError");
    if (!el) {
      el = document.createElement("div");
      el.id = "addError";
      el.className = "add-error";
      $("#addProjectForm").appendChild(el);
    }
    el.textContent = err.message;
  }
});

function toast(msg, isErr = false) {
  const t = document.createElement("div");
  t.className = `toast${isErr ? " err" : ""}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

/* ------------------------------------------------------------------ */
/* PWA install                                                         */
/* ------------------------------------------------------------------ */

let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $("#installBtn").classList.remove("hidden");
});
window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
  $("#installBtn").classList.add("hidden");
  $("#installBtn").remove();
});
$("#installBtn").addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  if (choice?.outcome === "accepted") toast("Argus Studio installed — it now lives in your taskbar");
  deferredPrompt = null;
  $("#installBtn").classList.add("hidden");
});
if (window.matchMedia?.("(display-mode: standalone)").matches) {
  $("#installBtn").remove();
}

/* ------------------------------------------------------------------ */
/* service worker + boot                                               */
/* ------------------------------------------------------------------ */

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

window.addEventListener("hashchange", () => render().catch(() => {}));
render().catch((e) => {
  $("#main").innerHTML = `<div class="errbox">${esc(e.message)}</div>`;
});
