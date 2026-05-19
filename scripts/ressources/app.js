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
});

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
let csvActiveItem = null;

async function loadOutputList() {
    const tree = document.getElementById('csv-tree');
    tree.innerHTML = '<p class="csv-tree-hint">Chargement...</p>';
    try {
        const runs = await fetchJSON('/api/output/list');
        renderCsvTree(runs);
    } catch (e) {
        tree.innerHTML = `<p class="csv-tree-hint">Erreur : ${esc(e.message)}</p>`;
    }
}

function renderCsvTree(runs) {
    const tree = document.getElementById('csv-tree');
    if (!runs || runs.length === 0) {
        tree.innerHTML = '<p class="csv-tree-hint">Aucun CSV généré</p>';
        return;
    }
    tree.innerHTML = '';
    for (const run of runs) {
        const section = document.createElement('div');
        section.className = 'csv-tree-run';
        const label = document.createElement('div');
        label.className = 'csv-tree-run-label';
        label.textContent = run.run;
        label.title = run.run;
        section.appendChild(label);
        for (const file of run.files) {
            const item = document.createElement('div');
            item.className = 'csv-tree-file';
            item.textContent = file;
            item.title = file;
            const fullPath = run.path + '\\' + file;
            item.addEventListener('click', () => openCsvFile(fullPath, item));
            section.appendChild(item);
        }
        tree.appendChild(section);
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
    for (const h of data.headers) {
        const th = document.createElement('th');
        th.textContent = h;
        hr.appendChild(th);
    }
    const tbody = table.createTBody();
    for (const row of data.rows) {
        const tr = tbody.insertRow();
        for (const h of data.headers) {
            const td = tr.insertCell();
            td.textContent = row[h] != null ? row[h] : '';
        }
    }
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
