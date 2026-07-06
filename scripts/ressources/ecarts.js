'use strict';

// ============================================================
//  Écarts Ville (OU) ↔ Bureau (office)
//  Même interface que l'Explorateur AD : arbre (gauche) + tableau
//  (centre) + panneau Détail (droite). Lecture cache uniquement.
// ============================================================

const state = {
    data:        null,   // réponse /api/ecarts/office-ou
    sites:       {},      // { key: { do, ville, rows } } — index des nœuds « ville »
    selectedKey: null,
    currentRows: [],      // lignes de la ville sélectionnée
    sortCol:     'displayName',
    sortDir:     'asc',
};

// ============================================================
//  Init
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    if (window !== window.top) {
        document.querySelector('header').style.display = 'none';
        document.querySelector('.explorer-layout').style.height = '100vh';
    }

    setupSearch();
    setupSort();
    setupDetailPanel();

    document.getElementById('regen-btn').addEventListener('click', load);
    document.getElementById('toggle-tree-btn').addEventListener('click', () => {
        const anyCollapsed = document.querySelector('.tree-region:not(.expanded)');
        setAllRegions(!!anyCollapsed);
    });

    load();
});

// ============================================================
//  Chargement des données
// ============================================================
async function load() {
    const btn = document.getElementById('regen-btn');
    btn.disabled = true;
    btn.classList.add('spinning');
    document.getElementById('tree-container').innerHTML =
        '<p class="tree-hint">Analyse du cache en cours…</p>';
    clearMainPanel();
    clearDetailPanel();

    try {
        const res  = await fetch('/api/ecarts/office-ou', { cache: 'no-store' });
        const data = await res.json();
        if (data.error) {
            document.getElementById('tree-container').innerHTML =
                `<p class="tree-hint" style="color:#dc2626">Erreur : ${esc(data.error)}</p>`;
            return;
        }
        state.data = data;
        buildIndex(data);
        renderTree(data);
        renderMeta(data);
        showToast('Écarts recalculés depuis le cache', 'info');
    } catch (e) {
        document.getElementById('tree-container').innerHTML =
            `<p class="tree-hint" style="color:#dc2626">Erreur de chargement : ${esc(e.message)}</p>`;
    } finally {
        btn.disabled = false;
        btn.classList.remove('spinning');
    }
}

function buildIndex(data) {
    state.sites = {};
    (data.tree || []).forEach((doGroup, di) => {
        (doGroup.sites || []).forEach((site, si) => {
            state.sites[`${di}-${si}`] = { do: doGroup.do, ville: site.ville, rows: site.rows || [] };
        });
    });
}

// ============================================================
//  Résumé global (barre d'en-tête centrale)
// ============================================================
function renderMeta(data) {
    const el = document.getElementById('ecarts-meta');
    if (!data) { el.textContent = ''; return; }
    el.innerHTML =
        `<b>${data.ecartCount}</b> écart(s)` +
        `<span class="sep">·</span><b>${data.manquantCount}</b> bureau(x) manquant(s)` +
        `<span class="sep">·</span>${data.scanned} compte(s) analysé(s)` +
        `<span class="sep">·</span>Cache : ${esc(data.generatedAt)}`;
}

// ============================================================
//  Arbre DO → Ville
// ============================================================
function renderTree(data) {
    const container = document.getElementById('tree-container');
    container.innerHTML = '';

    if (!data.tree || data.tree.length === 0) {
        container.innerHTML = '<p class="tree-hint">🎉 Aucun écart détecté entre la ville de l\'OU et le bureau.</p>';
        return;
    }

    data.tree.forEach((doGroup, di) => {
        container.appendChild(createRegionNode(doGroup, di));
    });
    updateToggleTreeBtn();
}

function createRegionNode(doGroup, di) {
    const wrap = document.createElement('div');
    wrap.className = 'tree-region';

    const header = document.createElement('div');
    header.className = 'tree-region-header';

    const arrow = document.createElement('span');
    arrow.className = 'tree-arrow';
    arrow.textContent = '▶';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'region-name';
    nameSpan.textContent = doGroup.do;

    const badge = document.createElement('span');
    badge.className = 'region-count has-ecarts';
    badge.textContent = doGroup.count;
    badge.title = `${doGroup.count} écart(s) dans ${doGroup.do}`;

    header.appendChild(arrow);
    header.appendChild(nameSpan);
    header.appendChild(badge);
    header.addEventListener('click', () => toggleRegion(wrap));

    const children = document.createElement('div');
    children.className = 'tree-children';
    (doGroup.sites || []).forEach((site, si) => {
        children.appendChild(createSiteNode(site, `${di}-${si}`));
    });

    wrap.appendChild(header);
    wrap.appendChild(children);
    return wrap;
}

