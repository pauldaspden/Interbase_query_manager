/* ═══════════════════════════════════════════════════════════════
   InterBase Query Manager — Frontend JS
   ═══════════════════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────────────────
let state = {
    servers: [],
    currentServer: null,
    currentDb: null,
    metadata: [],
    editor: null,
    multiEditor: null,
};

// ── Init ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initEditor();
    loadServers();
    loadConfig();
    loadHistory();
    loadScriptsList();

    // Ctrl+Enter to execute
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            const activeTab = document.querySelector('.tab.active').dataset.tab;
            if (activeTab === 'editor') runQuery();
            else if (activeTab === 'multi') runMultiQuery();
        }
    });
});

function initEditor() {
    const ta = document.getElementById('sqlEditor');
    state.editor = CodeMirror.fromTextArea(ta, {
        mode: 'text/x-sql',
        theme: 'material-darker',
        lineNumbers: true,
        matchBrackets: true,
        indentUnit: 2,
        tabSize: 2,
        extraKeys: {
            'Ctrl-Space': 'autocomplete',
            'Ctrl-/': (cm) => cm.execCommand('toggleComment'),
        },
    });

    const ta2 = document.getElementById('multiSqlEditor');
    state.multiEditor = CodeMirror.fromTextArea(ta2, {
        mode: 'text/x-sql',
        theme: 'material-darker',
        lineNumbers: true,
        matchBrackets: true,
        indentUnit: 2,
        tabSize: 2,
    });
}

// ── API helpers ──────────────────────────────────────────────────
async function api(url, opts = {}) {
    const res = await fetch(url, {
        ...opts,
        headers: { 'Content-Type': 'application/json', ...opts.headers },
    });
    // Handle non-JSON responses (e.g. Flask HTML error pages)
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        const text = await res.text();
        // Try to extract the error from HTML
        const match = text.match(/<title>(.*?)<\/title>/i);
        const errTitle = match ? match[1] : `HTTP ${res.status}`;
        throw new Error(`${errTitle} — server returned HTML instead of JSON. Check if the database connection is working.`);
    }
    return res.json();
}

// ── Servers ──────────────────────────────────────────────────────
async function loadServers() {
    const servers = await api('/api/servers');
    state.servers = servers;
    renderServerTree(servers);
    populateServerSelect(servers);
    renderMultiTargets(servers);
}

function renderServerTree(servers) {
    const tree = document.getElementById('serverTree');
    tree.innerHTML = '';
    servers.forEach(srv => {
        const node = document.createElement('div');
        node.className = 'server-node';
        node.innerHTML = `
            <div class="server-header" onclick="toggleServer(this)">
                <span class="server-icon">🖥</span>
                <span>${esc(srv.name)}</span>
                <span class="db-count-badge">${srv.databases.length}</span>
                <span class="server-status unknown" id="status-${srv.id}"></span>
            </div>
            <div class="db-list" style="display:none">
                <div class="db-add-btn" onclick="openAddDbModal('${srv.id}', '${esc(srv.name)}')">+ Add database</div>
                ${srv.databases.map(db => `
                    <div class="db-node" onclick="selectDb('${srv.id}', '${esc(db.path)}', '${esc(db.name)}', this)">
                        <span class="db-icon">🗄</span>
                        <span class="db-label">${esc(db.name)}</span>
                        <button class="db-delete-btn" title="Delete" onclick="deleteDatabase(event, '${srv.id}', '${esc(db.path)}', '${esc(db.name)}')">×</button>
                    </div>
                `).join('')}
            </div>
        `;
        tree.appendChild(node);
    });
}

function toggleServer(header) {
    const list = header.nextElementSibling;
    list.style.display = list.style.display === 'none' ? 'block' : 'none';
    header.classList.toggle('expanded');
}

function selectDb(serverId, dbPath, dbName, el) {
    state.currentServer = serverId;
    state.currentDb = dbPath;

    // update selects
    const ss = document.getElementById('serverSelect');
    ss.value = serverId;
    onServerChange();
    document.getElementById('dbSelect').value = dbPath;

    // highlight active
    document.querySelectorAll('.db-node').forEach(n => n.classList.remove('active'));
    if (el) {
        el.closest('.db-node')?.classList.add('active');
    } else {
        // fallback: find by path
        document.querySelectorAll('.db-node').forEach(n => {
            if (n.getAttribute('onclick')?.includes(esc(dbPath))) n.classList.add('active');
        });
    }

    loadMetadata();
}

function populateServerSelect(servers) {
    const sel = document.getElementById('serverSelect');
    sel.innerHTML = servers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    if (servers.length > 0) {
        state.currentServer = servers[0].id;
        onServerChange();
    }
}

function onServerChange() {
    const sid = document.getElementById('serverSelect').value;
    state.currentServer = sid;
    const srv = state.servers.find(s => s.id === sid);
    const dbSel = document.getElementById('dbSelect');
    if (srv) {
        dbSel.innerHTML = srv.databases.map(db =>
            `<option value="${esc(db.path)}">${esc(db.name)}</option>`
        ).join('');
        if (srv.databases.length > 0) {
            state.currentDb = srv.databases[0].path;
        }
    }
    loadMetadata();
}

function onDbChange() {
    state.currentDb = document.getElementById('dbSelect').value;
    loadMetadata();
}

// ── Add / Delete databases ───────────────────────────────────────
function openAddDbModal(serverId, serverName) {
    document.getElementById('addDbServerId').value = serverId;
    document.getElementById('addDbServerName').textContent = serverName;
    document.getElementById('addDbName').value = '';
    document.getElementById('addDbPath').value = '';
    document.getElementById('addDbCompanyNum').value = '';
    document.getElementById('addDbModal').style.display = 'flex';
    document.getElementById('addDbName').focus();
}

function closeAddDbModal() {
    document.getElementById('addDbModal').style.display = 'none';
}

async function confirmAddDb() {
    const serverId = document.getElementById('addDbServerId').value;
    const name = document.getElementById('addDbName').value.trim();
    const path = document.getElementById('addDbPath').value.trim();
    const companyNum = document.getElementById('addDbCompanyNum').value.trim();

    if (!name || !path) {
        alert('Name and path are required');
        return;
    }

    const res = await api(`/api/servers/${serverId}/databases`, {
        method: 'POST',
        body: JSON.stringify({ name, path, company_number: companyNum }),
    });

    if (res.ok) {
        closeAddDbModal();
        await loadServers();
        alert(`Added: ${name}`);
    } else {
        alert('Error: ' + (res.error || 'Unknown error'));
    }
}

async function deleteDatabase(event, serverId, dbPath, dbName) {
    event.stopPropagation();
    if (!confirm(`Delete database "${dbName}"?\n(Path: ${dbPath})\n\nThis only removes it from the app config — it does NOT delete the actual database file.`)) {
        return;
    }
    const res = await api(`/api/servers/${serverId}/databases?path=${encodeURIComponent(dbPath)}`, {
        method: 'DELETE',
    });
    if (res.ok) {
        await loadServers();
        // If we deleted the currently selected db, reset
        if (state.currentDb === dbPath) {
            state.currentDb = null;
        }
    } else {
        alert('Error: ' + (res.error || 'Unknown error'));
    }
}

// ── Metadata ─────────────────────────────────────────────────────
async function loadMetadata() {
    if (!state.currentServer || !state.currentDb) return;
    const tree = document.getElementById('metadataTree');
    tree.innerHTML = '<p class="muted loading">Loading schema…</p>';

    try {
        const meta = await api(`/api/metadata/${state.currentServer}?db=${encodeURIComponent(state.currentDb)}`);
        if (meta.error) {
            tree.innerHTML = `<div class="error-msg">${esc(meta.error)}</div>`;
            return;
        }
        state.metadata = meta;
        renderMetadata(meta);
    } catch (e) {
        tree.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
}

function renderMetadata(meta) {
    const tree = document.getElementById('metadataTree');
    if (!meta || meta.length === 0) {
        tree.innerHTML = '<p class="muted">No tables found.</p>';
        return;
    }
    tree.innerHTML = meta.map(tbl => `
        <div class="meta-table" id="meta-${esc(tbl.name)}">
            <div class="meta-table-header" onclick="toggleMetaTable(this)">
                <span class="meta-table-type ${tbl.type === 'VIEW' ? 'view' : ''}">${tbl.type}</span>
                <span>${esc(tbl.name)}</span>
                ${tbl.primary_key && tbl.primary_key.length ? '<span class="meta-table-type pk">PK</span>' : ''}
                <span class="meta-table-type" style="margin-left:auto">${tbl.columns?.length || 0} cols</span>
            </div>
            <div class="meta-columns">
                ${(tbl.columns || []).map(col => `
                    <div class="meta-column">
                        <span class="meta-col-name ${tbl.primary_key?.includes(col.name) ? 'meta-col-pk' : ''}">${esc(col.name)}</span>
                        <span class="meta-col-type">${esc(col.type)}</span>
                        ${!col.nullable ? '<span class="meta-col-notnull">NOT NULL</span>' : ''}
                    </div>
                `).join('')}
                <div style="padding: 4px 8px;">
                    <button class="btn btn-small" onclick="insertTable('${esc(tbl.name)}')">📋 Insert INTO editor</button>
                    <button class="btn btn-small" onclick="previewTable('${esc(tbl.name)}')">👁 Preview 100 rows</button>
                    <button class="btn btn-small" onclick="countTable('${esc(tbl.name)}')">#️⃣ Count</button>
                </div>
            </div>
        </div>
    `).join('');
}

function toggleMetaTable(header) {
    header.parentElement.classList.toggle('expanded');
}

function filterMetadata() {
    const q = document.getElementById('metaSearch').value.toLowerCase();
    document.querySelectorAll('.meta-table').forEach(el => {
        const text = el.textContent.toLowerCase();
        el.style.display = text.includes(q) ? '' : 'none';
        if (q && text.includes(q)) {
            el.classList.add('expanded');
        }
    });
}

function insertTable(tableName) {
    const sql = `SELECT *\nFROM "${tableName}"\nLIMIT 100;`;
    state.editor.setValue(sql);
    switchTab('editor');
    state.editor.focus();
}

async function previewTable(tableName) {
    state.editor.setValue(`SELECT FIRST 100 *\nFROM "${tableName}";`);
    switchTab('editor');
    const url = `/api/table-preview/${state.currentServer}?db=${encodeURIComponent(state.currentDb)}&table=${encodeURIComponent(tableName)}`;
    showLoading('Loading preview…');
    const res = await api(url);
    if (res.error) { showResultError(res.error); return; }
    renderResults(res, `Preview of ${tableName}`);
}

async function countTable(tableName) {
    const url = `/api/table-count/${state.currentServer}?db=${encodeURIComponent(state.currentDb)}&table=${encodeURIComponent(tableName)}`;
    const res = await api(url);
    if (res.error) {
        alert('Error: ' + res.error);
    } else {
        alert(`${tableName}: ${res.count.toLocaleString()} rows`);
    }
}

// ── Query Execution ──────────────────────────────────────────────
async function runQuery() {
    const sql = state.editor.getValue().trim();
    if (!sql) { alert('Enter a SQL query first'); return; }
    if (!state.currentServer || !state.currentDb) { alert('Select a server and database'); return; }

    const maxRows = parseInt(document.getElementById('maxRows').value) || 1000;
    showLoading('Executing…');

    try {
        const res = await api('/api/query', {
            method: 'POST',
            body: JSON.stringify({
                server_id: state.currentServer,
                db_path: state.currentDb,
                sql: sql,
                max_rows: maxRows,
            }),
        });
        if (res.error) {
            showResultError(res.error, res.elapsed);
        } else if (res.rows_affected !== undefined) {
            showDmlResult(res.rows_affected, res.elapsed);
        } else {
            renderResults(res, `${res.row_count} rows`);
        }
        loadHistory();
    } catch (e) {
        showResultError(e.message);
    }
}

function showLoading(msg) {
    const panel = document.getElementById('resultsPanel');
    panel.style.display = 'flex';
    panel.innerHTML = `<div class="results-header"><span class="results-info loading">${msg}</span></div>`;
}

function showResultError(err, elapsed) {
    const panel = document.getElementById('resultsPanel');
    panel.style.display = 'flex';
    panel.innerHTML = `
        <div class="results-header">
            <span class="results-info" style="color:var(--error)">❌ Error${elapsed ? ` (${elapsed}s)` : ''}</span>
        </div>
        <div class="error-msg" style="padding:14px">${esc(err)}</div>
    `;
}

function showDmlResult(affected, elapsed) {
    const panel = document.getElementById('resultsPanel');
    panel.style.display = 'flex';
    panel.innerHTML = `
        <div class="results-header">
            <span class="results-info" style="color:var(--success)">✅ ${affected} row(s) affected (${elapsed}s)</span>
        </div>
    `;
}

function renderResults(res, label) {
    const panel = document.getElementById('resultsPanel');
    panel.style.display = 'flex';
    const truncated = res.truncated ? ' <span style="color:var(--warning)">(truncated)</span>' : '';
    panel.innerHTML = `
        <div class="results-header">
            <span class="results-info">${label}${truncated} — ${res.columns.length} columns</span>
            <span class="results-timer">${res.elapsed}s</span>
        </div>
        <div class="results-table-wrap">
            <table class="results-table">
                <thead><tr>${res.columns.map(c => `<th onclick="sortTable(this, ${res.columns.indexOf(c)})">${esc(c)}</th>`).join('')}</tr></thead>
                <tbody>
                    ${res.rows.map(row =>
                        `<tr>${row.map(v => `<td>${formatCell(v)}</td>`).join('')}</tr>`
                    ).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function formatCell(v) {
    if (v === null || v === undefined) return '<span class="null-val">NULL</span>';
    if (typeof v === 'number') return `<span class="num-val">${v}</span>`;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string' && v.length > 200) v = v.substring(0, 200) + '…';
    return esc(String(v));
}

function sortTable(th, colIdx) {
    const table = th.closest('table');
    const tbody = table.querySelector('tbody');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const asc = th.dataset.sort === 'asc';
    th.dataset.sort = asc ? 'desc' : 'asc';
    rows.sort((a, b) => {
        const av = a.cells[colIdx].textContent;
        const bv = b.cells[colIdx].textContent;
        const an = parseFloat(av), bn = parseFloat(bv);
        if (!isNaN(an) && !isNaN(bn)) return asc ? an - bn : bn - an;
        return asc ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    rows.forEach(r => tbody.appendChild(r));
}

// ── Multi-Server Query ───────────────────────────────────────────
function renderMultiTargets(servers) {
    const div = document.getElementById('multiTargets');
    div.innerHTML = servers.map(srv =>
        srv.databases.map(db => `
            <div class="multi-target">
                <input type="checkbox" class="mt-check" data-server="${srv.id}" data-db="${esc(db.path)}" checked>
                <label>
                    <div class="mt-server">${esc(srv.name)}</div>
                    <div class="mt-db">${esc(db.name)} — ${esc(db.path)}</div>
                </label>
            </div>
        `).join('')
    ).join('');
}

async function runMultiQuery() {
    const sql = state.multiEditor.getValue().trim();
    if (!sql) { alert('Enter SQL first'); return; }

    // Frontend safeguard: check for SELECT-only
    if (!isSelectOnly(sql)) {
        alert('⚠ READ-ONLY MODE\n\nMulti-Server mode only allows SELECT queries.\n'
            + 'INSERT, UPDATE, DELETE, DROP, ALTER, CREATE and other write operations are blocked.');
        return;
    }

    const checks = document.querySelectorAll('.mt-check:checked');
    if (checks.length === 0) { alert('Select at least one target'); return; }

    const targets = Array.from(checks).map(c => ({
        server_id: c.dataset.server,
        db_path: c.dataset.db,
    }));

    const maxRows = parseInt(document.getElementById('maxRows').value) || 500;
    const resDiv = document.getElementById('multiResults');
    resDiv.innerHTML = '<p class="muted loading">Executing across all targets…</p>';

    try {
        const res = await api('/api/multi-query', {
            method: 'POST',
            body: JSON.stringify({ targets, sql, max_rows: maxRows }),
        });
        if (res.error) {
            resDiv.innerHTML = `<div class="error-msg" style="margin-top:12px">${esc(res.error)}</div>`;
            return;
        }
        renderMultiResults(res.results);
    } catch (e) {
        resDiv.innerHTML = `<p class="error-msg">${esc(e.message)}</p>`;
    }
}

// ── SELECT-only check (frontend) ─────────────────────────────────
function isSelectOnly(sql) {
    if (!sql || !sql.trim()) return false;
    // Strip comments
    let cleaned = sql.replace(/--[^\n]*/g, '').replace(/\/\*.*?\*\//g, 's').trim();
    if (!cleaned) return false;
    // Split on semicolons
    let statements = cleaned.split(';').map(s => s.trim()).filter(s => s.length > 0);
    if (statements.length === 0) return false;

    const writeWords = /\b(insert|update|delete|drop|alter|create|truncate|merge|execute|exec|grant|revoke|commit|rollback|savepoint|declare|replace|rename|attach|detach|recreate|shutdown|backup|restore)\b/i;

    for (let stmt of statements) {
        // First word must be SELECT or WITH
        let firstWord = stmt.split(/\s+/)[0].toUpperCase();
        if (firstWord !== 'SELECT' && firstWord !== 'WITH') return false;
        // Check for write keywords (outside string literals)
        let noStrings = stmt.replace(/'[^']*'/g, "''");
        if (writeWords.test(noStrings)) return false;
        // SELECT ... INTO is a write operation
        if (firstWord === 'SELECT' && /\binto\b/i.test(noStrings)) return false;
    }
    return true;
}

