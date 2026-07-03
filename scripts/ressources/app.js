'use strict';

// ============================================================
//  État
// ============================================================
const state = {
    sourceItems:    [],
    targetItems:    [],
    selectedSource: new Set(),
    selectedTarget: new Set(),
    dragging:       null,
    draggingFrom:   null
};

// ============================================================
//  Init
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    if (window !== window.top) {
        document.querySelector('header').style.display = 'none';
    }
    loadOutputList();
    document.getElementById('csv-refresh').addEventListener('click', loadOutputList);
    document.getElementById('csv-file-search').addEventListener('input', renderFileList);
    document.getElementById('csv-gen-all').addEventListener('click', generateAllCsv);
    setupResizer();
});

// Redimensionnement de la zone de gauche par glisser (setPointerCapture → drag fiable même en iframe)
function setupResizer() {
    const resizer = document.getElementById('csv-resizer');
    const pane    = document.getElementById('csv-tree-pane');
    if (!resizer || !pane) return;
    try { const w = localStorage.getItem('csv_pane_width'); if (w) pane.style.width = w; } catch { /* ignore */ }
    let startX = 0, startW = 0;
    resizer.addEventListener('pointerdown', e => {
        startX = e.clientX;
        startW = pane.getBoundingClientRect().width;
        resizer.classList.add('active');
        resizer.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    resizer.addEventListener('pointermove', e => {
        if (!resizer.hasPointerCapture(e.pointerId)) return;
        let w = startW + (e.clientX - startX);
        w = Math.max(180, Math.min(w, window.innerWidth - 220));
        pane.style.width = w + 'px';
    });
    resizer.addEventListener('pointerup', e => {
        resizer.classList.remove('active');
        try { resizer.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        try { localStorage.setItem('csv_pane_width', pane.style.width); } catch { /* ignore */ }
    });
}

// ── Génération de TOUS les CSV (dossier horodaté, un sous-dossier par groupe) ──
function csvOverlay(on, title)  { try { window.top.postMessage({ type: 'groupes-generating', on: !!on, title }, '*'); } catch { /* hors iframe */ } }
function csvProgress(done, total, label) { try { window.top.postMessage({ type: 'groupes-progress', done, total, label }, '*'); } catch { /* ignore */ } }

async function generateAllCsv() {
    if (!confirm('Générer TOUS les fichiers CSV de tous les groupes ?\n\nUn dossier horodaté sera créé, avec un sous-dossier par groupe (CSV niveaux 1/2/3).\nL’application sera bloquée le temps de la génération.')) return;

    let rules;
    try { rules = await fetchJSON('/api/regles'); } catch { showToast('Erreur : chargement des règles', 'error'); return; }
    if (!Array.isArray(rules) || !rules.length) { showToast('Aucune règle définie', 'error'); return; }
    const total = rules.length;

    csvOverlay(true, 'Génération des fichiers CSV…');
    csvProgress(0, total, '');
    await new Promise(r => setTimeout(r, 60));   // laisse le bandeau s'afficher

    let dir = '';
    try {
        const r = await fetch('/api/csv/generate-all/init', { method: 'POST' });
        const j = await r.json();
        if (!j.ok || !j.dir) throw new Error(j.error || 'init');
        dir = j.dir;
    } catch { csvOverlay(false); showToast('Erreur lors de la création du dossier', 'error'); return; }

    try {
        const queue = rules.slice();
        let done = 0;
        const CONC = 2;
        async function worker() {
            while (queue.length) {
                const rule = queue.shift();
                csvProgress(done, total, rule.label);           // groupe en cours
                try {
                    await fetch('/api/csv/generate-all/rule', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ dir, ruleId: rule.id }),
                    });
                } catch { /* on continue même si une règle échoue */ }
                done++;
                csvProgress(done, total, rule.label);
            }
        }
        await Promise.all(Array.from({ length: CONC }, worker));
    } finally {
        csvOverlay(false);
    }
    showToast('Tous les CSV ont été générés', 'success');
    loadOutputList();
}

