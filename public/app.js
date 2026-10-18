const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  dashboard: null,
  tables: null,
  connect: null,
  currentView: "overview",
  currentTable: null,
  changeStatus: "all",
  changes: [],
  builder: null,
  authGateOpen: false,
  queryRunToken: 0,
  selectedClientId: "codex",
};

const VIEW_META = {
  overview: { label: "Overview", title: "Overview" },
  tables: { label: "Data browser", title: "Data browser" },
  query: { label: "SQL lab", title: "SQL lab" },
  changes: { label: "Changes", title: "Change ledger" },
  connect: { label: "Connect", title: "Connect an agent" },
};

const QUERY_PRESETS = {
  "active-mrr": `SELECT
  c.company,
  c.name,
  s.plan_code,
  s.seats,
  s.mrr,
  s.renews_at
FROM customers c
JOIN subscriptions s ON s.customer_id = c.id
WHERE s.status = 'active'
ORDER BY s.mrr DESC
LIMIT 20;`,
  renewals: `SELECT
  c.company,
  s.plan_code,
  s.mrr,
  s.renews_at,
  CAST(julianday(s.renews_at) - julianday('now') AS INTEGER) AS days_left
FROM subscriptions s
JOIN customers c ON c.id = s.customer_id
WHERE s.status = 'active'
  AND s.renews_at BETWEEN datetime('now') AND datetime('now', '+30 days')
ORDER BY s.renews_at ASC
LIMIT 20;`,
  overdue: `SELECT
  i.number,
  c.company,
  i.amount / 100.0 AS amount_usd,
  i.status,
  i.issued_at
FROM invoices i
JOIN customers c ON c.id = i.customer_id
WHERE i.status IN ('past_due', 'open')
ORDER BY i.issued_at ASC
LIMIT 20;`,
  recent: `SELECT
  e.created_at,
  c.company,
  e.kind,
  e.detail
FROM activity_events e
JOIN customers c ON c.id = e.customer_id
ORDER BY e.created_at DESC
LIMIT 20;`,
};

const TOOL_DESCRIPTIONS = {
  cleversql_overview: "Workspace + safety limits",
  cleversql_describe_table: "Columns, keys, indexes",
  cleversql_browse_rows: "Paginated row access",
  cleversql_query: "Read-only SQL",
  cleversql_preview_change: "Dry-run typed writes",
  cleversql_apply_change: "Commit verified diff",
  cleversql_list_changes: "Audit trail",
  cleversql_revert_change: "Conflict-safe rollback",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

function number(value) {
  return new Intl.NumberFormat("en-US").format(Number(value ?? 0));
}

function compactNumber(value) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number(value ?? 0));
}

function timeAgo(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(timestamp);
}

function truncate(value, length = 70) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function displayValue(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renderCell(value) {
  if (value === null || value === undefined) {
    return '<span class="null-value">null</span>';
  }
  if (typeof value === "number") {
    return `<span class="number-value">${escapeHtml(String(value))}</span>`;
  }
  if (typeof value === "object") {
    return escapeHtml(truncate(JSON.stringify(value), 180));
  }
  return escapeHtml(truncate(value, 180));
}

function actionLabel(action) {
  return action ? action[0].toUpperCase() + action.slice(1) : "Change";
}

function actionSymbol(action) {
  if (action === "insert") return "+";
  if (action === "delete") return "−";
  return "↻";
}

function getToken() {
  return sessionStorage.getItem("cleversql_token") ?? "";
}

class ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (options.method && options.method !== "GET") {
    headers["X-Cleversql-Actor"] = "human:console";
  }

  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    throw new ApiError("The CleverSQL server is unreachable.");
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (response.status === 401) {
    showAuthGate();
    throw new ApiError("Authentication required.");
  }
  if (!response.ok) {
    const error = payload?.error;
    throw new ApiError(error?.message ?? `Request failed (${response.status}).`, {
      status: response.status,
      code: error?.code,
    });
  }
  return payload;
}

async function copyText(text, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  showToast(label, truncate(text, 100), { icon: "⧉" });
}

let toastSequence = 0;
function showToast(title, message = "", { icon = "✓", error = false, action, actionLabel } = {}) {
  const root = $("#toast-root");
  const id = `toast-${++toastSequence}`;
  const element = document.createElement("div");
  element.className = `toast${error ? " error" : ""}`;
  element.id = id;
  element.innerHTML = `
    <span class="toast-icon">${escapeHtml(icon)}</span>
    <div>
      <strong>${escapeHtml(title)}</strong>
      ${message ? `<span>${escapeHtml(message)}</span>` : ""}
    </div>
    ${action ? `<button type="button">${escapeHtml(actionLabel ?? "Action")}</button>` : ""}
  `;
  root.append(element);
  const remove = () => element.remove();
  const timer = window.setTimeout(remove, 6500);
  const actionButton = $("button", element);
  if (actionButton) {
    actionButton.addEventListener("click", async () => {
      window.clearTimeout(timer);
      remove();
      await action();
    });
  }
  if (root.children.length > 3) root.firstElementChild?.remove();
}

function showAuthGate() {
  if (state.authGateOpen) return;
  state.authGateOpen = true;
  const gate = document.createElement("div");
  gate.className = "auth-gate";
  gate.innerHTML = `
    <div class="auth-card">
      <span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></span>
      <h2>Unlock this workspace</h2>
      <p>This CleverSQL instance requires a bearer token. The token was printed in the server terminal when it started.</p>
      <div class="form-field">
        <label for="auth-token">Bearer token</label>
        <input class="field-input" id="auth-token" type="password" autocomplete="off" />
      </div>
      <div class="modal-error" id="auth-error" hidden></div>
      <button class="button button-primary" id="auth-submit">Open workspace</button>
    </div>
  `;
  document.body.append(gate);
  const input = $("#auth-token", gate);
  const error = $("#auth-error", gate);
  input.focus();
  const submit = async () => {
    const value = input.value.trim();
    if (!value) {
      error.hidden = false;
      error.textContent = "Enter the token from the server terminal.";
      return;
    }
    sessionStorage.setItem("cleversql_token", value);
    try {
      await api("/api/dashboard");
      gate.remove();
      state.authGateOpen = false;
      await loadWorkspace();
    } catch (caught) {
      sessionStorage.removeItem("cleversql_token");
      error.hidden = false;
      error.textContent = caught.message;
    }
  };
  $("#auth-submit", gate).addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
}