function renderMultiResults(results) {
    const div = document.getElementById('multiResults');
    div.innerHTML = '';
    results.forEach(r => {
        const card = document.createElement('div');
        card.className = 'multi-result-card';
        const status = r.ok ? 'ok' : 'error';
        let body = '';
        if (!r.ok) {
            body = `<div class="multi-result-error">${esc(r.error)}</div>`;
        } else if (r.type === 'SELECT') {
            body = `
                <div class="multi-result-body">
                    <table class="results-table">
                        <thead><tr>${r.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
                        <tbody>
                            ${r.rows.map(row => `<tr>${row.map(v => `<td>${formatCell(v)}</td>`).join('')}</tr>`).join('')}
                        </tbody>
                    </table>
                </div>`;
        } else {
            body = `<div style="padding:10px;color:var(--success)">✅ ${r.rows_affected} row(s) affected</div>`;
        }
        card.innerHTML = `
            <div class="multi-result-header ${status}">
                <span class="mr-title">${esc(r.server_name)} → ${esc(r.db_name)}</span>
                <span class="mr-meta">${r.ok ? (r.row_count || r.rows_affected || 0) + ' rows' : 'Error'} — ${r.elapsed}s</span>
            </div>
            ${body}
        `;
        div.appendChild(card);
    });
}