async function loadGroups() {
    try {
        const groups = await fetchJSON('/api/groups');
        populateGroupSelect('source-group-select', groups);
        populateGroupSelect('target-group-select', groups);

        document.getElementById('source-group-select')
            .addEventListener('change', onSourceGroupChange);
        document.getElementById('target-group-select')
            .addEventListener('change', onTargetGroupChange);

        updateStatus('connected');
    } catch (e) {
        updateStatus('error');
        showToast('Erreur chargement groupes : ' + e.message, 'error');
    }
}

function populateGroupSelect(selectId, groups) {
    const select = document.getElementById(selectId);
    while (select.options.length > 1) select.remove(1);
    for (const g of groups) {
        const opt = new Option(g.displayName || g.name, g.dn);
        opt.title = g.dn;
        select.appendChild(opt);
    }
}

// ============================================================
//  Recherche (debounce 300 ms)
// ============================================================
function setupSearch() {
    let timer;
    document.getElementById('search-input').addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(doSearch, 300);
    });
    document.getElementById('search-type').addEventListener('change', doSearch);
}

async function doSearch() {
    const q    = document.getElementById('search-input').value.trim();
    const type = document.getElementById('search-type').value;

    if (!q) {
        state.sourceItems = [];
        renderList('source-list', state.sourceItems, 'source');
        return;
    }

    try {
        const data = await fetchJSON(`/api/search?q=${encodeURIComponent(q)}&type=${type}`);
        const targetDNs = new Set(state.targetItems.map(i => i.dn));
        state.sourceItems = data.filter(i => !targetDNs.has(i.dn));
        renderList('source-list', state.sourceItems, 'source');
    } catch (e) {
        showToast('Erreur recherche : ' + e.message, 'error');
    }
}

async function onSourceGroupChange() {
    const dn = document.getElementById('source-group-select').value;
    if (!dn) {
        state.sourceItems = [];
        renderList('source-list', state.sourceItems, 'source');
        return;
    }

    try {
        const members   = await fetchJSON(`/api/group/members?dn=${encodeURIComponent(dn)}`);
        const targetDNs = new Set(state.targetItems.map(i => i.dn));
        state.sourceItems = members.filter(m => !targetDNs.has(m.dn));
        renderList('source-list', state.sourceItems, 'source');
    } catch (e) {
        showToast('Erreur chargement membres : ' + e.message, 'error');
    }
}

async function onTargetGroupChange() {
    const dn = document.getElementById('target-group-select').value;
    if (!dn) return;

    try {
        const members = await fetchJSON(`/api/group/members?dn=${encodeURIComponent(dn)}`);
        state.targetItems = members;
        state.selectedTarget.clear();
        renderList('target-list', state.targetItems, 'target');
        updateMemberCount();
        showToast(`${members.length} membre(s) chargé(s)`, 'info');
    } catch (e) {
        showToast('Erreur chargement membres : ' + e.message, 'error');
    }
}

// ============================================================
//  Rendu
// ============================================================
function renderList(containerId, items, panel) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';

    if (!items || items.length === 0) {
        container.innerHTML = `<p class="hint">${
            panel === 'source' ? 'Rechercher ou sélectionner un groupe' : 'Glisser des membres ici ou utiliser ▶'
        }</p>`;
        return;
    }

    const frag = document.createDocumentFragment();
    for (const item of items) {
        frag.appendChild(createItemElement(item, panel));
    }
    container.appendChild(frag);
}

function createItemElement(item, panel) {
    const el = document.createElement('div');
    el.className  = 'list-item';
    el.dataset.dn = item.dn;
    el.draggable  = true;

    const selected = panel === 'source' ? state.selectedSource : state.selectedTarget;
    if (selected.has(item.dn)) el.classList.add('selected');

    const icon = item.type === 'group' ? '👥' : '👤';
    const sub  = [item.department, item.title].filter(Boolean).join(' · ');

    el.innerHTML = `
        <span class="item-icon">${icon}</span>
        <div class="item-info">
            <div class="item-name">${esc(item.displayName || item.samAccountName)}</div>
            ${sub ? `<div class="item-sub">${esc(sub)}</div>` : ''}
        </div>`;

    el.addEventListener('click',     e => toggleSelection(item.dn, panel, el, e));
    el.addEventListener('dragstart', e => onDragStart(e, item, panel));
    el.addEventListener('dragend',   ()  => onDragEnd());

    return el;
}