function closeModal() {
  const root = $("#modal-root");
  root.innerHTML = "";
}

function confirmDialog({
  title,
  message,
  confirmLabel = "Continue",
  danger = false,
}) {
  return new Promise((resolve) => {
    const root = $("#modal-root");
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal small">
          <div class="modal-head">
            <div>
              <h2>${escapeHtml(title)}</h2>
              <p>${escapeHtml(message)}</p>
            </div>
            <button class="modal-close" type="button" data-confirm="false">×</button>
          </div>
          <div class="modal-foot">
            <span></span>
            <div class="modal-foot-right">
              <button class="button button-ghost compact" type="button" data-confirm="false">Cancel</button>
              <button class="button ${danger ? "danger" : "button-primary"} compact" type="button" data-confirm="true">${escapeHtml(confirmLabel)}</button>
            </div>
          </div>
        </div>
      </div>
    `;
    const finish = (value) => {
      closeModal();
      resolve(value);
    };
    $$("[data-confirm]", root).forEach((button) => {
      button.addEventListener("click", () => finish(button.dataset.confirm === "true"));
    });
    $(".modal-backdrop", root).addEventListener("click", (event) => {
      if (event.target === event.currentTarget) finish(false);
    });
  });
}

function navTo(view, { updateHash = true } = {}) {
  const target = VIEW_META[view] ? view : "overview";
  state.currentView = target;
  $$(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === target);
  });
  $$(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `view-${target}`);
  });
  $("#page-crumb").textContent = VIEW_META[target].title;
  if (updateHash) history.replaceState(null, "", `#${target}`);

  if (target === "tables") loadTables();
  if (target === "changes") loadChanges();
  if (target === "connect") loadConnect();
  if (target === "query") {
    window.setTimeout(() => $("#sql-editor")?.focus(), 80);
  }
}

async function loadWorkspace() {
  try {
    const [dashboard, connect] = await Promise.all([
      api("/api/dashboard"),
      api("/api/connect"),
    ]);
    state.dashboard = dashboard;
    state.connect = connect;
    renderDashboard();
    renderConnect();
    const initialView = location.hash.replace("#", "") || "overview";
    navTo(initialView, { updateHash: false });
  } catch (error) {
    if (error.status !== 401) {
      showToast("Could not load workspace", error.message, {
        icon: "!",
        error: true,
      });
    }
  }
}

function renderDashboard() {
  const dashboard = state.dashboard;
  if (!dashboard) return;
  const totalColumns = dashboard.tables.reduce(
    (total, table) => total + Number(table.columns ?? 0),
    0,
  );
  document.title = `${dashboard.database.name} · CleverSQL`;
  $("#sidebar-db").textContent = dashboard.database.name;
  $("#sidebar-mode").textContent = `${dashboard.database.driver} · ${
    dashboard.safety.readOnly ? "read-only" : "governed writes"
  }`;
  $("#version-label").textContent = dashboard.version;
  $("#metric-tables").textContent = number(dashboard.stats.tables);
  $("#metric-columns").textContent = number(totalColumns);
  $("#metric-views").textContent = number(dashboard.stats.views);
  $("#metric-rows").textContent = compactNumber(dashboard.stats.rows);
  $("#metric-row-cap").textContent = number(dashboard.safety.maxRows);
  $("#metric-changes").textContent = number(dashboard.stats.changes);
  $("#metric-pending").textContent = number(dashboard.stats.pending);
  $("#metric-applied").textContent = number(dashboard.stats.applied);
  $("#pending-badge").textContent = number(dashboard.stats.pending);
  $("#agent-pill").classList.toggle("read-only", dashboard.safety.readOnly);
  $("#agent-pill").lastChild.textContent = dashboard.safety.readOnly
    ? " Read-only mode"
    : " Agent-ready";

  const endpoint = `${location.origin}/mcp`;
  $("#mcp-endpoint").textContent = endpoint;
  $("#connect-endpoint").textContent = endpoint;
  renderOverviewTables();
  renderRecentChanges();
}

function renderOverviewTables() {
  const tables = state.dashboard?.tables ?? [];
  const container = $("#overview-tables");
  if (tables.length === 0) {
    container.innerHTML = `
      <div class="empty-inline">
        <strong>No tables yet</strong>
        <span>Create a table in your SQLite database, then refresh this page.</span>
      </div>
    `;
    return;
  }
  container.innerHTML = tables
    .slice(0, 5)
    .map(
      (table) => `
        <button class="table-list-row" type="button" data-table="${escapeHtml(table.name)}">
          <span class="table-glyph">${table.type === "view" ? "V" : "T"}</span>
          <strong>${escapeHtml(table.name)}</strong>
          <span class="table-columns">${number(table.columns)} columns · ${
            table.primaryKey.length ? `PK ${escapeHtml(table.primaryKey.join(", "))}` : "no primary key"
          }</span>
          <span class="table-row-count">${table.rows == null ? "—" : `${compactNumber(table.rows)} rows`}</span>
          <span class="table-arrow">↗</span>
        </button>
      `,
    )
    .join("");
}

function renderRecentChanges() {
  const changes = state.dashboard?.recentChanges ?? [];
  const container = $("#recent-changes");
  if (changes.length === 0) {
    container.innerHTML = `
      <div class="empty-inline">
        <strong>The ledger is quiet</strong>
        <span>Preview a change to see the exact diff before anything is committed.</span>
      </div>
    `;
    return;
  }
  container.innerHTML = changes
    .map((change) => {
      const iconClass =
        change.status === "reverted"
          ? "red"
          : change.status === "preview"
            ? "amber"
            : "";
      return `
        <div class="activity-item">
          <span class="activity-icon ${iconClass}">${actionSymbol(change.action)}</span>
          <div class="activity-copy">
            <strong>${escapeHtml(actionLabel(change.action))} ${escapeHtml(change.table)}</strong>
            <span>${escapeHtml(change.reason)}</span>
          </div>
          <span class="activity-time">${escapeHtml(timeAgo(change.createdAt))}</span>
        </div>
      `;
    })
    .join("");
}

async function loadTables({ preserveSelection = true } = {}) {
  try {
    const payload = await api("/api/tables");
    state.tables = payload.tables;
    renderTableBrowserList();
    const requested =
      (preserveSelection && state.currentTable) ||
      state.tables.find((table) => table.type === "table")?.name ||
      state.tables[0]?.name;
    if (requested) await selectTable(requested);
  } catch (error) {
    showToast("Schema unavailable", error.message, { icon: "!", error: true });
  }
}

function renderTableBrowserList() {
  const query = ($("#table-filter")?.value ?? "").toLowerCase();
  const tables = (state.tables ?? []).filter((table) =>
    table.name.toLowerCase().includes(query),
  );
  const container = $("#table-browser-list");
  container.innerHTML =
    tables.length === 0
      ? `<div class="empty-inline"><span>No table matches that filter.</span></div>`
      : tables
          .map(
            (table) => `
              <button class="browser-item ${
                state.currentTable === table.name ? "active" : ""
              }" type="button" data-browser-table="${escapeHtml(table.name)}">
                <span class="browser-item-code">${table.type === "view" ? "V" : "T"}</span>
                <strong>${escapeHtml(table.name)}</strong>
                <span>${table.rowCount == null ? "" : compactNumber(table.rowCount)}</span>
              </button>
            `,
          )
          .join("");
}

async function selectTable(name) {
  state.currentTable = name;
  renderTableBrowserList();
  const container = $("#table-detail");
  container.innerHTML = '<div class="skeleton-block"></div>';
  try {
    const [table, rows] = await Promise.all([
      api(`/api/tables/${encodeURIComponent(name)}`),
      api(`/api/tables/${encodeURIComponent(name)}/rows?limit=30&offset=0`),
    ]);
    renderTableDetail(table, rows);
  } catch (error) {
    container.innerHTML = `
      <div class="query-error">
        <span class="error-mark">!</span>
        <h3>Could not inspect this table</h3>
        <p>${escapeHtml(error.message)}</p>
      </div>
    `;
  }
}

function renderTableDetail(table, rowsData) {
  const container = $("#table-detail");
  const pk = table.primaryKey ?? [];
  const columnRows = table.columns
    .map(
      (column) => `
        <tr>
          <td class="${pk.includes(column.name) ? "pk-cell" : ""}">${escapeHtml(column.name)}</td>
          <td>${escapeHtml(column.type)}</td>
          <td>${column.notNull ? "NOT NULL" : "nullable"}</td>
          <td>${column.defaultValue == null ? '<span class="null-value">—</span>' : escapeHtml(column.defaultValue)}</td>
          <td>${pk.includes(column.name) ? `<span class="mini-pill">pk ${column.primaryKeyPosition}</span>` : ""}</td>
        </tr>
      `,
    )
    .join("");

  const foreignKeys = table.foreignKeys.length
    ? `<div class="detail-section">
        <div class="detail-section-head"><h3>Foreign keys</h3></div>
        <div class="schema-chip-row">
          ${table.foreignKeys
            .map(
              (foreignKey) => `
                <span class="schema-chip">
                  <i>→</i>${escapeHtml(foreignKey.column)} → ${escapeHtml(
                    foreignKey.referencesTable,
                  )}.${escapeHtml(foreignKey.referencesColumn)}
                </span>
              `,
            )
            .join("")}
        </div>
      </div>`
    : "";

  container.innerHTML = `
    <div class="table-detail-head">
      <div>
        <div class="table-title-line">
          <h2>${escapeHtml(table.name)}</h2>
          <span class="type-pill ${table.type}">${escapeHtml(table.type)}</span>
          ${table.mutable ? '<span class="mini-pill" style="color:var(--lime)">mutable</span>' : ""}
        </div>
        <p>${number(table.rowCount)} rows · ${table.columns.length} columns · ${
          table.primaryKey.length
            ? `primary key ${escapeHtml(table.primaryKey.join(", "))}`
            : "no primary key"
        }</p>
      </div>
      <div class="table-detail-actions">
        <button class="button button-ghost compact" type="button" data-query-table="${escapeHtml(table.name)}">Query table</button>
        ${
          table.mutable
            ? `<button class="button button-primary compact" type="button" data-edit-table="${escapeHtml(table.name)}">Preview edit</button>`
            : ""
        }
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-head">
        <h3>Columns</h3>
        <span class="panel-kicker">${table.indexes.length} indexes</span>
      </div>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead><tr><th>Column</th><th>Type</th><th>Constraint</th><th>Default</th><th></th></tr></thead>
          <tbody>${columnRows}</tbody>
        </table>
      </div>
    </div>

    ${foreignKeys}

    <div class="detail-section">
      <div class="detail-section-head">
        <h3>Sample rows</h3>
        <span class="panel-kicker">first ${rowsData.rows.length} rows</span>
      </div>
      <div class="data-table-wrap">
        ${renderDataTable(
          table.columns.map((column) => column.name),
          rowsData.rows,
          pk,
        )}
      </div>
    </div>
  `;
}

function renderDataTable(columns, rows, primaryKey = []) {
  if (!rows?.length) {
    return `<div class="empty-inline"><span>No rows returned.</span></div>`;
  }
  const head = columns
    .map(
      (column) =>
        `<th class="${primaryKey.includes(column) ? "pk-cell" : ""}">${escapeHtml(column)}</th>`,
    )
    .join("");
  const body = rows
    .map(
      (row) => `
        <tr>
          ${columns
            .map(
              (column) =>
                `<td class="${primaryKey.includes(column) ? "pk-cell" : ""}">${renderCell(row[column])}</td>`,
            )
            .join("")}
        </tr>
      `,
    )
    .join("");
  return `<table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function updateLineRail() {
  const editor = $("#sql-editor");
  if (!editor) return;
  const count = editor.value.split("\n").length;
  $("#line-rail").innerHTML = Array.from(
    { length: count },
    (_, index) => index + 1,
  ).join("<br />");
}

async function runQuery() {
  const editor = $("#sql-editor");
  const result = $("#query-results");
  const runButton = $("#run-query");
  const sql = editor.value.trim();
  if (!sql) return;
  const runToken = ++state.queryRunToken;
  runButton.disabled = true;
  runButton.innerHTML = 'Running <span class="key-hint">···</span>';
  $("#editor-status").innerHTML = '<i class="status-dot-inline"></i> Executing';
  try {
    const data = await api("/api/query", {
      method: "POST",
      body: JSON.stringify({ sql, maxRows: 200 }),
    });
    if (runToken !== state.queryRunToken) return;
    renderQueryResults(data);
    $("#editor-status").innerHTML = '<i class="status-dot-inline"></i> Query complete';
  } catch (error) {
    if (runToken !== state.queryRunToken) return;
    result.innerHTML = `
      <div class="query-error">
        <span class="error-mark">!</span>
        <h3>Query blocked or invalid</h3>
        <p>${escapeHtml(error.message)}</p>
      </div>
    `;
    $("#editor-status").innerHTML = '<i class="status-dot-inline" style="background:var(--red)"></i> Error';
  } finally {
    runButton.disabled = false;
    runButton.innerHTML = 'Run query <span class="key-hint">⌘↵</span>';
  }
}

function renderQueryResults(data) {
  const result = $("#query-results");
  result.innerHTML = `
    <div class="query-result-shell">
      <div class="query-result-head">
        <div class="result-metrics">
          <span><strong>${number(data.rowCount)}</strong> rows</span>
          <span><strong>${data.elapsedMs}</strong> ms</span>
          ${data.truncated ? "<span style=\"color:var(--amber)\">truncated</span>" : ""}
        </div>
        <span class="panel-kicker">read-only connection</span>
      </div>
      <div class="query-result-body">
        ${renderDataTable(data.columns, data.rows)}
      </div>
    </div>
  `;
}

function applyQueryPreset(name) {
  const sql = QUERY_PRESETS[name];
  if (!sql) return;
  const editor = $("#sql-editor");
  editor.value = sql;
  updateLineRail();
  $("#query-presets").value = "";
  runQuery();
}

async function loadChanges() {
  try {
    const payload = await api(
      `/api/changes?status=${encodeURIComponent(state.changeStatus)}&limit=100`,
    );
    state.changes = payload.changes;
    renderChanges();
  } catch (error) {
    showToast("Ledger unavailable", error.message, { icon: "!", error: true });
  }
}

function renderChanges() {
  const container = $("#change-ledger");
  if (state.changes.length === 0) {
    container.innerHTML = `
      <div class="ledger-empty">
        <span class="ledger-empty-icon">⇄</span>
        <h2>No ${state.changeStatus === "all" ? "" : state.changeStatus} changes</h2>
        <p>A change starts as a dry-run. CleverSQL shows the exact row diff and only commits after you apply the verified intent.</p>
        <button class="button button-primary compact" type="button" data-open-change>Preview a change</button>
      </div>
    `;
    return;
  }
  container.innerHTML = state.changes
    .map((change) => {
      const firstDiff = change.diff?.[0];
      const firstColumn = firstDiff?.changed?.[0];
      const beforeValue = firstColumn ? firstDiff.before?.[firstColumn] : null;
      const afterValue = firstColumn ? firstDiff.after?.[firstColumn] : null;
      const diffLine =
        firstColumn && change.status !== "reverted"
          ? `<div class="change-diff-line">
              <span class="diff-column">${escapeHtml(firstColumn)}</span>
              <span class="diff-before">${escapeHtml(displayValue(beforeValue))}</span>
              <span class="diff-arrow">→</span>
              <span class="diff-after">${escapeHtml(displayValue(afterValue))}</span>
            </div>`
          : "";
      const actions =
        change.status === "preview"
          ? `
            <button class="small-action" type="button" data-change-action="view" data-change-id="${change.id}">Diff</button>
            <button class="small-action primary" type="button" data-change-action="apply" data-change-id="${change.id}">Apply</button>
          `
          : change.status === "applied"
            ? `
              <button class="small-action" type="button" data-change-action="view" data-change-id="${change.id}">Diff</button>
              <button class="small-action danger" type="button" data-change-action="revert" data-change-id="${change.id}">Revert</button>
            `
            : `<button class="small-action" type="button" data-change-action="view" data-change-id="${change.id}">Diff</button>`;
      return `
        <article class="change-card">
          <span class="change-action-icon ${change.action}">${actionSymbol(change.action)}</span>
          <div class="change-main">
            <div class="change-title-line">
              <h3>${escapeHtml(actionLabel(change.action))} ${escapeHtml(change.table)}</h3>
              <span class="status-pill ${change.status}">${escapeHtml(change.status)}</span>
            </div>
            <div class="change-meta">
              <span>${escapeHtml(change.id)}</span>
              <span>${escapeHtml(change.actor ?? "human")}</span>
              <span>${escapeHtml(timeAgo(change.createdAt))}</span>
              <span>${number(change.summary?.changedRows ?? 0)} row${change.summary?.changedRows === 1 ? "" : "s"}</span>
            </div>
            <div class="change-reason">“${escapeHtml(change.reason)}”</div>
            ${diffLine}
          </div>
          <div class="change-actions">${actions}</div>
        </article>
      `;
    })
    .join("");
}

async function applyChange(changeId) {
  try {
    const plan = await api(`/api/changes/${encodeURIComponent(changeId)}/apply`, {
      method: "POST",
      body: "{}",
    });
    showToast(
      "Change applied",
      `${actionLabel(plan.action)} on ${plan.table} · ${plan.id}`,
      {
        icon: "✓",
        actionLabel: "Undo",
        action: () => revertChange(plan.id, plan),
      },
    );
    await refreshAfterWrite();
  } catch (error) {
    showToast("Change not applied", error.message, { icon: "!", error: true });
  }
}

async function revertChange(changeId, plan = null) {
  const source = plan ?? state.changes.find((item) => item.id === changeId);
  const confirmed = await confirmDialog({
    title: "Revert this change?",
    message: `CleverSQL will restore the before-state of ${source ? `${actionLabel(source.action)} ${source.table}` : "this change"}. If a newer edit conflicts, the rollback will fail instead of overwriting it.`,
    confirmLabel: "Revert change",
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api(`/api/changes/${encodeURIComponent(changeId)}/revert`, {
      method: "POST",
      body: JSON.stringify({ reason: "Reverted from the CleverSQL console" }),
    });
    showToast("Change reverted", "The previous values were restored and audited.", {
      icon: "↶",
    });
    await refreshAfterWrite();
  } catch (error) {
    showToast("Revert blocked", error.message, { icon: "!", error: true });
  }
}

async function viewChange(changeId) {
  try {
    const change = await api(`/api/changes/${encodeURIComponent(changeId)}`);
    const root = $("#modal-root");
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal">
          <div class="modal-head">
            <div>
              <h2>${escapeHtml(actionLabel(change.action))} ${escapeHtml(change.table)}</h2>
              <p>${escapeHtml(change.reason)} · ${escapeHtml(change.id)}</p>
            </div>
            <button class="modal-close" type="button" data-close-modal>×</button>
          </div>
          <div class="modal-body">
            ${renderDiffPanel(change, { expanded: true })}
            <div class="change-meta" style="margin-top:14px">
              <span>actor ${escapeHtml(change.actor)}</span>
              <span>created ${escapeHtml(new Date(change.createdAt).toLocaleString())}</span>
              <span>status ${escapeHtml(change.status)}</span>
            </div>
          </div>
          <div class="modal-foot">
            <span class="panel-kicker">Snapshots stored locally</span>
            <div class="modal-foot-right">
              <button class="button button-ghost compact" type="button" data-close-modal>Close</button>
              ${
                change.status === "preview"
                  ? `<button class="button button-primary compact" type="button" data-apply-id="${change.id}">Apply change</button>`
                  : change.status === "applied"
                    ? `<button class="button danger compact" type="button" data-revert-id="${change.id}">Revert</button>`
                    : ""
              }
            </div>
          </div>
        </div>
      </div>
    `;
  } catch (error) {
    showToast("Could not load change", error.message, { icon: "!", error: true });
  }
}

function renderDiffPanel(change, { expanded = false } = {}) {
  const items = change.diff ?? [];
  return `
    <div class="diff-panel">
      <div class="diff-panel-head">
        <strong>${number(items.length)} row${items.length === 1 ? "" : "s"} changed</strong>
        <span>${escapeHtml((change.summary?.changedColumns ?? []).join(", ") || "no columns")}</span>
      </div>
      <div class="diff-rows" ${expanded ? "" : 'style="max-height:190px"'}>
        ${
          items.length
            ? items
                .map(
                  (item) => `
                    <div class="diff-row">
                      <span class="diff-row-key">${escapeHtml(item.displayKey ?? item.key)}</span>
                      <div class="diff-values">
                        ${item.changed
                          .map(
                            (column) => `
                              <span class="before">${escapeHtml(column)}: ${escapeHtml(
                                displayValue(item.before?.[column]),
                              )}</span>
                              <span class="after">${escapeHtml(column)}: ${escapeHtml(
                                displayValue(item.after?.[column]),
                              )}</span>
                            `,
                          )
                          .join("")}
                      </div>
                    </div>
                  `,
                )
                .join("")
            : `<div class="empty-inline"><span>No row-level diff is available.</span></div>`
        }
      </div>
    </div>
  `;
}

async function refreshAfterWrite() {
  await loadWorkspace();
  if (state.currentView === "changes") await loadChanges();
  if (state.currentView === "tables" && state.currentTable) {
    await selectTable(state.currentTable);
  }
}

async function loadConnect() {
  try {
    const payload = await api("/api/connect");
    state.connect = payload;
    renderConnect();
  } catch (error) {
    showToast("Connection details unavailable", error.message, {
      icon: "!",
      error: true,
    });
  }
}

function renderConnect() {
  if (!state.connect) return;
  const endpoint = `${location.origin}/mcp`;
  $("#connect-endpoint").textContent = endpoint;
  $("#mcp-endpoint").textContent = endpoint;
  const clients = state.connect.clients ?? [];
  const client =
    clients.find((item) => item.id === state.selectedClientId) ?? clients[0];
  if (client) state.selectedClientId = client.id;
  $("#client-picker").innerHTML = clients
    .map(
      (item) => `
        <button
          type="button"
          data-client="${escapeHtml(item.id)}"
          class="${item.id === state.selectedClientId ? "active" : ""}"
        >${escapeHtml(item.name)}</button>
      `,
    )
    .join("");
  $("#config-label").textContent = client?.location ?? "mcp.json";
  $("#config-json").textContent = client ? currentClientConfigText() : "";
  const command = $("#client-command");
  if (client?.command) {
    command.hidden = false;
    command.innerHTML = `
      <span>ONE COMMAND</span>
      <code>${escapeHtml(client.command)}</code>
      <button type="button" data-copy-client-command="${escapeHtml(client.command)}">copy</button>
    `;
  } else {
    command.hidden = true;
    command.innerHTML = "";
  }
  $("#client-location").textContent = client
    ? `Save or paste this under ${client.location}`
    : "";
  $("#tool-grid").innerHTML = state.connect.tools
    .map(
      (tool) => `
        <div class="tool-chip">
          <code>${escapeHtml(tool)}</code>
          <span>${escapeHtml(TOOL_DESCRIPTIONS[tool] ?? "MCP tool")}</span>
        </div>
      `,
    )
    .join("");
}

function selectedClient() {
  return (
    state.connect?.clients?.find(
      (client) => client.id === state.selectedClientId,
    ) ?? state.connect?.clients?.[0]
  );
}

function currentClientConfigText() {
  const client = selectedClient();
  if (!client) return "";
  if (client.format === "toml" || typeof client.config === "string") {
    return String(client.config);
  }
  return JSON.stringify(client.config, null, 2);
}

async function openChangeBuilder({ table = null } = {}) {
  state.builder = {
    loading: true,
    tableName: table,
    table: null,
    rows: [],
    action: "update",
    selectedIndex: 0,
    editable: {},
    reason: "",
    plan: null,
    error: "",
  };
  renderChangeBuilder();
  try {
    if (!state.tables) {
      const payload = await api("/api/tables");
      state.tables = payload.tables;
    }
    const candidate =
      state.tables.find((item) => item.name === table) ??
      state.tables.find(
        (item) =>
          (item.name === "customers" || item.name.endsWith(".customers")) &&
          item.type === "table" &&
          item.mutable,
      ) ??
      state.tables.find((item) => item.type === "table" && item.mutable) ??
      state.tables.find((item) => item.type === "table");
    if (!candidate) throw new Error("There are no mutable tables in this database.");
    state.builder.tableName = candidate.name;
    await loadBuilderTable(candidate.name);
  } catch (error) {
    state.builder.loading = false;
    state.builder.error = error.message;
    renderChangeBuilder();
  }
}

async function loadBuilderTable(tableName) {
  if (!state.builder) return;
  state.builder.loading = true;
  state.builder.tableName = tableName;
  state.builder.plan = null;
  state.builder.error = "";
  renderChangeBuilder();
  try {
    const [table, rows] = await Promise.all([
      api(`/api/tables/${encodeURIComponent(tableName)}`),
      api(`/api/tables/${encodeURIComponent(tableName)}/rows?limit=50&offset=0`),
    ]);
    state.builder.table = table;
    state.builder.rows = rows.rows;
    state.builder.action = table.mutable ? "update" : "delete";
    state.builder.selectedIndex = Math.min(
      state.builder.selectedIndex,
      Math.max(0, rows.rows.length - 1),
    );
    initializeBuilderValues();
    state.builder.loading = false;
    renderChangeBuilder();
  } catch (error) {
    state.builder.loading = false;
    state.builder.error = error.message;
    renderChangeBuilder();
  }
}

function initializeBuilderValues() {
  const builder = state.builder;
  if (!builder?.table) return;
  const row = builder.rows[builder.selectedIndex] ?? null;
  builder.editable = {};
  for (const column of builder.table.columns) {
    if (column.generated) continue;
    if (
      builder.action !== "insert" &&
      builder.table.primaryKey.includes(column.name)
    ) {
      continue;
    }
    if (builder.action === "insert") {
      builder.editable[column.name] = "";
    } else if (row) {
      builder.editable[column.name] = displayValue(row[column.name]);
    }
  }
}

function renderChangeBuilder() {
  const builder = state.builder;
  const root = $("#modal-root");
  if (!builder) {
    root.innerHTML = "";
    return;
  }
  const tableOptions = (state.tables ?? [])
    .filter((item) => item.type === "table")
    .map(
      (item) => `
        <option value="${escapeHtml(item.name)}" ${
          builder.tableName === item.name ? "selected" : ""
        }>${escapeHtml(item.name)}${item.mutable ? "" : " (read-only)"}</option>
      `,
    )
    .join("");

  if (builder.plan) {
    renderChangeReview(builder, tableOptions);
    return;
  }

  const selectedRow = builder.rows[builder.selectedIndex] ?? null;
  const mutable = builder.table?.mutable ?? false;
  const rowPicker =
    builder.action !== "insert" && builder.rows.length > 0
      ? `
        <div class="form-field full">
          <label>Rows matched by this preview</label>
          <select class="field-select" id="builder-row">
            ${builder.rows
              .map((row, index) => {
                const key = builder.table.primaryKey
                  .map((column) => `${column}=${displayValue(row[column])}`)
                  .join(", ");
                const displayColumn = builder.table.columns.find(
                  (column) =>
                    !builder.table.primaryKey.includes(column.name) &&
                    typeof row[column.name] === "string",
                )?.name;
                const label = displayColumn ? row[displayColumn] : key;
                return `<option value="${index}" ${index === builder.selectedIndex ? "selected" : ""}>${escapeHtml(
                  `${label} · ${key}`,
                )}</option>`;
              })
              .join("")}
          </select>
        </div>
      `
      : "";

  const rowPreview =
    selectedRow && builder.action !== "insert"
      ? `
        <div class="row-preview">
          <div class="row-preview-head">
            <span>Selected row snapshot</span>
            <span>${escapeHtml(
              builder.table.primaryKey
                .map((column) => `${column}=${displayValue(selectedRow[column])}`)
                .join(", "),
            )}</span>
          </div>
          <div class="row-preview-grid">
            ${builder.table.columns
              .slice(0, 6)
              .map(
                (column) => `
                  <div class="row-preview-item">
                    <span>${escapeHtml(column.name)}</span>
                    <strong>${escapeHtml(displayValue(selectedRow[column.name]))}</strong>
                  </div>
                `,
              )
              .join("")}
          </div>
        </div>
      `
      : "";

  const valueFields =
    builder.action !== "delete" && builder.table
      ? `
        <div class="values-section">
          <div class="detail-section-head">
            <h3>${builder.action === "insert" ? "New row values" : "Proposed values"}</h3>
            <span class="panel-kicker">typed before submit</span>
          </div>
          <div class="values-grid">
            ${builder.table.columns
              .filter(
                (column) =>
                  !column.generated &&
                  !(
                    builder.action === "insert" &&
                    builder.table.autoIncrement &&
                    builder.table.primaryKey.includes(column.name)
                  ) &&
                  !(builder.action === "update" && builder.table.primaryKey.includes(column.name)),
              )
              .map(
                (column) => `
                  <div class="form-field">
                    <label for="field-${escapeHtml(column.name)}">
                      ${escapeHtml(column.name)}
                      <small>${escapeHtml(column.type)}${column.notNull ? " · required" : ""}</small>
                    </label>
                    <input
                      class="field-input"
                      id="field-${escapeHtml(column.name)}"
                      data-field="${escapeHtml(column.name)}"
                      value="${escapeHtml(builder.editable[column.name] ?? "")}"
                      placeholder="${escapeHtml(column.defaultValue == null ? "null" : `default ${column.defaultValue}`)}"
                    />
                  </div>
                `,
              )
              .join("")}
          </div>
        </div>
      `
      : "";

  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <div class="modal-head">
          <div>
            <h2>Preview a governed change</h2>
            <p>CleverSQL dry-runs the write, shows the exact diff, and rolls it back.</p>
          </div>
          <button class="modal-close" type="button" data-close-modal>×</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="form-field full">
              <label>Operation</label>
              <div class="action-switch" id="builder-action">
                ${["update", "delete", "insert"]
                  .map(
                    (action) => `
                      <button type="button" data-builder-action="${action}" class="${
                        builder.action === action ? "active" : ""
                      }" ${!mutable ? "disabled" : ""}>${action}</button>
                    `,
                  )
                  .join("")}
              </div>
            </div>
            <div class="form-field full">
              <label for="builder-table">Table</label>
              <select class="field-select" id="builder-table" ${builder.loading ? "disabled" : ""}>
                ${tableOptions}
              </select>
            </div>
            ${builder.loading ? '<div class="form-field full"><div class="skeleton-block" style="height:150px"></div></div>' : ""}
            ${!builder.loading ? rowPicker : ""}
          </div>
          ${!builder.loading ? rowPreview : ""}
          ${!builder.loading ? valueFields : ""}
          ${
            builder.table && !mutable
              ? `<div class="notice"><span>⌾</span><div><strong>This table is read-only.</strong> ${escapeHtml(
                  builder.table.reason ?? "Add a primary key to enable safe changes.",
                )}</div></div>`
              : ""
          }
          <div class="form-field full" style="margin-top:17px">
            <label for="builder-reason">Why is this change necessary?</label>
            <textarea class="field-textarea" id="builder-reason" placeholder="Example: activate the customer after confirming annual payment.">${escapeHtml(
              builder.reason,
            )}</textarea>
          </div>
          ${builder.error ? `<div class="modal-error">${escapeHtml(builder.error)}</div>` : ""}
        </div>
        <div class="modal-foot">
          <span class="panel-kicker">Nothing is committed during preview</span>
          <div class="modal-foot-right">
            <button class="button button-ghost compact" type="button" data-close-modal>Cancel</button>
            <button class="button button-primary compact" type="button" id="preview-change-submit" ${
              builder.loading || !mutable || builder.reason.trim().length < 4
                ? "disabled"
                : ""
            }>Preview diff</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderChangeReview(builder, tableOptions) {
  const plan = builder.plan;
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <div class="modal-head">
          <div>
            <h2>Review the exact diff</h2>
            <p>${escapeHtml(plan.id)} · preview expires in 10 minutes</p>
          </div>
          <button class="modal-close" type="button" data-close-modal>×</button>
        </div>
        <div class="modal-body">
          <div class="change-title-line">
            <h3 style="margin:0;font-size:15px">${escapeHtml(actionLabel(plan.action))} ${escapeHtml(plan.table)}</h3>
            <span class="status-pill preview">preview verified</span>
          </div>
          <div class="change-meta">
            <span>${number(plan.summary?.matchedRows ?? 0)} matched</span>
            <span>${number(plan.summary?.changedRows ?? 0)} changed</span>
            <span>${escapeHtml((plan.summary?.changedColumns ?? []).join(", ") || "no columns")}</span>
          </div>
          <div class="change-reason">“${escapeHtml(plan.reason)}”</div>
          ${renderDiffPanel(plan, { expanded: true })}
          <div class="notice">
            <span>◎</span>
            <div><strong>Conflict check armed.</strong> If these rows change before apply, CleverSQL will reject the commit and ask for a new preview.</div>
          </div>
          ${builder.error ? `<div class="modal-error">${escapeHtml(builder.error)}</div>` : ""}
        </div>
        <div class="modal-foot">
          <span class="panel-kicker">${escapeHtml(plan.table)} · ${escapeHtml(plan.actor)}</span>
          <div class="modal-foot-right">
            <button class="button button-ghost compact" type="button" id="builder-back">Back</button>
            <button class="button button-primary compact" type="button" id="apply-builder-change">Apply ${number(
              plan.summary?.affectedRows ?? 0,
            )} row${plan.summary?.affectedRows === 1 ? "" : "s"}</button>
          </div>
        </div>
      </div>
    </div>
    <datalist id="builder-table-options">${tableOptions}</datalist>
  `;
}

function coerceValue(value, original) {
  if (typeof original === "number") {
    if (value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (typeof original === "boolean") {
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }
  if (original === null && value.trim() === "") return null;
  return value;
}

function builderPayload() {
  const builder = state.builder;
  const table = builder.table;
  const selectedRow = builder.rows[builder.selectedIndex];
  let values = null;
  let where = null;

  if (builder.action === "update") {
    values = {};
    for (const [columnName, value] of Object.entries(builder.editable)) {
      const original = selectedRow?.[columnName];
      const coerced = coerceValue(String(value ?? ""), original);
      if (JSON.stringify(coerced) !== JSON.stringify(original)) {
        values[columnName] = coerced;
      }
    }
    if (Object.keys(values).length === 0) {
      throw new Error("Change at least one value before previewing.");
    }
  }

  if (builder.action === "insert") {
    values = {};
    for (const [columnName, value] of Object.entries(builder.editable)) {
      if (String(value).trim() === "") continue;
      const column = table.columns.find((item) => item.name === columnName);
      const type = column?.type ?? "";
      values[columnName] = /^(bigint|numeric|decimal)/i.test(type)
        ? String(value).trim()
        : /INT|REAL|NUM|DEC|FLOAT|DOUBLE/i.test(type) &&
            Number.isFinite(Number(value))
          ? Number(value)
          : value;
    }
  }

  if (builder.action !== "insert") {
    if (!selectedRow) throw new Error("Select a row first.");
    where = table.primaryKey.map((column) => ({
      column,
      op: "eq",
      value: selectedRow[column],
    }));
  }

  return {
    action: builder.action,
    table: table.name,
    ...(where ? { where } : {}),
    ...(values ? { values } : {}),
    reason: builder.reason.trim(),
    maxAffected: 1,
  };
}

async function previewBuilderChange() {
  const builder = state.builder;
  if (!builder) return;
  const button = $("#preview-change-submit");
  builder.error = "";
  if (button) {
    button.disabled = true;
    button.textContent = "Previewing…";
  }
  try {
    const payload = builderPayload();
    const plan = await api("/api/changes/preview", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    builder.plan = plan;
    renderChangeBuilder();
    showToast("Preview verified", "Nothing has been committed yet.", {
      icon: "◎",
    });
  } catch (error) {
    builder.error = error.message;
    renderChangeBuilder();
  }
}

async function applyBuilderChange() {
  const builder = state.builder;
  if (!builder?.plan) return;
  const button = $("#apply-builder-change");
  if (button) {
    button.disabled = true;
    button.textContent = "Applying…";
  }
  try {
    const plan = await api(`/api/changes/${builder.plan.id}/apply`, {
      method: "POST",
      body: "{}",
    });
    closeModal();
    state.builder = null;
    showToast(
      "Change applied",
      `${actionLabel(plan.action)} ${plan.table} · ${plan.id}`,
      {
        icon: "✓",
        actionLabel: "Undo",
        action: () => revertChange(plan.id, plan),
      },
    );
    await refreshAfterWrite();
  } catch (error) {
    builder.error = error.message;
    renderChangeBuilder();
  }
}

function bindEvents() {
  document.addEventListener("click", async (event) => {
    const nav = event.target.closest("[data-view]");
    if (nav) {
      navTo(nav.dataset.view);
      return;
    }

    const goto = event.target.closest("[data-goto]");
    if (goto) {
      navTo(goto.dataset.goto);
      return;
    }

    const preset = event.target.closest("[data-preset]");
    if (preset) {
      navTo("query");
      applyQueryPreset(preset.dataset.preset);
      return;
    }

    const clientButton = event.target.closest("[data-client]");
    if (clientButton) {
      state.selectedClientId = clientButton.dataset.client;
      renderConnect();
      return;
    }

    const clientCommand = event.target.closest("[data-copy-client-command]");
    if (clientCommand) {
      copyText(
        clientCommand.dataset.copyClientCommand,
        `${selectedClient()?.name ?? "Client"} command copied`,
      );
      return;
    }

    const overviewTable = event.target.closest("[data-table]");
    if (overviewTable) {
      navTo("tables");
      await loadTables({ preserveSelection: false });
      await selectTable(overviewTable.dataset.table);
      return;
    }

    const browserTable = event.target.closest("[data-browser-table]");
    if (browserTable) {
      await selectTable(browserTable.dataset.browserTable);
      return;
    }

    const editTable = event.target.closest("[data-edit-table]");
    if (editTable) {
      await openChangeBuilder({ table: editTable.dataset.editTable });
      return;
    }

    const queryTable = event.target.closest("[data-query-table]");
    if (queryTable) {
      const tableName = queryTable.dataset.queryTable;
      const queryIdent = tableName
        .split(".")
        .map((part) => `"${part.replaceAll('"', '""')}"`)
        .join(".");
      navTo("query");
      $("#sql-editor").value = `SELECT *\nFROM ${queryIdent}\nLIMIT 50;`;
      updateLineRail();
      await runQuery();
      return;
    }

    const close = event.target.closest("[data-close-modal]");
    if (close) {
      closeModal();
      state.builder = null;
      return;
    }

    const changeAction = event.target.closest("[data-change-action]");
    if (changeAction) {
      const { changeAction: action, changeId } = changeAction.dataset;
      if (action === "view") await viewChange(changeId);
      if (action === "apply") await applyChange(changeId);
      if (action === "revert") await revertChange(changeId);
      return;
    }

    const applyId = event.target.closest("[data-apply-id]");
    if (applyId) {
      closeModal();
      await applyChange(applyId.dataset.applyId);
      return;
    }

    const revertId = event.target.closest("[data-revert-id]");
    if (revertId) {
      closeModal();
      await revertChange(revertId.dataset.revertId);
      return;
    }

    const builderAction = event.target.closest("[data-builder-action]");
    if (builderAction && state.builder) {
      state.builder.action = builderAction.dataset.builderAction;
      state.builder.plan = null;
      state.builder.error = "";
      initializeBuilderValues();
      renderChangeBuilder();
      return;
    }

    if (event.target.closest("[data-open-change]")) {
      await openChangeBuilder();
      return;
    }

    if (event.target.closest(".modal-backdrop")) {
      if (event.target.matches(".modal-backdrop")) {
        closeModal();
        state.builder = null;
      }
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "builder-reason" && state.builder) {
      state.builder.reason = event.target.value;
      const button = $("#preview-change-submit");
      if (button) button.disabled = state.builder.reason.trim().length < 4;
    }
    if (event.target.dataset.field && state.builder) {
      state.builder.editable[event.target.dataset.field] = event.target.value;
    }
    if (event.target.id === "sql-editor") updateLineRail();
  });

  document.addEventListener("change", (event) => {
    if (event.target.id === "builder-table" && state.builder) {
      loadBuilderTable(event.target.value);
    }
    if (event.target.id === "builder-row" && state.builder) {
      state.builder.selectedIndex = Number(event.target.value);
      initializeBuilderValues();
      renderChangeBuilder();
    }
    if (event.target.id === "query-presets") {
      applyQueryPreset(event.target.value);
    }
    if (event.target.id === "change-filters") return;
  });

  $("#run-query").addEventListener("click", runQuery);
  $("#hero-query").addEventListener("click", () => navTo("query"));
  $("#open-query-top").addEventListener("click", () => navTo("query"));
  $("#hero-change").addEventListener("click", () => openChangeBuilder());
  $("#new-change-top").addEventListener("click", () => openChangeBuilder());
  $("#new-change-ledger").addEventListener("click", () => openChangeBuilder());
  $("#refresh-tables").addEventListener("click", () => loadTables());
  $("#refresh-changes").addEventListener("click", loadChanges);
  $("#table-filter").addEventListener("input", renderTableBrowserList);
  $("#copy-endpoint").addEventListener("click", () =>
    copyText(`${location.origin}/mcp`, "MCP endpoint copied"),
  );
  $("#copy-config").addEventListener("click", () =>
    copyText(currentClientConfigText(), `${selectedClient()?.name ?? "Client"} config copied`),
  );
  $("#copy-json").addEventListener("click", () =>
    copyText(currentClientConfigText(), "Config copied"),
  );
  $("#copy-command").addEventListener("click", () =>
    copyText("npx cleversql demo", "Command copied"),
  );

  $("#change-filters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-status]");
    if (!button) return;
    state.changeStatus = button.dataset.status;
    $$("button", $("#change-filters")).forEach((item) =>
      item.classList.toggle("active", item === button),
    );
    loadChanges();
  });

  document.addEventListener("click", (event) => {
    if (event.target.id === "preview-change-submit") previewBuilderChange();
    if (event.target.id === "apply-builder-change") applyBuilderChange();
    if (event.target.id === "builder-back" && state.builder) {
      state.builder.plan = null;
      renderChangeBuilder();
    }
  });

  $("#sql-editor").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      runQuery();
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const editor = event.target;
      const start = editor.selectionStart;
      editor.value = `${editor.value.slice(0, start)}  ${editor.value.slice(editor.selectionEnd)}`;
      editor.selectionStart = editor.selectionEnd = start + 2;
      updateLineRail();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if ($("#modal-root").children.length) {
        closeModal();
        state.builder = null;
      }
    }
    const tag = document.activeElement?.tagName;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
    if (event.key === "1") navTo("overview");
    if (event.key === "2") navTo("tables");
    if (event.key === "3") navTo("query");
  });

  window.addEventListener("hashchange", () => {
    navTo(location.hash.replace("#", "") || "overview", { updateHash: false });
  });
}

async function boot() {
  bindEvents();
  updateLineRail();
  await loadWorkspace();
}

boot();