// ── Export ───────────────────────────────────────────────────────
async function exportCsv() {
    const sql = state.editor.getValue().trim();
    if (!sql || !state.currentServer || !state.currentDb) {
        alert('Enter a query and select a database first');
        return;
    }
    const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            server_id: state.currentServer,
            db_path: state.currentDb,
            sql: sql,
        }),
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'query_results.csv';
    a.click();
    URL.revokeObjectURL(url);
}

// ── History ──────────────────────────────────────────────────────
async function loadHistory() {
    const history = await api('/api/history');
    renderHistory(history);
}

function renderHistory(history) {
    const div = document.getElementById('historyList');
    if (!history || history.length === 0) {
        div.innerHTML = '<p class="muted">No history yet.</p>';
        return;
    }
    div.innerHTML = history.slice().reverse().map(h => {
        const status = h.error ? 'err' : (h.type === 'ERROR' ? 'err' : 'ok');
        const meta = h.error
            ? `<span class="err">error</span>`
            : `<span class="ok">${h.row_count !== undefined ? h.row_count + ' rows' : h.rows_affected + ' affected'}</span> · ${h.elapsed}s`;
        return `
            <div class="history-item">
                <span class="hi-time">${esc(h.ts)}</span>
                <span class="hi-sql">${esc(h.sql.substring(0, 200))}</span>
                <span class="hi-meta">${meta}</span>
                <span class="hi-actions">
                    <button class="btn btn-small" onclick="rerunHistory('${esc(h.id)}')">↻ Re-run</button>
                </span>
            </div>
        `;
    }).join('');
}