function toggleSelection(dn, panel, el, e) {
    const selected  = panel === 'source' ? state.selectedSource : state.selectedTarget;
    const listId    = panel === 'source' ? 'source-list' : 'target-list';

    if (!e.ctrlKey && !e.metaKey) {
        selected.clear();
        document.querySelectorAll(`#${listId} .list-item`).forEach(i => i.classList.remove('selected'));
    }

    if (selected.has(dn)) {
        selected.delete(dn);
        el.classList.remove('selected');
    } else {
        selected.add(dn);
        el.classList.add('selected');
    }
}

// ============================================================
//  Drag & Drop
// ============================================================
function onDragStart(e, item, panel) {
    state.dragging     = item;
    state.draggingFrom = panel;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.dn);
    e.currentTarget.classList.add('dragging');
}

function onDragEnd() {
    document.querySelectorAll('.dragging').forEach(el  => el.classList.remove('dragging'));
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    state.dragging     = null;
    state.draggingFrom = null;
}

function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('drag-over');
}

function handleDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) {
        e.currentTarget.classList.remove('drag-over');
    }
}

function handleDrop(e, targetPanel) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');

    if (!state.dragging || state.draggingFrom === targetPanel) return;

    if (targetPanel === 'target') {
        moveItem(state.dragging, 'toTarget');
    } else {
        moveItem(state.dragging, 'toSource');
    }
}

// ============================================================
//  Transfert
// ============================================================
function transferSelected(direction) {
    if (direction === 'toTarget') {
        const toMove = state.sourceItems.filter(i => state.selectedSource.has(i.dn));
        if (!toMove.length) { showToast('Sélectionner des éléments à déplacer (clic ou Ctrl+clic)', 'info'); return; }
        toMove.forEach(item => moveItem(item, 'toTarget'));
    } else {
        const toMove = state.targetItems.filter(i => state.selectedTarget.has(i.dn));
        if (!toMove.length) { showToast('Sélectionner des éléments à retirer (clic ou Ctrl+clic)', 'info'); return; }
        toMove.forEach(item => moveItem(item, 'toSource'));
    }
}

function moveItem(item, direction) {
    if (direction === 'toTarget') {
        if (state.targetItems.some(i => i.dn === item.dn)) return;
        state.targetItems.push(item);
        state.sourceItems = state.sourceItems.filter(i => i.dn !== item.dn);
        state.selectedSource.delete(item.dn);
    } else {
        state.sourceItems.push(item);
        state.targetItems = state.targetItems.filter(i => i.dn !== item.dn);
        state.selectedTarget.delete(item.dn);
    }

    renderList('source-list', state.sourceItems, 'source');
    renderList('target-list', state.targetItems, 'target');
    updateMemberCount();
}

function clearTarget() {
    state.targetItems = [];
    state.selectedTarget.clear();
    renderList('target-list', state.targetItems, 'target');
    updateMemberCount();
}

function updateMemberCount() {
    document.getElementById('member-count').textContent = `${state.targetItems.length} membre(s)`;
}