function createSiteNode(site, key) {
    const div = document.createElement('div');
    div.className = 'tree-site';
    div.dataset.key = key;

    const label = document.createElement('span');
    label.className = 'site-label';
    label.textContent = site.ville;

    const badge = document.createElement('span');
    badge.className = 'site-count has-ecarts';
    badge.textContent = site.count;

    div.appendChild(label);
    div.appendChild(badge);
    div.addEventListener('click', () => selectSite(key, div));
    return div;
}

function toggleRegion(regionEl) {
    const opening = !regionEl.classList.contains('expanded');
    if (opening) {
        document.querySelectorAll('.tree-region.expanded').forEach(other => {
            if (other !== regionEl) other.classList.remove('expanded');
        });
    }
    regionEl.classList.toggle('expanded', opening);
    updateToggleTreeBtn();
}

function setAllRegions(expand) {
    document.querySelectorAll('.tree-region').forEach(r => r.classList.toggle('expanded', expand));
    updateToggleTreeBtn();
}

function updateToggleTreeBtn() {
    const total    = document.querySelectorAll('.tree-region').length;
    const expanded = document.querySelectorAll('.tree-region.expanded').length;
    const btn = document.getElementById('toggle-tree-btn');
    if (btn) btn.textContent = (total > 0 && expanded >= total) ? 'Tout fermer' : 'Tout ouvrir';
}

// ============================================================
//  Sélection d'une ville → tableau des écarts
// ============================================================
function selectSite(key, el) {
    document.querySelectorAll('.tree-site.selected').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    state.selectedKey = key;

    const site = state.sites[key];
    state.currentRows = site.rows;
    clearDetailPanel();

    document.getElementById('current-site-name').textContent = `${site.do} — ${site.ville}`;
    document.getElementById('user-count').textContent = `${site.rows.length} écart(s)`;

    const filter = document.getElementById('user-filter');
    filter.disabled = false;
    filter.value = '';
    document.getElementById('user-filter-clear').hidden = true;

    state.sortCol = 'displayName';
    state.sortDir = 'asc';
    resetSortIcons();

    renderRows(getFilteredSortedRows());
}

function getFilteredSortedRows() {
    const q = document.getElementById('user-filter').value.trim().toLowerCase();
    let rows = state.currentRows;
    if (q) {
        rows = rows.filter(r =>
            (r.displayName || '').toLowerCase().includes(q) ||
            (r.villeOU     || '').toLowerCase().includes(q) ||
            (r.office      || '').toLowerCase().includes(q));
    }
    const val = r => String(r[state.sortCol] || '').toLowerCase();
    return [...rows].sort((a, b) => {
        const cmp = val(a).localeCompare(val(b), 'fr');
        return state.sortDir === 'asc' ? cmp : -cmp;
    });
}

function renderRows(rows) {
    const tbody = document.getElementById('users-tbody');
    tbody.innerHTML = '';

    if (!rows || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="td-hint">Aucun écart</td></tr>';
        return;
    }

    const frag = document.createDocumentFragment();
    for (const r of rows) {
        frag.appendChild(createEcartRow(r));
    }
    tbody.appendChild(frag);
}

function createEcartRow(r) {
    const tr = document.createElement('tr');
    tr.innerHTML =
        `<td class="col-name">${esc(r.displayName)}</td>` +
        `<td class="col-ville">${esc(r.villeOU)}</td>` +
        `<td class="col-office ${r.status}">${r.office ? esc(r.office) : '—'}</td>` +
        `<td class="col-status">${badgeStatus(r.status)}</td>`;
    tr.addEventListener('click', () => {
        document.querySelectorAll('tr.row-selected').forEach(x => x.classList.remove('row-selected'));
        tr.classList.add('row-selected');
        showUserDetail(r.user);
    });
    return tr;
}

function badgeStatus(status) {
    return status === 'manquant'
        ? '<span class="badge-status manquant">Bureau manquant</span>'
        : '<span class="badge-status ecart">Écart</span>';
}

function clearMainPanel() {
    state.selectedKey = null;
    state.currentRows = [];
    document.getElementById('current-site-name').textContent = 'Écarts : Ville (OU) ↔ Bureau (office)';
    document.getElementById('user-count').textContent = '';
    const filter = document.getElementById('user-filter');
    filter.disabled = true;
    filter.value = '';
    document.getElementById('user-filter-clear').hidden = true;
    document.getElementById('users-tbody').innerHTML =
        '<tr><td colspan="4" class="td-hint">Sélectionner une ville dans l\'arbre</td></tr>';
}