function rerunHistory(id) {
    // history is loaded but we need to find it; reload then find
    api('/api/history').then(history => {
        const h = history.find(x => x.id === id);
        if (!h) return;
        state.editor.setValue(h.sql);
        switchTab('editor');
        // also set the server/db
        if (h.server_id) {
            state.currentServer = h.server_id;
            state.currentDb = h.db_path;
            document.getElementById('serverSelect').value = h.server_id;
            onServerChange();
            document.getElementById('dbSelect').value = h.db_path;
        }
        state.editor.focus();
    });
}

async function clearHistory() {
    if (!confirm('Clear all history?')) return;
    await api('/api/history', { method: 'DELETE' });
    loadHistory();
}

// ── Saved Scripts ────────────────────────────────────────────────
async function loadScriptsList() {
    const scripts = await api('/api/scripts');
    renderScripts(scripts);
}

function renderScripts(scripts) {
    const div = document.getElementById('scriptsList');
    if (!scripts || scripts.length === 0) {
        div.innerHTML = '<p class="muted">No saved scripts. Use 💾 Save in the Query Editor tab.</p>';
        return;
    }
    div.innerHTML = scripts.map(s => `
        <div class="script-item">
            <span class="si-name">${esc(s.name)}</span>
            <span class="si-meta">${s.size} bytes · ${s.modified}</span>
            <span class="si-preview">${esc(s.preview)}</span>
            <button class="btn btn-small" onclick="loadSavedScript('${esc(s.filename)}')">📂 Open</button>
            <button class="btn btn-small btn-danger" onclick="deleteSavedScript('${esc(s.filename)}')">🗑</button>
        </div>
    `).join('');
}