// ============================================================
//  Export
// ============================================================
function exportJSON() {
    if (!state.targetItems.length) { showToast('Aucun membre à exporter', 'info'); return; }

    const payload = {
        exportedAt:  new Date().toISOString(),
        memberCount: state.targetItems.length,
        members:     state.targetItems.map(i => ({
            samAccountName: i.samAccountName,
            displayName:    i.displayName,
            type:           i.type,
            dn:             i.dn
        }))
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `groupe-i2n-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Fichier JSON téléchargé', 'success');
}

function copyLDAPFilter() {
    if (!state.targetItems.length) { showToast('Aucun membre à exporter', 'info'); return; }

    const parts  = state.targetItems.map(i => `(distinguishedName=${i.dn})`);
    const filter = parts.length === 1 ? parts[0] : `(|${parts.join('')})`;

    navigator.clipboard.writeText(filter).then(() => {
        showToast('Filtre LDAP copié dans le presse-papiers', 'success');
    }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = filter;
        Object.assign(ta.style, { position: 'fixed', opacity: '0' });
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Filtre LDAP copié', 'success');
    });
}

// ============================================================
//  Utilitaires
// ============================================================
async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
    return res.json();
}

function esc(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function updateStatus(s) {
    const el = document.getElementById('conn-status');
    const map = {
        loading:   ['○ Connexion...', 'loading'],
        connected: ['● Connecté AD',  'connected'],
        error:     ['● Erreur AD',    'error']
    };
    const [text, cls] = map[s] || map.loading;
    el.textContent = text;
    el.className   = `conn-status ${cls}`;
}

// ============================================================
//  CSV Viewer
// ============================================================
let csvActiveItem   = null;
let allRuns         = [];
let selectedRunPath = null;
let currentRunFiles = [];

async function loadOutputList() {
    const runList = document.getElementById('csv-run-list');
    runList.innerHTML = '<p class="csv-tree-hint">Chargement...</p>';
    document.getElementById('csv-file-list').innerHTML = '';
    try {
        allRuns = await fetchJSON('/api/output/list');
        renderRunList(allRuns);
        if (allRuns.length > 0) selectRun(allRuns[0]);
    } catch (e) {
        runList.innerHTML = `<p class="csv-tree-hint">Erreur : ${esc(e.message)}</p>`;
    }
}

function renderRunList(runs) {
    const runList = document.getElementById('csv-run-list');
    if (!runs || runs.length === 0) {
        runList.innerHTML = '<p class="csv-tree-hint">Aucun dossier</p>';
        return;
    }
    runList.innerHTML = '';
    for (const run of runs) {
        const item = document.createElement('div');
        item.className = 'csv-run-item';
        item.dataset.path = run.path;
        item.addEventListener('click', () => selectRun(run));

        const label = document.createElement('span');
        label.className = 'csv-run-label';
        label.textContent = run.run;
        label.title = run.run;
        item.appendChild(label);

        const del = document.createElement('button');
        del.className = 'csv-run-del';
        del.type = 'button';
        del.title = 'Supprimer ce dossier et tout son contenu';
        del.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
        del.addEventListener('click', e => { e.stopPropagation(); deleteRun(run); });
        item.appendChild(del);

        runList.appendChild(item);
    }
}

async function deleteRun(run) {
    if (!confirm(`Supprimer le dossier « ${run.run} » et tout son contenu ?\n\nCette action est définitive.`)) return;
    try {
        const r   = await fetch('/api/output/delete', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ path: run.path }),
        });
        const txt = await r.text();
        let j = {};
        try { j = JSON.parse(txt); } catch { /* réponse non-JSON (ex. 404 si serveur pas redémarré) */ }
        if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status + (r.status === 404 ? ' — redémarrez le serveur' : '')));
    } catch (e) {
        showToast('Erreur lors de la suppression : ' + e.message, 'error');
        return;
    }
    showToast('Dossier supprimé', 'success');
    // Rafraîchir les DEUX blocs : la liste des dossiers ET la zone du bas
    selectedRunPath = null;
    currentRunFiles = [];
    document.getElementById('csv-file-list').innerHTML = '';
    document.getElementById('csv-view').innerHTML = '<p class="csv-view-hint">Sélectionner un fichier</p>';
    loadOutputList();   // recharge les dossiers ; sélectionne le 1er → remplit la zone du bas
}

function selectRun(run) {
    selectedRunPath = run.path;
    currentRunFiles = run.files || [];
    document.querySelectorAll('.csv-run-item').forEach(el =>
        el.classList.toggle('active', el.dataset.path === run.path));
    document.getElementById('csv-file-search').value = '';
    renderFileList();
}

function renderFileList() {
    const q     = document.getElementById('csv-file-search').value.toLowerCase();
    const list  = document.getElementById('csv-file-list');
    const files = q ? currentRunFiles.filter(f => f.toLowerCase().includes(q)) : currentRunFiles;
    list.innerHTML = '';
    if (!files.length) { list.innerHTML = '<p class="csv-tree-hint">Aucun fichier</p>'; return; }

    // Regroupe par dossier de tête = le GROUPE ("" = fichiers à la racine, ex. anciens runs plats)
    const groups = new Map();
    for (const f of files) {
        const i = f.indexOf('\\');
        const g = i >= 0 ? f.slice(0, i) : '';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(f);
    }

    const makeFile = (fullRel, label, nested) => {
        const el = document.createElement('div');
        el.className = 'csv-tree-file' + (nested ? ' csv-tree-file-nested' : '');
        el.textContent = label;
        el.title = fullRel;
        el.addEventListener('click', () => openCsvFile(selectedRunPath + '\\' + fullRel, el));
        return el;
    };

    for (const [g, gf] of groups) {
        if (!g) { gf.forEach(f => list.appendChild(makeFile(f, f, false))); continue; }
        const collapsed = !q;   // replié par défaut ; déplié pendant une recherche
        const head = document.createElement('div');
        head.className = 'csv-tree-group';
        head.title = g;
        head.innerHTML = '<span class="csv-tree-caret"></span><span class="csv-tree-group-name"></span><span class="csv-tree-group-count"></span>';
        head.querySelector('.csv-tree-caret').textContent      = collapsed ? '▸' : '▾';
        head.querySelector('.csv-tree-group-name').textContent  = g;
        head.querySelector('.csv-tree-group-count').textContent = gf.length;
        const wrap = document.createElement('div');
        wrap.className = 'csv-tree-group-files' + (collapsed ? ' collapsed' : '');
        gf.forEach(f => wrap.appendChild(makeFile(f, f.slice(g.length + 1), true)));
        head.addEventListener('click', () => {
            const c = wrap.classList.toggle('collapsed');
            head.querySelector('.csv-tree-caret').textContent = c ? '▸' : '▾';
        });
        list.appendChild(head);
        list.appendChild(wrap);
    }
}

async function openCsvFile(filePath, itemEl) {
    if (csvActiveItem) csvActiveItem.classList.remove('active');
    csvActiveItem = itemEl;
    itemEl.classList.add('active');

    const view = document.getElementById('csv-view');
    view.innerHTML = '<p class="csv-view-hint">Chargement...</p>';
    try {
        const data = await fetchJSON('/api/output/read?path=' + encodeURIComponent(filePath));
        renderCsvTable(data);
    } catch (e) {
        view.innerHTML = `<p class="csv-view-hint">Erreur : ${esc(e.message)}</p>`;
    }
}

function renderCsvTable(data) {
    const view = document.getElementById('csv-view');
    if (!data.headers || data.headers.length === 0) {
        view.innerHTML = '<p class="csv-view-hint">Fichier vide</p>';
        return;
    }
    const table = document.createElement('table');
    table.className = 'csv-table';
    const thead = table.createTHead();
    const hr = thead.insertRow();
    const thNum = document.createElement('th');
    thNum.textContent = '#';
    thNum.className = 'csv-col-num';
    hr.appendChild(thNum);
    for (const h of data.headers) {
        const th = document.createElement('th');
        th.textContent = h;
        hr.appendChild(th);
    }
    const tbody = table.createTBody();
    data.rows.forEach((row, i) => {
        const tr = tbody.insertRow();
        const tdNum = tr.insertCell();
        tdNum.textContent = i + 1;
        tdNum.className = 'csv-col-num';
        for (const h of data.headers) {
            const td = tr.insertCell();
            td.textContent = row[h] != null ? row[h] : '';
        }
    });
    view.innerHTML = '';
    view.appendChild(table);
}

let toastTimer;
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className   = `toast ${type} show`;
    toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3000);
}