// ============================================================
//  Tri des colonnes
// ============================================================
function setupSort() {
    document.querySelectorAll('.ecarts-table th.sortable').forEach(th => {
        th.addEventListener('click', () => {
            if (state.selectedKey === null) return;
            const col = th.dataset.col;
            if (state.sortCol === col) {
                state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
            } else {
                state.sortCol = col;
                state.sortDir = 'asc';
            }
            resetSortIcons();
            th.classList.add(`sort-${state.sortDir}`);
            renderRows(getFilteredSortedRows());
        });
    });
}

function resetSortIcons() {
    document.querySelectorAll('.ecarts-table th.sortable').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
    });
}

// ============================================================
//  Recherche dans l'arbre + filtre du tableau
// ============================================================
function setupSearch() {
    const treeInput = document.getElementById('tree-search');
    const treeClear = document.getElementById('tree-search-clear');
    let treeTimer;

    treeInput.addEventListener('focus', () => treeInput.select());
    treeInput.addEventListener('input', () => {
        treeClear.hidden = treeInput.value.trim() === '';
        clearTimeout(treeTimer);
        treeTimer = setTimeout(() => filterTree(treeInput.value.trim().toLowerCase()), 150);
    });
    treeClear.addEventListener('click', () => {
        treeInput.value = '';
        treeClear.hidden = true;
        filterTree('');
        treeInput.focus();
    });

    const userInput = document.getElementById('user-filter');
    const userClear = document.getElementById('user-filter-clear');
    let userTimer;

    userInput.addEventListener('focus', () => userInput.select());
    userInput.addEventListener('input', () => {
        userClear.hidden = userInput.value.trim() === '';
        clearTimeout(userTimer);
        userTimer = setTimeout(() => {
            const rows = getFilteredSortedRows();
            renderRows(rows);
            const q = userInput.value.trim();
            document.getElementById('user-count').textContent = q
                ? `${rows.length} / ${state.currentRows.length} écart(s)`
                : `${state.currentRows.length} écart(s)`;
        }, 150);
    });
    userClear.addEventListener('click', () => {
        userInput.value = '';
        userClear.hidden = true;
        userInput.dispatchEvent(new Event('input'));
        userInput.focus();
    });
}

// Un nœud « ville » correspond si son nom de ville, sa DO, ou l'un de ses
// comptes (nom / bureau) contient le terme recherché.
function filterTree(q) {
    if (!q) {
        document.querySelectorAll('.tree-region').forEach(r => {
            r.style.display = '';
            r.classList.remove('expanded');
            r.querySelectorAll('.tree-site').forEach(s => s.classList.remove('hidden'));
        });
        updateToggleTreeBtn();
        return;
    }

    document.querySelectorAll('.tree-region').forEach(regionEl => {
        const doName = (regionEl.querySelector('.region-name')?.textContent || '').toLowerCase();
        let regionVisible = false;
        regionEl.querySelectorAll('.tree-site').forEach(siteEl => {
            const site  = state.sites[siteEl.dataset.key];
            const match = doName.includes(q) ||
                (site.ville || '').toLowerCase().includes(q) ||
                site.rows.some(r =>
                    (r.displayName || '').toLowerCase().includes(q) ||
                    (r.office      || '').toLowerCase().includes(q));
            siteEl.classList.toggle('hidden', !match);
            if (match) regionVisible = true;
        });
        regionEl.style.display = regionVisible ? '' : 'none';
        regionEl.classList.toggle('expanded', regionVisible);
    });
    updateToggleTreeBtn();
}