async function saveScript() {
    const name = document.getElementById('scriptName').value.trim() || 'untitled';
    const sql = state.editor.getValue();
    if (!sql.trim()) { alert('Nothing to save'); return; }
    await api('/api/scripts', {
        method: 'POST',
        body: JSON.stringify({ name, sql }),
    });
    alert('Saved!');
    loadScriptsList();
}

async function loadSavedScript(fn) {
    const res = await api(`/api/scripts/${fn}`);
    if (res.sql !== undefined) {
        state.editor.setValue(res.sql);
        document.getElementById('scriptName').value = res.filename.replace('.sql', '');
        switchTab('editor');
        state.editor.focus();
    }
}

async function deleteSavedScript(fn) {
    if (!confirm(`Delete ${fn}?`)) return;
    await api(`/api/scripts/${fn}`, { method: 'DELETE' });
    loadScriptsList();
}

function newScript() {
    state.editor.setValue('');
    document.getElementById('scriptName').value = '';
    state.editor.focus();
}

// ── Config / Settings ────────────────────────────────────────────
let configState = null;

async function loadConfig() {
    configState = await api('/api/config');
}

async function openSettings() {
    if (!configState) await loadConfig();
    const c = configState;
    document.getElementById('setUsername').value = c.credentials?.username || '';
    document.getElementById('setPassword').value = '';
    document.getElementById('setMaxRows').value = c.settings?.max_rows || 1000;
    document.getElementById('setQueryTimeout').value = c.settings?.query_timeout || 30;

    const div = document.getElementById('serversConfig');
    div.innerHTML = c.servers.map((s, i) => `
        <div class="server-config-block" data-idx="${i}">
            <div class="server-config-row">
                <input class="scr-name modal-input" placeholder="Name" value="${esc(s.name)}">
                <input class="scr-host modal-input" placeholder="Host" value="${esc(s.host)}">
                <input class="scr-port modal-input" placeholder="Port" value="${s.port || 3050}" style="max-width:60px">
                <button class="btn btn-small btn-danger scr-del" onclick="this.closest('.server-config-block').remove()">✕</button>
            </div>
            <div class="server-config-auth">
                <label class="auth-label">Auth:
                    <select class="scr-auth modal-input">
                        <option value="" ${!s.auth_plugin ? 'selected' : ''}>Auto (Srp256 → Srp → Legacy)</option>
                        <option value="Srp256" ${s.auth_plugin === 'Srp256' ? 'selected' : ''}>Srp256 (InterBase 2020+)</option>
                        <option value="Srp" ${s.auth_plugin === 'Srp' ? 'selected' : ''}>Srp (Firebird 3)</option>
                        <option value="Legacy_Auth" ${s.auth_plugin === 'Legacy_Auth' ? 'selected' : ''}>Legacy_Auth (old InterBase)</option>
                    </select>
                </label>
                <label class="auth-label">Wire encryption:
                    <select class="scr-wirecrypt modal-input">
                        <option value="true" ${s.wire_crypt !== false ? 'selected' : ''}>Enabled</option>
                        <option value="false" ${s.wire_crypt === false ? 'selected' : ''}>Disabled</option>
                    </select>
                </label>
            </div>
            <div class="server-config-dbs">
                ${s.databases.map((db, j) => `
                    <div class="scr-db-row">
                        <input class="modal-input" placeholder="DB Name" value="${esc(db.name)}" data-field="name">
                        <input class="modal-input" placeholder="DB Path" value="${esc(db.path)}" data-field="path">
                        <button class="btn btn-small btn-danger" onclick="this.parentElement.remove()">✕</button>
                    </div>
                `).join('')}
            </div>
            <hr style="border-color:var(--border);margin:12px 0">
        </div>
    `).join('');
    document.getElementById('settingsModal').style.display = 'flex';
}

