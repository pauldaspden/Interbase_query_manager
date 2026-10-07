/* ═══════════════════════════════════════════════════════════════
   InterBase Query Manager — Frontend JS
   ═══════════════════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────────────────
let state = {
    servers: [],
    currentServer: null,
    currentDb: null,
    metadata: [],
    isAdmin: false,
    user: null,
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
    loadTheme();
    // Transaction mode — persisted in localStorage (on by default)
    const txMode = localStorage.getItem('txMode') !== 'false';
    state.inTransaction = txMode;
    document.getElementById('txModeToggle').checked = txMode;
    document.getElementById('btnCommit').style.display = txMode ? '' : 'none';
    document.getElementById('btnRollback').style.display = txMode ? '' : 'none';
    loadUserInfo();

    // Ctrl+Enter or F6 to execute
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            const activeTab = document.querySelector('.tab.active').dataset.tab;
            if (activeTab === 'editor') runQuery();
            else if (activeTab === 'multi') runMultiQuery();
        }
        if (e.key === 'F6') {
            e.preventDefault();
            const activeTab = document.querySelector('.tab.active');
            const tab = activeTab ? activeTab.dataset.tab : 'editor';
            // Also handle the Tools/multi tab
            if (tab === 'multi' || (activeTab && activeTab.classList.contains('tab-tools'))) {
                runMultiQuery();
            } else if (tab === 'editor') {
                runQuery();
            }
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

    // Editor resize handle
    initEditorResize();
}

function initEditorResize() {
    const handle = document.getElementById('editorResizeHandle');
    if (!handle) return;
    let startY = 0;
    let startH = 0;

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startY = e.clientY;
        // Get current editor height from the CodeMirror wrapper
        const wrap = state.editor.getWrapperElement();
        startH = wrap.offsetHeight || 240;

        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';

        const onMove = (e) => {
            const delta = e.clientY - startY;
            const newH = Math.max(80, Math.min(startH + delta, window.innerHeight - 200));
            // Use CodeMirror's setSize API — this properly handles internal layout
            state.editor.setSize(null, newH + 'px');
        };

        const onUp = () => {
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

// ── Theme ────────────────────────────────────────────────────────
function loadTheme() {
    const theme = localStorage.getItem('theme') || 'dark';
    applyTheme(theme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('theme', next);
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);

    // Update toggle button text
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = theme === 'dark' ? '🌙 Dark' : '☀ Light';

    // Toggle CodeMirror theme stylesheets
    const darkSheet = document.getElementById('cmDarkTheme');
    const lightSheet = document.getElementById('cmLightTheme');
    if (theme === 'light') {
        if (darkSheet) darkSheet.disabled = true;
        if (lightSheet) lightSheet.disabled = false;
    } else {
        if (darkSheet) darkSheet.disabled = false;
        if (lightSheet) lightSheet.disabled = true;
    }

    // Re-apply CodeMirror theme to editors
    if (state.editor) {
        state.editor.setOption('theme', theme === 'light' ? 'default' : 'material-darker');
    }
    if (state.multiEditor) {
        state.multiEditor.setOption('theme', theme === 'light' ? 'default' : 'material-darker');
    }
}

// ── API helpers ──────────────────────────────────────────────────
async function api(url, opts = {}) {
    const res = await fetch(url, {
        ...opts,
        headers: { 'Content-Type': 'application/json', ...opts.headers },
    });
    // Handle 401 — redirect to login
    if (res.status === 401) {
        window.location.href = '/login';
        return;
    }
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        const text = await res.text();
        const match = text.match(/<title>(.*?)<\/title>/i);
        const errTitle = match ? match[1] : `HTTP ${res.status}`;
        throw new Error(`${errTitle} — server returned HTML instead of JSON.`);
    }
    return res.json();
}

// ── Auth ─────────────────────────────────────────────────────────
async function loadUserInfo() {
    try {
        const res = await fetch('/api/user');
        if (res.ok) {
            const data = await res.json();
            if (data.user) {
                state.user = data.user;
                state.isAdmin = data.user.admin === true;
                const el = document.getElementById('userDisplay');
                if (el) el.textContent = `👤 ${data.user.name || data.user.username}`;
                applyAdminVisibility();
            }
        }
    } catch (e) {}
}

function applyAdminVisibility() {
    const isAdmin = state.isAdmin === true;
    // Admin-only buttons: Settings, Test Connection, Diagnose, Restart Server
    const adminIds = ['btnSettings', 'btnTestConn', 'btnDiagnose', 'btnRestart'];
    // The buttons don't have IDs yet — find them by onclick or text
    const buttons = document.querySelectorAll('.topbar-right .btn-ghost');
    buttons.forEach(btn => {
        const txt = btn.textContent.trim();
        // Non-admins only see: theme toggle + logout
        if (isAdmin) {
            btn.style.display = '';
        } else {
            // Hide everything except theme and logout
            if (!txt.includes('Dark') && !txt.includes('Light') && !txt.includes('Logout')) {
                btn.style.display = 'none';
            }
        }
    });
    // Also hide admin-only tabs (Query Builder, Tools)
    const builderTab = document.querySelector('.tab[data-tab="builder"]');
    const toolsTab = document.querySelector('.tab-tools');
    if (builderTab) builderTab.style.display = isAdmin ? '' : 'none';
    if (toolsTab) toolsTab.style.display = isAdmin ? '' : 'none';
    // Also hide the Transaction mode controls for non-admins
    const txToggle = document.getElementById('txModeToggle');
    if (txToggle) {
        const txLabel = txToggle.closest('.tx-mode-label');
        if (txLabel) txLabel.style.display = isAdmin ? '' : 'none';
    }
    const btnCommit = document.getElementById('btnCommit');
    const btnRollback = document.getElementById('btnRollback');
    if (btnCommit) btnCommit.style.display = isAdmin && state.inTransaction ? '' : 'none';
    if (btnRollback) btnRollback.style.display = isAdmin && state.inTransaction ? '' : 'none';
}

async function logout() {
    window.location.href = '/logout';
}

// ── Servers / Databases ──────────────────────────────────────────
async function loadServers() {
    const servers = await api('/api/servers');
    state.servers = servers;
    // Build a flat list of all databases across all servers, sorted by company_number
    state.allDbs = [];
    for (const srv of servers) {
        for (const db of srv.databases) {
            state.allDbs.push({
                ...db,
                server_id: srv.id,
                server_name: srv.name,
                server_host: srv.host,
            });
        }
    }
    // Sort by company_number (numeric)
    state.allDbs.sort((a, b) => {
        const an = parseInt(a.company_number) || 999999;
        const bn = parseInt(b.company_number) || 999999;
        if (an !== bn) return an - bn;
        // Same company number — sort by name as secondary
        return (a.name || '').localeCompare(b.name || '');
    });
    renderDbList();
    renderMultiTargets(servers);
}

function renderDbList() {
    const list = document.getElementById('dbListFlat');
    if (!list) return;
    list.innerHTML = '';

    state.allDbs.forEach(db => {
        const node = document.createElement('div');
        node.className = 'db-node';
        node.dataset.serverId = db.server_id;
        node.dataset.dbPath = db.path;
        node.dataset.dbName = db.name;
        node.innerHTML = `
            <span class="db-icon">🗄</span>
            <span class="db-label">${esc(db.name)}</span>
            <span class="db-server-tag">${esc(db.server_name.replace('Production Server ', 'Srv ').replace(' (PIDB', ' (').replace(')', ''))}</span>
            <button class="db-delete-btn" title="Delete" data-server-id="${esc(db.server_id)}" data-db-path="${esc(db.path)}" data-db-name="${esc(db.name)}">×</button>
        `;
        list.appendChild(node);
    });

    // Attach click handlers
    list.querySelectorAll('.db-node').forEach(node => {
        node.addEventListener('click', function(e) {
            if (e.target.classList.contains('db-delete-btn')) return;
            selectDb(this.dataset.serverId, this.dataset.dbPath, this.dataset.dbName, this);
        });
    });

    // Attach delete handlers
    list.querySelectorAll('.db-delete-btn').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            deleteDatabase(e, this.dataset.serverId, this.dataset.dbPath, this.dataset.dbName);
        });
    });
}

// ── Database search ──────────────────────────────────────────────
function searchDatabases() {
    const query = document.getElementById('dbSearch').value.trim().toLowerCase();
    const resultsDiv = document.getElementById('dbSearchResults');
    const listDiv = document.getElementById('dbListFlat');

    if (!query) {
        resultsDiv.style.display = 'none';
        resultsDiv.innerHTML = '';
        listDiv.style.display = '';
        return;
    }

    // Search across all databases
    const matches = [];
    for (const db of state.allDbs) {
        const haystack = (db.name + ' ' + (db.company_number || '') + ' ' + db.path).toLowerCase();
        if (haystack.includes(query)) {
            matches.push(db);
        }
    }

    listDiv.style.display = 'none';
    resultsDiv.style.display = 'block';

    if (matches.length === 0) {
        resultsDiv.innerHTML = '<p class="muted" style="padding:12px">No databases found.</p>';
        return;
    }

    // Limit to first 100 matches for performance
    const shown = matches.slice(0, 100);
    resultsDiv.innerHTML = `
        <div class="search-result-count">${matches.length} database${matches.length !== 1 ? 's' : ''} found${matches.length > 100 ? ' (showing first 100)' : ''}</div>
        ${shown.map(db => `
            <div class="search-result-item" data-server-id="${esc(db.server_id)}" data-db-path="${esc(db.path)}" data-db-name="${esc(db.name)}">
                <div class="search-result-name">${highlightMatch(db.name, query)}</div>
                <div class="search-result-server">${esc(db.server_name)}</div>
            </div>
        `).join('')}
    `;

    // Attach click handlers
    resultsDiv.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', function() {
            const sid = this.dataset.serverId;
            const dpath = this.dataset.dbPath;
            const dname = this.dataset.dbName;
            selectDb(sid, dpath, dname, null);
            // Clear search and show list
            document.getElementById('dbSearch').value = '';
            searchDatabases();
        });
    });
}

function highlightMatch(text, query) {
    const idx = text.toLowerCase().indexOf(query);
    if (idx === -1) return esc(text);
    return esc(text.substring(0, idx)) +
           '<mark>' + esc(text.substring(idx, idx + query.length)) + '</mark>' +
           esc(text.substring(idx + query.length));
}

function selectDb(serverId, dbPath, dbName, el) {
    state.currentServer = serverId;
    state.currentDb = dbPath;

    // Update the current database label
    const label = document.getElementById('currentDbLabel');
    if (label) label.textContent = dbName || dbPath;

    // highlight active
    document.querySelectorAll('.db-node').forEach(n => n.classList.remove('active'));
    if (el) {
        el.closest('.db-node')?.classList.add('active');
    }

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
        // API now returns { tables: [...], foreign_keys: [...] }
        state.metadata = meta.tables || meta;
        state.foreignKeys = meta.foreign_keys || [];
        renderMetadata(state.metadata);
        // Notify query builder if it's open
        if (typeof onMetadataLoaded === 'function') onMetadataLoaded();
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
    const sql = `SELECT *\nFROM "${tableName}"\nROWS 1 TO 100;`;
    state.editor.setValue(sql);
    switchTab('editor');
    state.editor.focus();
}

async function previewTable(tableName) {
    state.editor.setValue(`SELECT *\nFROM "${tableName}"\nROWS 1 TO 100;`);
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
    // If text is selected in the editor, run only the selection.
    // Otherwise run the entire editor content.
    let sql = '';
    const selection = state.editor.getSelection();
    if (selection && selection.trim()) {
        sql = selection.trim();
    } else {
        sql = state.editor.getValue().trim();
    }
    if (!sql) { alert('Enter a SQL query first'); return; }
    if (!state.currentServer || !state.currentDb) { alert('Select a server and database'); return; }

    const maxRows = parseInt(document.getElementById('maxRows').value) || 1000;
    const isSelection = selection && selection.trim();
    showLoading(isSelection ? 'Executing selected query…' : 'Executing…');

    try {
        const inTxMode = document.getElementById('txModeToggle').checked;
        const res = await api('/api/query', {
            method: 'POST',
            body: JSON.stringify({
                server_id: state.currentServer,
                db_path: state.currentDb,
                sql: sql,
                max_rows: maxRows,
                in_transaction: inTxMode,
            }),
        });
        if (res.error) {
            showResultError(res.error, res.elapsed);
        } else if (res.rows_affected !== undefined) {
            const txNote = res.in_transaction ? ' <span style="color:var(--warning)">(uncommitted — click Commit to save)</span>' : '';
            showDmlResult(res.rows_affected + txNote, res.elapsed);
        } else {
            renderResults(res, `${res.row_count} rows`);
        }
        loadHistory();
    } catch (e) {
        showResultError(e.message);
    }
}

// ── Transaction mode ─────────────────────────────────────────────
function toggleTxMode() {
    const checked = document.getElementById('txModeToggle').checked;
    document.getElementById('btnCommit').style.display = checked ? '' : 'none';
    document.getElementById('btnRollback').style.display = checked ? '' : 'none';
    state.inTransaction = checked;
    localStorage.setItem('txMode', checked ? 'true' : 'false');
}

async function commitTransaction() {
    if (!state.currentServer || !state.currentDb) return;
    try {
        const res = await api('/api/commit', {
            method: 'POST',
            body: JSON.stringify({
                server_id: state.currentServer,
                db_path: state.currentDb,
            }),
        });
        if (res.ok) {
            alert('✅ Changes committed successfully');
            // Keep transaction mode ON — stay in manual transaction mode
        } else {
            alert('Commit failed: ' + (res.error || 'Unknown error'));
        }
    } catch (e) {
        alert('Commit failed: ' + e.message);
    }
}

async function rollbackTransaction() {
    if (!state.currentServer || !state.currentDb) return;
    if (!confirm('Rollback all uncommitted changes? This cannot be undone.')) return;
    try {
        const res = await api('/api/rollback', {
            method: 'POST',
            body: JSON.stringify({
                server_id: state.currentServer,
                db_path: state.currentDb,
            }),
        });
        if (res.ok) {
            alert('↩ Changes rolled back successfully');
            // Keep transaction mode ON — stay in manual transaction mode
        } else {
            alert('Rollback failed: ' + (res.error || 'Unknown error'));
        }
    } catch (e) {
        alert('Rollback failed: ' + e.message);
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

// ── Results state (database-side pagination) ────────────────────
let resultsState = {
    columns: [],
    page: 0,
    pageSize: 100,
    totalRows: 0,
    totalPages: 0,
    label: '',
    truncated: false,
    elapsed: 0,
    sql: '',       // store the SQL for page requests
    serverId: null,
    dbPath: null,
    colOrder: null,
    timing: null,
};

function renderResults(res, label) {
    resultsState.columns = res.columns;
    resultsState.page = 0;
    resultsState.pageSize = res.page_size || 100;
    resultsState.totalRows = res.row_count;
    resultsState.totalPages = res.total_pages || 1;
    resultsState.label = label;
    resultsState.truncated = res.truncated || false;
    resultsState.elapsed = res.elapsed || 0;
    resultsState.colOrder = null;
    resultsState.timing = res.timing || null;
    // Store SQL for page requests
    const sel = state.editor.getSelection();
    resultsState.sql = (sel && sel.trim()) ? sel.trim() : state.editor.getValue().trim();
    resultsState.serverId = state.currentServer;
    resultsState.dbPath = state.currentDb;
    renderResultsPage(res.rows);
}

function renderResultsPage(pageRows) {
    const panel = document.getElementById('resultsPanel');
    panel.style.display = 'flex';
    const s = resultsState;

    const colOrder = s.colOrder || s.columns.map((_, i) => i);
    const truncated = s.truncated ? ' <span style="color:var(--warning)">(truncated)</span>' : '';
    const pageInfo = s.totalPages > 1
        ? ` <span style="color:var(--text-muted)">· Page ${s.page + 1}/${s.totalPages} (rows ${s.page * s.pageSize + 1}-${Math.min((s.page + 1) * s.pageSize, s.totalRows)} of ${s.totalRows})</span>`
        : '';

    let pagination = '';
    if (s.totalPages > 1) {
        pagination = `
            <div class="results-pagination">
                <button class="btn btn-small" onclick="resultsPage(-1)" ${s.page === 0 ? 'disabled' : ''}>◀ Prev</button>
                <span class="page-info">${s.page + 1} / ${s.totalPages}</span>
                <button class="btn btn-small" onclick="resultsPage(1)" ${s.page >= s.totalPages - 1 ? 'disabled' : ''}>Next ▶</button>
                <span class="page-jump">
                    Jump to page:
                    <input type="number" min="1" max="${s.totalPages}" value="${s.page + 1}"
                           style="width:60px" onchange="resultsJump(this.value)">
                </span>
            </div>
        `;
    }

    const headers = colOrder.map((colIdx, displayIdx) => {
        return `<th draggable="true" data-col-idx="${colIdx}" data-display-idx="${displayIdx}">${esc(s.columns[colIdx])}</th>`;
    }).join('');

    const bodyRows = pageRows.map(row =>
        `<tr>${colOrder.map(colIdx => `<td>${formatCell(row[colIdx])}</td>`).join('')}</tr>`
    ).join('');

    panel.innerHTML = `
        <div class="results-header">
            <span class="results-info">${s.label}${truncated} — ${s.columns.length} columns, ${s.totalRows} rows${pageInfo}</span>
            <span class="results-timer">${s.elapsed}s${s.timing ? ` (page1:${s.timing.page1}s count:${s.timing.count}s)` : ''}</span>
        </div>
        ${pagination}
        <div class="results-table-wrap">
            <table class="results-table">
                <thead><tr>${headers}</tr></thead>
                <tbody>${bodyRows}</tbody>
            </table>
        </div>
    `;

    initColumnDrag();
}

async function resultsPage(dir) {
    const s = resultsState;
    const newPage = Math.max(0, Math.min(s.totalPages - 1, s.page + dir));
    if (newPage === s.page) return;
    await loadResultsPage(newPage);
}

async function resultsJump(pageStr) {
    const s = resultsState;
    const page = Math.max(1, Math.min(s.totalPages, parseInt(pageStr) || 1)) - 1;
    if (page === s.page) return;
    await loadResultsPage(page);
}

async function loadResultsPage(page) {
    const s = resultsState;
    s.page = page;

    // Show loading state
    const tbody = document.querySelector('.results-table tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="99" style="text-align:center;padding:20px;color:var(--text-muted)">Loading page…</td></tr>';

    try {
        const res = await api('/api/query-page', {
            method: 'POST',
            body: JSON.stringify({
                server_id: s.serverId,
                db_path: s.dbPath,
                sql: s.sql,
                page: page,
            }),
        });
        if (res.error) {
            alert(res.error);
            return;
        }
        // If page is empty, we've gone past the last row — go back
        if (!res.rows || res.rows.length === 0) {
            if (page > 0) {
                s.totalPages = page;  // this was the last page
                await loadResultsPage(page - 1);
                return;
            }
        }
        // If this page has fewer than PAGE_SIZE rows, it's the last page
        if (res.rows && res.rows.length < s.pageSize) {
            s.totalPages = page + 1;
        }
        renderResultsPage(res.rows);
    } catch (e) {
        alert('Failed to load page: ' + e.message);
    }
}

function initColumnDrag() {
    const ths = document.querySelectorAll('.results-table th[draggable]');
    let dragSrc = null;
    let didDrag = false;

    ths.forEach(th => {
        th.addEventListener('dragstart', (e) => {
            dragSrc = th;
            didDrag = true;
            th.style.opacity = '0.5';
            e.dataTransfer.effectAllowed = 'move';
            // Set some drag data (required by some browsers)
            e.dataTransfer.setData('text/plain', th.dataset.colIdx);
        });

        th.addEventListener('dragend', (e) => {
            th.style.opacity = '';
            document.querySelectorAll('.results-table th').forEach(t => {
                t.style.borderLeft = '';
            });
            // Reset didDrag after a short delay so click handler can check it
            setTimeout(() => { didDrag = false; }, 50);
        });

        th.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (th !== dragSrc) {
                th.style.borderLeft = '2px solid var(--primary)';
            }
        });

        th.addEventListener('dragleave', (e) => {
            th.style.borderLeft = '';
        });

        th.addEventListener('drop', (e) => {
            e.preventDefault();
            th.style.borderLeft = '';
            if (!dragSrc || th === dragSrc) return;

            // Reorder columns — works for both main results and Query Builder
            const fromIdx = parseInt(dragSrc.dataset.colIdx);
            const toIdx = parseInt(th.dataset.colIdx);

            // If resultsState is available (main editor), reorder via colOrder
            if (resultsState && resultsState.columns) {
                const s = resultsState;
                if (!s.colOrder) {
                    s.colOrder = s.columns.map((_, i) => i);
                }
                const moved = s.colOrder.indexOf(fromIdx);
                const target = s.colOrder.indexOf(toIdx);
                s.colOrder.splice(moved, 1);
                s.colOrder.splice(target, 0, fromIdx);
                renderResultsPage();
            } else {
                // Query Builder or standalone table — reorder DOM directly
                reorderTableColumns(fromIdx, toIdx);
            }
        });

        // Click to sort — but only if no drag happened
        th.addEventListener('click', (e) => {
            if (didDrag) return;  // ignore click after drag
            const colIdx = parseInt(th.dataset.colIdx);
            sortTable(th, colIdx);
        });
    });
}

function reorderTableColumns(fromIdx, toIdx) {
    const table = document.querySelector('.results-table');
    if (!table) return;
    const theadRow = table.querySelector('thead tr');
    const tbody = table.querySelector('tbody');
    if (!theadRow || !tbody) return;

    // Reorder header cells
    const ths = Array.from(theadRow.children);
    if (fromIdx < 0 || fromIdx >= ths.length || toIdx < 0 || toIdx >= ths.length) return;
    const movedTh = ths.splice(fromIdx, 1)[0];
    ths.splice(toIdx, 0, movedTh);
    theadRow.innerHTML = '';
    ths.forEach(th => theadRow.appendChild(th));

    // Reorder body cells in each row
    tbody.querySelectorAll('tr').forEach(tr => {
        const tds = Array.from(tr.children);
        if (fromIdx >= tds.length) return;
        const movedTd = tds.splice(fromIdx, 1)[0];
        tds.splice(Math.min(toIdx, tds.length), 0, movedTd);
        tr.innerHTML = '';
        tds.forEach(td => tr.appendChild(td));
    });

    // Update data-col-idx attributes
    Array.from(theadRow.children).forEach((th, i) => {
        th.dataset.colIdx = i;
    });
}

// Old resultsPage/resultsJump removed — using async server-side versions above


function formatCell(v) {
    if (v === null || v === undefined) return '<span class="null-val">NULL</span>';
    if (typeof v === 'number') return `<span class="num-val">${v}</span>`;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') {
        // Detect ISO date/datetime from Python's isoformat()
        // Pure date: "2026-03-15" (10 chars, no time part)
        // Datetime:  "2026-03-15T14:30:00" or "2026-03-15T14:30:00.123456"
        if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
            // Pure DATE — render as DD-MM-YYYY
            const [y, m, d] = v.split('-');
            return `<span class="date-val">${d}-${m}-${y}</span>`;
        }
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
            // DATETIME/TIMESTAMP — render as DD-MM-YYYY HH:MM:SS (24hr)
            const [datePart, timePart] = v.split('T');
            const [y, m, d] = datePart.split('-');
            const time = timePart.split('.')[0]; // strip microseconds
            return `<span class="date-val">${d}-${m}-${y} ${time}</span>`;
        }
        if (v.length > 200) v = v.substring(0, 200) + '…';
    }
    return esc(String(v));
}

function sortTable(th, colIdx) {
    // Sorting with server-side pagination: sort the current page only
    // (full sort would require re-querying the database with ORDER BY)
    const tbody = document.querySelector('.results-table tbody');
    if (!tbody) return;
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const asc = th.dataset.sort === 'asc';
    th.dataset.sort = asc ? 'desc' : 'asc';
    rows.sort((a, b) => {
        const av = a.cells[colIdx] ? a.cells[colIdx].textContent : '';
        const bv = b.cells[colIdx] ? b.cells[colIdx].textContent : '';
        const an = parseFloat(av), bn = parseFloat(bv);
        if (!isNaN(an) && !isNaN(bn)) return asc ? an - bn : bn - an;
        return asc ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    rows.forEach(r => tbody.appendChild(r));
}

// ── Multi-Server Query ───────────────────────────────────────────
function renderMultiTargets(servers) {
    const div = document.getElementById('multiTargets');
    // Flat list of all databases sorted by company_number
    const allDbs = [];
    for (const srv of servers) {
        for (const db of srv.databases) {
            allDbs.push({
                ...db,
                server_id: srv.id,
                server_name: srv.name.replace('Production Server ', 'Srv ').replace(' (PIDB', ' (').replace(')', ''),
            });
        }
    }
    allDbs.sort((a, b) => {
        const an = parseInt(a.company_number) || 999999;
        const bn = parseInt(b.company_number) || 999999;
        if (an !== bn) return an - bn;
        return (a.name || '').localeCompare(b.name || '');
    });

    div.innerHTML = allDbs.map(db => `
        <div class="mt-db-item">
            <label>
                <input type="checkbox" class="mt-check" data-server="${esc(db.server_id)}" data-db="${esc(db.path)}" checked>
                <span class="mt-db-name">${esc(db.name)}</span>
                <span class="mt-server-tag">${esc(db.server_name)}</span>
            </label>
        </div>
    `).join('');
    updateMultiSelectedCount();
}

function toggleMtServer(header) {
    const list = header.nextElementSibling;
    const toggle = header.querySelector('.mt-toggle');
    if (list.style.display === 'none') {
        list.style.display = 'block';
        toggle.textContent = '▾';
    } else {
        list.style.display = 'none';
        toggle.textContent = '▸';
    }
}

function toggleServerDbs(serverId, checked) {
    document.querySelectorAll(`.mt-check[data-server="${serverId}"]`).forEach(cb => {
        cb.checked = checked;
    });
    updateMultiSelectedCount();
}

function multiSelectAll() {
    document.querySelectorAll('.mt-check').forEach(cb => { cb.checked = true; });
    updateMultiSelectedCount();
}

// Live DB exclusions and rules from DBScanner.ps1
const LIVE_DB_EXCLUSIONS = [1153, 2600, 2601, 2605, 2604, 2603, 2699, 2703, 2799, 4000, 4006, 4007, 4008, 4009];
const GLOBAL_DB_EXCLUSIONS = [3056];

function multiQuickSelect(value) {
    if (!value) return;
    // First deselect all
    document.querySelectorAll('.mt-check').forEach(cb => { cb.checked = false; });

    if (value === 'all') {
        document.querySelectorAll('.mt-check').forEach(cb => { cb.checked = true; });
    } else if (value === 'affinity') {
        // 4-digit numeric filenames, excluding GLOBAL_DB_EXCLUSIONS
        document.querySelectorAll('.mt-check').forEach(cb => {
            const dbName = cb.closest('.mt-db-item')?.querySelector('.mt-db-name')?.textContent || '';
            const baseName = dbName.split(' ')[0];
            const num = parseInt(baseName);
            if (!isNaN(num) && baseName.length === 4 && !GLOBAL_DB_EXCLUSIONS.includes(num)) {
                cb.checked = true;
            }
        });
    } else if (value === 'live') {
        // 4-digit numeric, < 5000, excluding LIVE_DB_EXCLUSIONS and GLOBAL_DB_EXCLUSIONS
        document.querySelectorAll('.mt-check').forEach(cb => {
            const dbName = cb.closest('.mt-db-item')?.querySelector('.mt-db-name')?.textContent || '';
            const baseName = dbName.split(' ')[0];
            const num = parseInt(baseName);
            if (!isNaN(num) && baseName.length === 4 && num < 5000
                && !LIVE_DB_EXCLUSIONS.includes(num) && !GLOBAL_DB_EXCLUSIONS.includes(num)) {
                cb.checked = true;
            }
        });
    } else if (value.startsWith('srv')) {
        // Select all databases on a specific server
        document.querySelectorAll(`.mt-check[data-server="${value}"]`).forEach(cb => { cb.checked = true; });
    }

    updateMultiSelectedCount();
    // Reset dropdown
    document.getElementById('multiQuickSelect').value = '';
}

function multiSelectNone() {
    document.querySelectorAll('.mt-check').forEach(cb => { cb.checked = false; });
    document.querySelectorAll('.mt-server-check').forEach(cb => { cb.checked = false; });
    updateMultiSelectedCount();
}

function updateMultiSelectedCount() {
    const checked = document.querySelectorAll('.mt-check:checked');
    const el = document.getElementById('multiSelectedCount');
    if (el) el.textContent = `${checked.length} database${checked.length !== 1 ? 's' : ''} selected`;
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
            body: JSON.stringify({ targets, sql, max_rows: maxRows, combine: true }),
        });
        if (res.error) {
            resDiv.innerHTML = `<div class="error-msg" style="margin-top:12px">${esc(res.error)}</div>`;
            return;
        }
        // Render combined single result set with _SERVER and _DATABASE columns
        if (res.columns && res.columns.length > 0) {
            resDiv.innerHTML = `
                <div class="results-header">
                    <span class="results-info">
                        ${res.row_count} rows from ${res.targets_run} databases — ${res.columns.length} columns
                        ${res.truncated ? ' <span style="color:var(--warning)">(truncated)</span>' : ''}
                    </span>
                    <span class="results-timer">${res.elapsed}s</span>
                </div>
                ${res.errors && res.errors.length > 0 ? `<div class="error-msg" style="margin:8px 0">${res.errors.map(e => esc(e)).join('<br>')}</div>` : ''}
                <div class="results-table-wrap" style="max-height:400px">
                    <table class="results-table">
                        <thead><tr>${res.columns.map((c, i) => `<th data-col-idx="${i}" draggable="true">${esc(c)}</th>`).join('')}</tr></thead>
                        <tbody>
                            ${res.rows.map(row => `<tr>${row.map(v => `<td>${formatCell(v)}</td>`).join('')}</tr>`).join('')}
                        </tbody>
                    </table>
                </div>
                <button class="btn btn-small" style="margin-top:8px" onclick="exportMultiCsv(${JSON.stringify(res).replace(/"/g, '&quot;')})">⬇ Export CSV</button>
            `;
            initColumnDrag();
        } else if (res.errors && res.errors.length > 0) {
            resDiv.innerHTML = `<div class="error-msg">${res.errors.map(e => esc(e)).join('<br>')}</div>`;
        } else {
            resDiv.innerHTML = '<p class="muted">No results returned.</p>';
        }
    } catch (e) {
        resDiv.innerHTML = `<p class="error-msg">${esc(e.message)}</p>`;
    }
}

function exportMultiCsv(data) {
    // Export combined multi-query results as CSV
    let csv = data.columns.join(',') + '\n';
    for (const row of data.rows) {
        csv += row.map(v => {
            if (v === null || v === undefined) return '';
            const s = String(v);
            if (s.includes(',') || s.includes('"') || s.includes('\n')) {
                return '"' + s.replace(/"/g, '""') + '"';
            }
            return s;
        }).join(',') + '\n';
    }
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    a.download = `multi_query_${ts}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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

    // Show progress overlay
    const overlay = document.createElement('div');
    overlay.id = 'exportOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center;color:#5b9eff;font-size:16px;font-family:sans-serif;';
    overlay.innerHTML = '<div style="text-align:center"><div style="font-size:36px;margin-bottom:10px" class="spin">⬇</div>Exporting CSV…<br><span style="font-size:12px;color:#888">Downloading large result set, please wait</span></div>';
    document.body.appendChild(overlay);

    // Add spinner animation
    if (!document.getElementById('exportSpinStyle')) {
        const style = document.createElement('style');
        style.id = 'exportSpinStyle';
        style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}.spin{display:inline-block;animation:spin 1s linear infinite}';
        document.head.appendChild(style);
    }

    try {
        // Check if text is selected — export only selection if so
        let exportSql = sql;
        const selection = state.editor.getSelection();
        if (selection && selection.trim()) {
            exportSql = selection.trim();
        }

        const maxRows = parseInt(document.getElementById('maxRows').value) || 1000;
        const res = await fetch('/api/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                server_id: state.currentServer,
                db_path: state.currentDb,
                sql: exportSql,
                max_rows: Math.max(maxRows, 100000),  // allow more rows for export
            }),
        });

        // Check if response is JSON error (not CSV)
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            const errData = await res.json();
            throw new Error(errData.error || 'Export failed');
        }
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        // Generate filename with timestamp
        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
        a.download = `query_results_${ts}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (e) {
        alert('Export failed: ' + e.message);
    } finally {
        overlay.remove();
    }
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
        const userTag = h.user ? `<span class="hi-user">${esc(h.user)}</span>` : '';
        return `
            <div class="history-item">
                <span class="hi-time">${esc(h.ts)}</span>
                ${userTag}
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
    api('/api/history').then(history => {
        const h = history.find(x => x.id === id);
        if (!h) return;
        state.editor.setValue(h.sql);
        switchTab('editor');
        // set the server/db
        if (h.server_id) {
            state.currentServer = h.server_id;
            state.currentDb = h.db_path;
            // Update the current database label
            const label = document.getElementById('currentDbLabel');
            if (label) {
                // Find the database name from allDbs
                const db = state.allDbs.find(d => d.server_id === h.server_id && d.path === h.db_path);
                label.textContent = db ? db.name : h.db_path;
            }
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
    if (state.isAdmin) loadAdminUsers();

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

// ── Admin user management ──────────────────────────────────────
async function loadAdminUsers() {
    try {
        const res = await api('/api/admin-users');
        if (res.error) return;
        const listDiv = document.getElementById('adminUsersList');
        const warningDiv = document.getElementById('adminAllWarning');
        if (res.all_admins) {
            warningDiv.style.display = '';
            listDiv.innerHTML = '<p class="muted" style="font-size:12px">All users have admin access (no restriction file yet)</p>';
        } else {
            warningDiv.style.display = 'none';
            const admins = res.admins || [];
            if (admins.length === 0) {
                listDiv.innerHTML = '<p class="muted" style="font-size:12px">No admin users — only you will have access after initializing</p>';
            } else {
                listDiv.innerHTML = admins.map(u => `
                    <div style="display:flex;align-items:center;gap:8px;padding:4px 0">
                        <span style="flex:1">👤 ${esc(u)}</span>
                        <button class="btn btn-small btn-danger" onclick="removeAdminUser('${esc(u)}')">✕ Remove</button>
                    </div>
                `).join('');
            }
        }
    } catch (e) {
        console.error('Failed to load admin users:', e);
    }
}

async function addAdminUser() {
    const input = document.getElementById('newAdminUser');
    const username = input.value.trim();
    if (!username) return;
    try {
        const res = await api('/api/admin-users', {
            method: 'POST',
            body: JSON.stringify({ action: 'add', username }),
        });
        if (res.ok) {
            input.value = '';
            loadAdminUsers();
        } else if (res.error) {
            alert('Error: ' + res.error);
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

async function removeAdminUser(username) {
    if (!confirm(`Remove admin access from ${username}?`)) return;
    try {
        const res = await api('/api/admin-users', {
            method: 'POST',
            body: JSON.stringify({ action: 'remove', username }),
        });
        if (res.ok) {
            loadAdminUsers();
        } else if (res.error) {
            alert('Error: ' + res.error);
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

async function scanDatabases() {
    if (!confirm('Run DBScanner to discover databases via network shares?\nThis will add any new databases found to the config.')) return;
    closeSettings();
    // Show loading
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center;color:#5b9eff;font-size:16px;font-family:sans-serif;';
    overlay.innerHTML = '<div style="text-align:center"><div style="font-size:36px;margin-bottom:10px" class="spin">🔍</div>Scanning network shares for databases…<br><span style="font-size:12px;color:#888">This may take up to 2 minutes</span></div>';
    document.body.appendChild(overlay);
    if (!document.getElementById('exportSpinStyle')) {
        const style = document.createElement('style');
        style.id = 'exportSpinStyle';
        style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}.spin{display:inline-block;animation:spin 1s linear infinite}';
        document.head.appendChild(style);
    }

    try {
        const res = await api('/api/scan-databases', { method: 'POST' });
        overlay.remove();
        if (res.ok) {
            alert(`Scan complete!\n\nFound: ${res.found} databases\nAdded: ${res.added_count} new databases${res.added_count > 0 ? '\n\n' + res.added.join('\n') : ''}`);
            await loadServers();
        } else {
            alert('Scan failed: ' + (res.error || 'Unknown error'));
        }
    } catch (e) {
        overlay.remove();
        alert('Scan failed: ' + e.message);
    }
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
    if (tab === 'builder') qbPopulateTables();
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
// Update multi-select count when checkboxes change
document.addEventListener('change', (e) => {
    if (e.target.classList && e.target.classList.contains('mt-check')) {
        updateMultiSelectedCount();
    }
});

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
    const maxAttempts = 90;
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
            if (statusEl) statusEl.textContent = 'Server took too long. Refresh the page manually.';
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

// ════════════════════════════════════════════════════════════════
// ── Query Builder ───────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════

// Query builder state
let qb = {
    primaryTable: '',
    primaryAlias: 't1',
    joins: [],        // [{ table, alias, joinType, fromColumn, toColumn }]
    selectedColumns: [], // [{ table, column, alias }]
    filters: [],      // [{ column, op, value, connector }]
    aggregates: [],   // [{ fn, column, alias }]
    groupBy: [],      // [{ column }]
    sortColumns: [],  // [{ column, direction }]
    enableAgg: false,
};

let _qbAliasCounter = 1;

function onMetadataLoaded() {
    // Populate table dropdown when metadata is loaded
    qbPopulateTables();
}

function qbPopulateTables() {
    const sel = document.getElementById('qbPrimaryTable');
    if (!sel) return;
    const meta = state.metadata || [];
    sel.innerHTML = '<option value="">— Select a table —</option>' +
        meta.map(t => `<option value="${esc(t.name)}">${esc(t.name)} (${t.type})</option>`).join('');
    // Reset join counter when tables reload
    _qbAliasCounter = 1;
}

function qbGetTableMeta(tableName) {
    const meta = state.metadata || [];
    return meta.find(t => t.name === tableName);
}

function qbGetTableColumns(tableName) {
    const t = qbGetTableMeta(tableName);
    return t ? (t.columns || []) : [];
}

function qbGetAliases() {
    const aliases = [{ table: qb.primaryTable, alias: qb.primaryAlias }];
    qb.joins.forEach(j => aliases.push({ table: j.table, alias: j.alias }));
    return aliases;
}

function qbNextAlias() {
    _qbAliasCounter++;
    return 't' + _qbAliasCounter;
}

function qbPrimaryTableChanged() {
    const sel = document.getElementById('qbPrimaryTable');
    qb.primaryTable = sel.value;
    _qbAliasCounter = 1;
    qb.primaryAlias = 't1';
    document.getElementById('qbPrimaryAlias').value = 't1';
    qb.joins = [];
    qb.selectedColumns = [];
    qb.filters = [];
    qb.aggregates = [];
    qb.groupBy = [];
    qb.sortColumns = [];

    if (qb.primaryTable) {
        document.getElementById('qbColumnsSection').style.display = '';
        document.getElementById('qbFiltersSection').style.display = '';
        document.getElementById('qbAggSection').style.display = '';
        document.getElementById('qbSortSection').style.display = '';
        document.getElementById('qbAddJoinBtn').style.display = '';
        qbRenderColumns();
        qbRenderJoinList();
    } else {
        document.getElementById('qbColumnsSection').style.display = 'none';
        document.getElementById('qbFiltersSection').style.display = 'none';
        document.getElementById('qbAggSection').style.display = 'none';
        document.getElementById('qbSortSection').style.display = 'none';
        document.getElementById('qbAddJoinBtn').style.display = 'none';
        document.getElementById('qbJoinList').innerHTML = '';
    }
    qbUpdatePreview();
}

function qbRenderJoinList() {
    const container = document.getElementById('qbJoinList');
    container.innerHTML = qb.joins.map((j, i) => {
        return `<div class="qb-join-row">
            <span class="qb-join-type">${esc(j.joinType)}</span>
            <select onchange="qbJoinTableChanged(${i}, this.value)">
                <option value="">— table —</option>
                ${(state.metadata || []).map(t => `<option value="${esc(t.name)}" ${t.name === j.table ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
            </select>
            <span>ON</span>
            <select class="qb-join-col" onchange="qbJoinFromChanged(${i}, this.value)">
                <option value="">— column —</option>
                ${qbGetTableColumns(qb.primaryTable).map(c => `<option value="${esc(c.name)}" ${c.name === j.fromColumn ? 'selected' : ''}>${esc(qb.primaryAlias)}.${esc(c.name)}</option>`).join('')}
            </select>
            <span>=</span>
            <select class="qb-join-col" onchange="qbJoinToChanged(${i}, this.value)">
                <option value="">— column —</option>
                ${j.table ? qbGetTableColumns(j.table).map(c => `<option value="${esc(c.name)}" ${c.name === j.toColumn ? 'selected' : ''}>${esc(j.alias)}.${esc(c.name)}</option>`).join('') : ''}
            </select>
            <input type="text" class="qb-alias-input" value="${esc(j.alias)}" title="Alias" readonly>
            <button class="qb-join-remove" onclick="qbRemoveJoin(${i})">✕ Remove</button>
            ${qbGetJoinSuggestion(i, j)}
        </div>`;
    }).join('');
}

function qbGetJoinSuggestion(i, join) {
    if (!state.foreignKeys || state.foreignKeys.length === 0) return '';
    // Find FKs that match this join
    const suggestions = state.foreignKeys.filter(fk =>
        (fk.from_table === qb.primaryTable && fk.to_table === join.table) ||
        (fk.from_table === join.table && fk.to_table === qb.primaryTable)
    );
    if (suggestions.length === 0) return '';
    return `<div class="qb-join-suggestion">💡 Suggested: ${suggestions.map(s =>
        `${esc(s.from_table)}.${esc(s.from_column)} → ${esc(s.to_table)} (FK)`
    ).join(', ')}</div>`;
}

function qbAddJoin() {
    if (!qb.primaryTable) return;
    const alias = qbNextAlias();
    qb.joins.push({
        table: '',
        alias: alias,
        joinType: 'INNER JOIN',
        fromColumn: '',
        toColumn: '',
    });
    qbRenderJoinList();
    qbUpdatePreview();
}

function qbRemoveJoin(i) {
    qb.joins.splice(i, 1);
    qbRenderJoinList();
    qbUpdatePreview();
}

function qbJoinTableChanged(i, val) {
    qb.joins[i].table = val;
    qb.joins[i].toColumn = '';
    qbRenderJoinList();
    qbRenderColumns();
    qbUpdatePreview();
}

function qbJoinFromChanged(i, val) {
    qb.joins[i].fromColumn = val;
    qbUpdatePreview();
}

function qbJoinToChanged(i, val) {
    qb.joins[i].toColumn = val;
    qbUpdatePreview();
}

function qbRenderColumns() {
    const container = document.getElementById('qbColumnsList');
    if (!container) return;
    let html = '';

    // Columns from primary table
    const primaryCols = qbGetTableColumns(qb.primaryTable);
    if (primaryCols.length > 0) {
        html += `<div style="margin-bottom:8px;font-size:12px;color:var(--text-dim)">${esc(qb.primaryAlias)} — ${esc(qb.primaryTable)}</div>`;
        html += '<div class="qb-columns-grid">';
        primaryCols.forEach(col => {
            const checked = qbIsColumnSelected(qb.primaryTable, col.name);
            html += `<label class="qb-col-checkbox">
                <input type="checkbox" ${checked ? 'checked' : ''} onchange="qbToggleColumn('${esc(qb.primaryTable)}','${esc(col.name)}', this.checked)">
                <span>${esc(col.name)}</span>
                <span class="qb-col-type">${esc(col.type)}</span>
            </label>`;
        });
        html += '</div>';
    }

    // Columns from joined tables
    qb.joins.forEach((j, idx) => {
        if (!j.table) return;
        const cols = qbGetTableColumns(j.table);
        if (cols.length === 0) return;
        html += `<div style="margin:8px 0 4px;font-size:12px;color:var(--text-dim)">${esc(j.alias)} — ${esc(j.table)}</div>`;
        html += '<div class="qb-columns-grid">';
        cols.forEach(col => {
            const checked = qbIsColumnSelected(j.table, col.name);
            html += `<label class="qb-col-checkbox">
                <input type="checkbox" ${checked ? 'checked' : ''} onchange="qbToggleColumn('${esc(j.table)}','${esc(col.name)}', this.checked)">
                <span>${esc(col.name)}</span>
                <span class="qb-col-type">${esc(col.type)}</span>
            </label>`;
        });
        html += '</div>';
    });

    container.innerHTML = html || '<span class="muted">No columns available</span>';
}

function qbIsColumnSelected(table, col) {
    return qb.selectedColumns.some(c => c.table === table && c.column === col);
}

function qbToggleColumn(table, col, checked) {
    if (checked) {
        if (!qbIsColumnSelected(table, col)) {
            qb.selectedColumns.push({ table, column: col, alias: '' });
        }
    } else {
        qb.selectedColumns = qb.selectedColumns.filter(c => !(c.table === table && c.column === col));
    }
    qbUpdatePreview();
}

function qbToggleSelectAll() {
    const checked = document.getElementById('qbSelectAll').checked;
    qb.selectedColumns = [];
    if (checked) {
        // Select all from primary table
        qbGetTableColumns(qb.primaryTable).forEach(col => {
            qb.selectedColumns.push({ table: qb.primaryTable, column: col.name, alias: '' });
        });
        // Select all from joined tables
        qb.joins.forEach(j => {
            if (j.table) {
                qbGetTableColumns(j.table).forEach(col => {
                    qb.selectedColumns.push({ table: j.table, column: col.name, alias: '' });
                });
            }
        });
    }
    qbRenderColumns();
    qbUpdatePreview();
}

function qbAddFilter() {
    qb.filters.push({ column: '', op: '=', value: '', connector: 'AND' });
    qbRenderFilters();
    qbUpdatePreview();
}

function qbRemoveFilter(i) {
    qb.filters.splice(i, 1);
    qbRenderFilters();
    qbUpdatePreview();
}

function qbRenderFilters() {
    const container = document.getElementById('qbFilterList');
    if (!container) return;
    if (qb.filters.length === 0) {
        container.innerHTML = '<span class="muted">No filters — click "Add Filter" to narrow results</span>';
        return;
    }
    // Build column options from all available tables
    const colOptions = qbGetAliasColumnOptions();

    container.innerHTML = qb.filters.map((f, i) => {
        return `<div class="qb-filter-row">
            ${i > 0 ? `<select class="qb-filter-andor" onchange="qbFilterConnectorChanged(${i}, this.value)">
                <option value="AND" ${f.connector === 'AND' ? 'selected' : ''}>AND</option>
                <option value="OR" ${f.connector === 'OR' ? 'selected' : ''}>OR</option>
            </select>` : ''}
            <select class="qb-filter-col" onchange="qbFilterColChanged(${i}, this.value)">
                <option value="">— column —</option>
                ${colOptions.map(c => `<option value="${esc(c.value)}" ${f.column === c.value ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
            </select>
            <select class="qb-filter-op" onchange="qbFilterOpChanged(${i}, this.value)">
                ${['=', '!=', '<', '>', '<=', '>=', 'LIKE', 'NOT LIKE', 'IS NULL', 'IS NOT NULL', 'IN'].map(op =>
                    `<option value="${op}" ${f.op === op ? 'selected' : ''}>${op}</option>`
                ).join('')}
            </select>
            ${f.op !== 'IS NULL' && f.op !== 'IS NOT NULL' ?
                `<input type="text" class="qb-filter-val" placeholder="value" value="${esc(f.value)}" oninput="qbFilterValChanged(${i}, this.value)">` :
                ''}
            <button class="qb-filter-remove" onclick="qbRemoveFilter(${i})">✕</button>
        </div>`;
    }).join('');
}

function qbFilterColChanged(i, val) { qb.filters[i].column = val; qbUpdatePreview(); }
function qbFilterOpChanged(i, val) { qb.filters[i].op = val; qbRenderFilters(); qbUpdatePreview(); }
function qbFilterValChanged(i, val) { qb.filters[i].value = val; qbUpdatePreview(); }
function qbFilterConnectorChanged(i, val) { qb.filters[i].connector = val; qbUpdatePreview(); }

function qbGetAliasColumnOptions() {
    const opts = [];
    // Primary table columns
    if (qb.primaryTable) {
        qbGetTableColumns(qb.primaryTable).forEach(col => {
            opts.push({ value: `${qb.primaryAlias}.${col.name}`, label: `${qb.primaryAlias}.${col.name} (${qb.primaryTable})` });
        });
    }
    // Joined table columns
    qb.joins.forEach(j => {
        if (!j.table) return;
        qbGetTableColumns(j.table).forEach(col => {
            opts.push({ value: `${j.alias}.${col.name}`, label: `${j.alias}.${col.name} (${j.table})` });
        });
    });
    return opts;
}

function qbGetColumnForAlias(alias) {
    const aliases = qbGetAliases();
    const match = aliases.find(a => `${a.alias}` === alias);
    return match;
}

function qbToggleAgg() {
    qb.enableAgg = document.getElementById('qbEnableAgg').checked;
    if (qb.enableAgg) {
        qbRenderAggregates();
        qbRenderGroupBy();
    } else {
        document.getElementById('qbAggList').innerHTML = '';
        document.getElementById('qbGroupByList').innerHTML = '';
    }
    qbUpdatePreview();
}

function qbAddAggregate() {
    qb.aggregates.push({ fn: 'COUNT', column: '*', alias: 'cnt' });
    qbRenderAggregates();
    qbUpdatePreview();
}

function qbRemoveAggregate(i) {
    qb.aggregates.splice(i, 1);
    qbRenderAggregates();
    qbUpdatePreview();
}

function qbRenderAggregates() {
    const container = document.getElementById('qbAggList');
    if (!container) return;
    if (qb.aggregates.length === 0 && qb.enableAgg) {
        container.innerHTML = '<span class="muted">No aggregates — click below to add COUNT, SUM, AVG, etc.</span>';
        container.innerHTML += '<div style="margin-top:8px"><button class="btn btn-small btn-secondary" onclick="qbAddAggregate()">+ Add Aggregate</button></div>';
        return;
    }
    const colOptions = qbGetAliasColumnOptions();
    container.innerHTML = qb.aggregates.map((a, i) => {
        return `<div class="qb-agg-row">
            <select class="qb-agg-fn" onchange="qbAggFnChanged(${i}, this.value)">
                ${['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'].map(fn =>
                    `<option value="${fn}" ${a.fn === fn ? 'selected' : ''}>${fn}</option>`
                ).join('')}
            </select>
            <span>(</span>
            <select class="qb-agg-col" onchange="qbAggColChanged(${i}, this.value)">
                <option value="*" ${a.column === '*' ? 'selected' : ''}>* (all)</option>
                ${colOptions.map(c => `<option value="${esc(c.value)}" ${a.column === c.value ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
            </select>
            <span>) AS</span>
            <input type="text" class="qb-agg-alias" value="${esc(a.alias)}" oninput="qbAggAliasChanged(${i}, this.value)">
            <button class="qb-agg-remove" onclick="qbRemoveAggregate(${i})">✕</button>
        </div>`;
    }).join('') + (qb.enableAgg ? '<div style="margin-top:8px"><button class="btn btn-small btn-secondary" onclick="qbAddAggregate()">+ Add Aggregate</button></div>' : '');
}

function qbAggFnChanged(i, val) { qb.aggregates[i].fn = val; qbUpdatePreview(); }
function qbAggColChanged(i, val) { qb.aggregates[i].column = val; qbUpdatePreview(); }
function qbAggAliasChanged(i, val) { qb.aggregates[i].alias = val; qbUpdatePreview(); }

function qbRenderGroupBy() {
    const container = document.getElementById('qbGroupByList');
    if (!container) return;
    if (!qb.enableAgg) { container.innerHTML = ''; return; }
    const colOptions = qbGetAliasColumnOptions();
    if (qb.groupBy.length === 0) {
        container.innerHTML = '<span class="muted">GROUP BY columns (optional — auto-selected from non-aggregate columns)</span>';
    } else {
        container.innerHTML = '<div class="qb-section-title" style="margin-top:12px">Group By</div>' +
            qb.groupBy.map((g, i) => `<div class="qb-agg-row">
                <select class="qb-agg-col" onchange="qbGroupByColChanged(${i}, this.value)">
                    <option value="">— column —</option>
                    ${colOptions.map(c => `<option value="${esc(c.value)}" ${g.column === c.value ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
                </select>
                <button class="qb-agg-remove" onclick="qbRemoveGroupBy(${i})">✕</button>
            </div>`).join('');
    }
}

function qbAddGroupBy() {
    qb.groupBy.push({ column: '' });
    qbRenderGroupBy();
    qbUpdatePreview();
}

function qbRemoveGroupBy(i) {
    qb.groupBy.splice(i, 1);
    qbRenderGroupBy();
    qbUpdatePreview();
}

function qbGroupByColChanged(i, val) { qb.groupBy[i].column = val; qbUpdatePreview(); }

function qbAddSort() {
    qb.sortColumns.push({ column: '', direction: 'ASC' });
    qbRenderSort();
    qbUpdatePreview();
}

function qbRemoveSort(i) {
    qb.sortColumns.splice(i, 1);
    qbRenderSort();
    qbUpdatePreview();
}

function qbRenderSort() {
    const container = document.getElementById('qbSortList');
    if (!container) return;
    if (qb.sortColumns.length === 0) {
        container.innerHTML = '<span class="muted">No sort — click "Add Sort Column" to order results</span>';
        return;
    }
    const colOptions = qbGetAliasColumnOptions();
    container.innerHTML = qb.sortColumns.map((s, i) => {
        return `<div class="qb-sort-row">
            <select onchange="qbSortColChanged(${i}, this.value)">
                <option value="">— column —</option>
                ${colOptions.map(c => `<option value="${esc(c.value)}" ${s.column === c.value ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
            </select>
            <select onchange="qbSortDirChanged(${i}, this.value)">
                <option value="ASC" ${s.direction === 'ASC' ? 'selected' : ''}>ASC (ascending)</option>
                <option value="DESC" ${s.direction === 'DESC' ? 'selected' : ''}>DESC (descending)</option>
            </select>
            <button class="qb-sort-remove" onclick="qbRemoveSort(${i})">✕</button>
        </div>`;
    }).join('');
}

function qbSortColChanged(i, val) { qb.sortColumns[i].column = val; qbUpdatePreview(); }
function qbSortDirChanged(i, val) { qb.sortColumns[i].direction = val; qbUpdatePreview(); }

// ── SQL Generation ──────────────────────────────────────────────

function qbGenerateSQL() {
    if (!qb.primaryTable) return '';

    let sql = 'SELECT\n';

    // SELECT columns
    if (qb.enableAgg && qb.aggregates.length > 0) {
        // Aggregate mode: selected non-aggregate columns + aggregate columns
        const nonAggCols = [];
        const aggCols = qb.aggregates.map(a => {
            const col = a.column === '*' ? '*' : a.column;
            return `  ${a.fn}(${col}) AS ${a.alias}`;
        });
        // If groupBy is specified, use those; otherwise auto-select non-agg columns
        const groupCols = qb.groupBy.filter(g => g.column).map(g => g.column);
        if (groupCols.length > 0) {
            groupCols.forEach(c => nonAggCols.push(`  ${c}`));
        } else if (qb.selectedColumns.length > 0) {
            qb.selectedColumns.forEach(c => {
                const alias = qbGetAliasForTable(c.table);
                if (alias) nonAggCols.push(`  ${alias}.${c.column}`);
            });
        }
        sql += nonAggCols.concat(aggCols).join(',\n');
    } else if (qb.selectedColumns.length > 0) {
        const cols = qb.selectedColumns.map(c => {
            const alias = qbGetAliasForTable(c.table);
            return `  ${alias}.${c.column}`;
        });
        sql += cols.join(',\n');
    } else {
        sql += '  *';
    }

    // FROM
    sql += `\nFROM ${qb.primaryTable} ${qb.primaryAlias}`;

    // JOINs
    qb.joins.forEach(j => {
        if (j.table && j.fromColumn && j.toColumn) {
            sql += `\n${j.joinType} ${j.table} ${j.alias} ON ${qb.primaryAlias}.${j.fromColumn} = ${j.alias}.${j.toColumn}`;
        } else if (j.table) {
            sql += `\n${j.joinType} ${j.table} ${j.alias} ON -- TODO: select join columns`;
        }
    });

    // WHERE
    const validFilters = qb.filters.filter(f => f.column && f.op);
    if (validFilters.length > 0) {
        sql += '\nWHERE ';
        sql += validFilters.map((f, i) => {
            let clause = '';
            if (i > 0) clause += f.connector + ' ';
            if (f.op === 'IS NULL' || f.op === 'IS NOT NULL') {
                clause += `${f.column} ${f.op}`;
            } else if (f.op === 'IN') {
                clause += `${f.column} IN (${f.value})`;
            } else if (f.op === 'LIKE' || f.op === 'NOT LIKE') {
                clause += `${f.column} ${f.op} '${f.value.replace(/'/g, "''")}'`;
            } else {
                // Try to detect if value is numeric
                const val = f.value.replace(/'/g, "''");
                if (val.match(/^-?\d+\.?\d*$/)) {
                    clause += `${f.column} ${f.op} ${val}`;
                } else {
                    clause += `${f.column} ${f.op} '${val}'`;
                }
            }
            return clause;
        }).join(' ');
    }

    // GROUP BY
    if (qb.enableAgg) {
        const groupCols = qb.groupBy.filter(g => g.column);
        if (groupCols.length > 0) {
            sql += '\nGROUP BY ' + groupCols.map(g => g.column).join(', ');
        }
    }

    // ORDER BY
    const validSort = qb.sortColumns.filter(s => s.column);
    if (validSort.length > 0) {
        sql += '\nORDER BY ' + validSort.map(s => `${s.column} ${s.direction}`).join(', ');
    }

    return sql;
}

function qbGetAliasForTable(table) {
    if (table === qb.primaryTable) return qb.primaryAlias;
    const join = qb.joins.find(j => j.table === table);
    return join ? join.alias : null;
}

function qbUpdatePreview() {
    const preview = document.getElementById('qbSqlPreview');
    if (!preview) return;
    const sql = qbGenerateSQL();
    if (sql) {
        preview.textContent = sql;
        preview.style.color = 'var(--text)';
    } else {
        preview.textContent = 'Select a table to begin…';
        preview.style.color = 'var(--text-muted)';
    }

    // Update render of filters and sort
    if (document.getElementById('qbFilterList')) qbRenderFilters();
    if (document.getElementById('qbSortList')) qbRenderSort();
    if (qb.enableAgg) {
        qbRenderAggregates();
        qbRenderGroupBy();
    }
}

function qbCopyToEditor() {
    const sql = qbGenerateSQL();
    if (!sql) return;
    if (state.editor) {
        state.editor.setValue(sql);
    }
    switchTab('editor');
}

async function qbRun() {
    const sql = qbGenerateSQL();
    if (!sql) {
        alert('Select a table first');
        return;
    }
    if (!state.currentServer || !state.currentDb) {
        alert('Select a database in the sidebar first');
        return;
    }
    const resultsDiv = document.getElementById('qbResults');
    resultsDiv.style.display = '';
    resultsDiv.innerHTML = '<p class="muted loading">Running query…</p>';

    const maxRows = 1000;

    try {
        const res = await api('/api/query', {
            method: 'POST',
            body: JSON.stringify({
                server_id: state.currentServer,
                db_path: state.currentDb,
                sql: sql,
                max_rows: parseInt(maxRows),
                in_transaction: true,
            }),
        });
        if (res.error) {
            resultsDiv.innerHTML = `<div class="error-msg">${esc(res.error)}</div>`;
        } else if (res.columns) {
            renderQbResults(res, resultsDiv);
            loadHistory();
        } else if (res.rows_affected !== undefined) {
            resultsDiv.innerHTML = `<p>${res.rows_affected} rows affected</p>`;
            loadHistory();
        }
    } catch (e) {
        resultsDiv.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
}

function renderQbResults(res, container) {
    const cols = res.columns || [];
    const rows = res.rows || [];
    if (rows.length === 0) {
        container.innerHTML = '<p class="muted">No rows returned</p>';
        return;
    }
    let html = `<div style="margin:8px 0;font-size:12px;color:var(--text-dim)">${rows.length} rows · ${res.elapsed || 0}s</div>`;
    html += '<div class="results-table-wrap"><table class="results-table"><thead><tr>';
    cols.forEach((c, i) => html += `<th draggable="true" data-col-idx="${i}">${esc(c)}</th>`);
    html += '</tr></thead><tbody>';
    rows.forEach(row => {
        html += '<tr>';
        cols.forEach((c, ci) => {
            const v = row[ci];
            html += `<td>${v === null ? '<span class="null-val">NULL</span>' : esc(String(v))}</td>`;
        });
        html += '</tr>';
    });
    html += '</tbody></table></div>';
    container.innerHTML = html;
    // Enable column drag-and-drop reordering
    initColumnDrag();
}