// ============================================================
//  Panneau Détail — repris à l'identique de l'Explorateur AD
// ============================================================
function setupDetailPanel() {
    const detailPanel  = document.getElementById('detail-panel');
    const detailToggle = document.getElementById('btn-detail-toggle');
    const SVG_LEFT  = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 2L5 7L9 12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const SVG_RIGHT = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 2L9 7L5 12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    detailToggle.addEventListener('click', () => {
        const collapsed = detailPanel.classList.toggle('detail-collapsed');
        detailToggle.innerHTML = collapsed ? SVG_RIGHT : SVG_LEFT;
        detailToggle.title     = collapsed ? 'Afficher le panneau Détail' : 'Masquer le panneau Détail';
    });

    // Poignée de redimensionnement (bord gauche du panneau)
    if (!detailPanel.querySelector('.detail-resizer')) {
        const rz = document.createElement('div');
        rz.className = 'detail-resizer';
        rz.title = 'Glisser pour élargir / rétrécir';
        detailPanel.appendChild(rz);
        let startX = 0, startW = 0;
        rz.addEventListener('pointerdown', e => {
            if (detailPanel.classList.contains('detail-collapsed')) return;
            startX = e.clientX; startW = detailPanel.offsetWidth;
            detailPanel.classList.add('resizing');
            rz.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        rz.addEventListener('pointermove', e => {
            if (!rz.hasPointerCapture(e.pointerId)) return;
            const w = Math.min(1000, Math.max(300, startW + (startX - e.clientX)));
            detailPanel.style.width = w + 'px';
        });
        const endDrag = e => {
            if (rz.hasPointerCapture(e.pointerId)) rz.releasePointerCapture(e.pointerId);
            detailPanel.classList.remove('resizing');
        };
        rz.addEventListener('pointerup', endDrag);
        rz.addEventListener('pointercancel', endDrag);
    }
}

function buildProxyHtml(u) {
    const _raw    = u.proxyAddresses;
    const proxies = Array.isArray(_raw) ? _raw
                  : (typeof _raw === 'string' && _raw ? [_raw] : []);
    if (proxies.length === 0) return '';
    return `<div class="detail-field">
        <span class="detail-label">Proxy adresses</span>
        <span class="detail-value proxy-list">${proxies.map(p => {
            const col    = p.indexOf(':');
            const prefix = col >= 0 ? p.slice(0, col)  : p;
            const addr   = col >= 0 ? p.slice(col + 1) : '';
            const primary = prefix === 'SMTP';
            return `<span class="proxy-entry${primary ? ' proxy-entry-primary' : ''}">` +
                   `<span class="proxy-pfx">${esc(prefix)}</span>` +
                   `<span class="proxy-sep"> : </span>` +
                   `<span class="proxy-addr">${esc(addr)}</span>` +
                   `</span>`;
        }).join('')}</span>
    </div>`;
}

function showUserDetail(u) {
    const body = document.querySelector('.explorer-right-body');
    if (!u) { body.innerHTML = '<p class="hint">Détail indisponible.</p>'; return; }

    const initials = (() => {
        const parts = (u.displayName || u.samAccountName || '?').trim().split(/\s+/);
        return parts.length >= 2
            ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
            : (parts[0][0] || '?').toUpperCase();
    })();

    const statusHtml = u.enabled === false
        ? '<span class="detail-status detail-disabled">Compte désactivé</span>'
        : '<span class="detail-status detail-enabled">Compte actif</span>';

    // csv = true → champ pris en charge par la mise à jour AD (tag « MAJ AD »).
    const detailField = (label, value, wide, csv) => {
        const empty = value == null || String(value).trim() === '';
        const tag = csv ? ' <span class="detail-csv-tag" title="Champ pris en charge par la mise à jour AD (MAJ AD)">MAJ AD</span>' : '';
        return `<div class="detail-field${wide ? ' detail-field-wide' : ''}">
                    <span class="detail-label">${esc(label)}${tag}</span>
                    <span class="detail-value${empty ? ' detail-value-empty' : ''}">${empty ? '—' : esc(String(value))}</span>
                </div>`;
    };
    const gridFields = [
        ['Identifiant (samAccountName)', u.samAccountName,   false],
        ['Fonction (title)',             u.title,            true],
        ['Service (department)',         u.department,       true],
        ['Société (company)',            u.company,          true],
        ['Matricule (employeeNumber)',   u.employeeNumber,   true],
        ['Responsable (manager)',        u.manager,          true],
        ['UPN (userPrincipalName)',      u.userPrincipalName, true],
        ['Type',                         u.type,             true],
        ['extensionAttribute1',          u.extensionAttribute1, true],
        ['Messagerie (mail)',            u.mail,             false],
        ['Code postal (postalCode)',     u.postalCode,       true],
        ['Adresse (streetAddress)',      u.streetAddress,    true],
        ['Description',                  u.description,      false],
    ];

    body.innerHTML = `
        <div class="detail-card">
            <div class="detail-avatar">${esc(initials)}</div>
            <div class="detail-name">${esc(u.displayName || u.samAccountName)}</div>
            ${statusHtml}
            <div class="detail-fields">
                ${detailField('OU (arborescence)', u.ouDn, true, false)}
                ${detailField('Bureau (office)', u.office, true, true)}
                <div class="detail-fields-grid">
                    ${gridFields.map(([l, v, csv]) => detailField(l, v, false, csv)).join('')}
                </div>
                ${buildProxyHtml(u)}
            </div>
        </div>`;
}

function clearDetailPanel() {
    document.querySelectorAll('tr.row-selected').forEach(x => x.classList.remove('row-selected'));
    const body = document.querySelector('.explorer-right-body');
    if (body) body.innerHTML = '<p class="hint">Sélectionner un utilisateur</p>';
}

// ============================================================
//  Utilitaires
// ============================================================
function esc(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let toastTimer;
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3000);
}