function addServerConfig() {
    const div = document.getElementById('serversConfig');
    const idx = div.children.length;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
        <div class="server-config-block" data-idx="${idx}">
            <div class="server-config-row">
                <input class="scr-name modal-input" placeholder="Name" value="New Server">
                <input class="scr-host modal-input" placeholder="Host" value="">
                <input class="scr-port modal-input" placeholder="Port" value="3050" style="max-width:60px">
                <button class="btn btn-small btn-danger scr-del" onclick="this.closest('.server-config-block').remove()">✕</button>
            </div>
            <div class="server-config-auth">
                <label class="auth-label">Auth:
                    <select class="scr-auth modal-input">
                        <option value="" selected>Auto (Srp256 → Srp → Legacy)</option>
                        <option value="Srp256">Srp256 (InterBase 2020+)</option>
                        <option value="Srp">Srp (Firebird 3)</option>
                        <option value="Legacy_Auth">Legacy_Auth (old InterBase)</option>
                    </select>
                </label>
                <label class="auth-label">Wire encryption:
                    <select class="scr-wirecrypt modal-input">
                        <option value="true" selected>Enabled</option>
                        <option value="false">Disabled</option>
                    </select>
                </label>
            </div>
            <div class="server-config-dbs">
                <div class="scr-db-row">
                    <input class="modal-input" placeholder="DB Name" value="" data-field="name">
                    <input class="modal-input" placeholder="DB Path" value="" data-field="path">
                    <button class="btn btn-small btn-danger" onclick="this.parentElement.remove()">✕</button>
                </div>
            </div>
            <hr style="border-color:var(--border);margin:12px 0">
        </div>
    `;
    div.appendChild(wrapper);
}

async function saveSettings() {
    const servers = [];
    document.querySelectorAll('#serversConfig .server-config-block').forEach(block => {
        const row = block.querySelector('.server-config-row');
        const dbsDiv = block.querySelector('.server-config-dbs');
        if (!row) return;
        const name = row.querySelector('.scr-name').value;
        const host = row.querySelector('.scr-host').value;
        const port = parseInt(row.querySelector('.scr-port').value) || 3050;
        if (!name || !host) return;

        // Auth plugin + wire encryption
        const authSelect = block.querySelector('.scr-auth');
        const wirecryptSelect = block.querySelector('.scr-wirecrypt');
        const auth_plugin = authSelect ? (authSelect.value || null) : null;
        const wire_crypt = wirecryptSelect ? (wirecryptSelect.value !== 'false') : true;

        const databases = [];
        if (dbsDiv) {
            dbsDiv.querySelectorAll('.scr-db-row').forEach(dr => {
                const dn = dr.querySelector('[data-field="name"]').value;
                const dp = dr.querySelector('[data-field="path"]').value;
                if (dn && dp) databases.push({ name: dn, path: dp });
            });
        }
        // Preserve existing server ID if it had one
        const existingIdx = parseInt(block.dataset.idx);
        const existing = configState?.servers?.[existingIdx];
        const id = existing?.id || 'srv' + Math.random().toString(36).substr(2, 6);
        servers.push({ id, name, host, port, auth_plugin, wire_crypt, databases });
    });

    const cfg = {
        servers,
        credentials: {
            username: document.getElementById('setUsername').value || 'SYSDBA',
            password: document.getElementById('setPassword').value || configState?.credentials?.password || 'masterkey',
        },
        settings: {
            max_rows: parseInt(document.getElementById('setMaxRows').value) || 1000,
            query_timeout: parseInt(document.getElementById('setQueryTimeout').value) || 30,
            theme: 'dark',
        },
    };

    await api('/api/config', {
        method: 'POST',
        body: JSON.stringify(cfg),
    });
    configState = cfg;
    closeSettings();
    loadServers();
    alert('Settings saved!');
}

function closeSettings() {
    document.getElementById('settingsModal').style.display = 'none';
}

async function testCurrentConnection() {
    if (!state.currentServer || !state.currentDb) {
        alert('Select a database first');
        return;
    }
    const res = await api('/api/test-connection', {
        method: 'POST',
        body: JSON.stringify({
            server_id: state.currentServer,
            db_path: state.currentDb,
        }),
    });
    if (res.ok) {
        const auth = res.auth_accepted || res.auth_requested || 'unknown';
        const crypt = res.wire_crypt ? 'encrypted' : 'plaintext';
        const proto = res.protocol_version ? `protocol v${(res.protocol_version >>> 0).toString(16)}` : '';
        alert(`✅ Connection successful!\n\nAuth: ${auth}\nWire: ${crypt}\n${proto}`);
        const dot = document.getElementById(`status-${state.currentServer}`);
        if (dot) dot.className = 'server-status ok';
    } else {
        alert('❌ ' + res.error);
        const dot = document.getElementById(`status-${state.currentServer}`);
        if (dot) dot.className = 'server-status error';
    }
}

async function diagnoseConnection() {
    if (!state.currentServer || !state.currentDb) {
        alert('Select a database first');
        return;
    }
    // Show a modal with diagnostic results
    const modal = document.getElementById('diagModal');
    const body = document.getElementById('diagBody');
    body.innerHTML = '<p class="muted loading">Running diagnostics…</p>';
    modal.style.display = 'flex';

    try {
        const res = await api('/api/diagnose-connection', {
            method: 'POST',
            body: JSON.stringify({
                server_id: state.currentServer,
                db_path: state.currentDb,
            }),
        });
        renderDiagResults(res);
    } catch (e) {
        body.innerHTML = `<p class="error-msg">${esc(e.message)}</p>`;
    }
}

function renderDiagResults(res) {
    const body = document.getElementById('diagBody');
    let html = '';

    // TCP test
    const tcp = res.tcp || {};
    html += `<div class="diag-section">
        <h3>TCP Connectivity</h3>
        <div class="diag-row ${tcp.ok ? 'ok' : 'error'}">
            <span class="diag-icon">${tcp.ok ? '✅' : '❌'}</span>
            <span>${esc(tcp.host)}:${tcp.port} — ${tcp.ok ? 'Connected' : esc(tcp.error || 'Failed')}</span>
        </div>
    </div>`;

    // Auth attempts
    html += '<div class="diag-section"><h3>Authentication Attempts</h3>';
    (res.auth_attempts || []).forEach(a => {
        const ok = a.ok;
        html += `<div class="diag-row ${ok ? 'ok' : 'error'}">
            <span class="diag-icon">${ok ? '✅' : '❌'}</span>
            <span class="diag-method">${esc(a.plugin)} (wire_crypt=${a.wire_crypt})</span>
            ${ok ? `<span class="diag-detail">Accepted as: ${esc(a.auth_accepted)}, protocol: ${a.protocol_version || '?'}</span>` :
                   `<span class="diag-detail error-text">${esc(a.error)}</span>`}
        </div>`;
    });
    html += '</div>';

    // Summary
    html += `<div class="diag-section"><h3>Summary</h3>
        <p class="${res.auth_attempts?.some(a => a.ok) ? 'ok-text' : 'error-text'}">${esc(res.summary)}</p>
    </div>`;

    body.innerHTML = html;
}

// ── Tab switching ────────────────────────────────────────────────
function switchTab(tab) {
    // The multi tab doesn't have a visible tab button (it's behind Tools menu),
    // so we need to handle it specially
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

    // For multi tab, highlight the Tools button
    if (tab === 'multi') {
        document.querySelector('.tab-tools')?.classList.add('active');
    } else {
        document.querySelector(`.tab[data-tab="${tab}"]`)?.classList.add('active');
    }
    document.getElementById(`tab-${tab}`).classList.add('active');
    if (state.editor) setTimeout(() => state.editor.refresh(), 10);
    if (state.multiEditor) setTimeout(() => state.multiEditor.refresh(), 10);
    if (tab === 'history') loadHistory();
    if (tab === 'scripts') loadScriptsList();
}

// ── Tools dropdown ───────────────────────────────────────────────
function toggleToolsMenu(event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    const dd = document.getElementById('toolsDropdown');
    if (!dd) return;
    const isOpen = dd.style.display === 'block';
    dd.style.display = isOpen ? 'none' : 'block';
}

function closeToolsMenu() {
    const dd = document.getElementById('toolsDropdown');
    if (dd) dd.style.display = 'none';
}

// Close tools menu when clicking elsewhere
document.addEventListener('mousedown', (e) => {
    const dd = document.getElementById('toolsDropdown');
    if (!dd || dd.style.display === 'none') return;
    if (!e.target.closest('.tab-tools') && !e.target.closest('.tools-dropdown')) {
        closeToolsMenu();
    }
});

// ── Restart server ───────────────────────────────────────────────
async function restartServer() {
    if (!confirm('Restart the server? This takes a few seconds — the page will reconnect automatically.')) return;

    // Show overlay
    const overlay = document.createElement('div');
    overlay.id = 'restartOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:9999;display:flex;align-items:center;justify-content:center;color:#5b9eff;font-size:18px;font-family:sans-serif;';
    overlay.innerHTML = '<div style="text-align:center"><div style="font-size:40px;margin-bottom:10px">↻</div>Restarting server…<br><span style="font-size:13px;color:#888" id="restartStatus">Sending restart signal…</span></div>';
    document.body.appendChild(overlay);

    // Send restart request (may fail — that's OK, server is shutting down)
    try {
        await fetch('/api/restart', { method: 'POST' });
    } catch (e) {
        // Expected — connection drops during restart
    }

    // Poll until server comes back
    let attempts = 0;
    const maxAttempts = 30;
    const statusEl = document.getElementById('restartStatus');

    const poll = setInterval(async () => {
        attempts++;
        if (statusEl) statusEl.textContent = `Waiting for server… (attempt ${attempts}/${maxAttempts})`;
        try {
            const res = await fetch('/api/servers', { signal: AbortSignal.timeout(2000) });
            if (res.ok) {
                clearInterval(poll);
                if (statusEl) statusEl.textContent = 'Server is back! Reloading…';
                setTimeout(() => {
                    overlay.remove();
                    location.reload();
                }, 500);
            }
        } catch (e) {
            // Server not back yet, keep polling
        }
        if (attempts >= maxAttempts) {
            clearInterval(poll);
            if (statusEl) statusEl.textContent = 'Server took too long. Close this window and run start.bat again.';
        }
    }, 1000);
}

// ── Utility ──────────────────────────────────────────────────────
function esc(s) {
    if (s === null || s === undefined) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
}
