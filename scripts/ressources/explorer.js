'use strict';

// ============================================================
//  État
// ============================================================
const state = {
    treeData:       [],
    allUsers:       [],
    sortCol:        'displayName',
    sortDir:        'asc',
    groupBy:        'none',
    groupsExpanded: true,
    selectedSite:   null
};

const warmupDone    = new Set();
const prefetchedDns = new Set();
const allSiteUsers  = {};   // { dn: [users] }  — index cross-site pour la recherche
const dnNameMap     = {};   // { dn: siteName }

// File d'attente de prefetch — max 3 requêtes simultanées
const prefetchQueue    = [];
let   prefetchRunning  = 0;
const PREFETCH_CONCURRENCY = 3;

function enqueuePrefetch(dn, onDone) {
    if (prefetchedDns.has(dn)) { onDone?.(); return; }
    prefetchedDns.add(dn);
    prefetchQueue.push({ dn, onDone });
    drainPrefetchQueue();
}

function drainPrefetchQueue() {
    while (prefetchRunning < PREFETCH_CONCURRENCY && prefetchQueue.length > 0) {
        const { dn, onDone } = prefetchQueue.shift();
        prefetchRunning++;
        fetch('/api/ou/users?dn=' + encodeURIComponent(dn))
            .then(r => r.json())
            .then(users => {
                if (!Array.isArray(users)) return;
                allSiteUsers[dn] = users;
                setBadgeCount(document.getElementById('count-' + dnToId(dn)), users.length);
            })
            .catch(() => {})
            .finally(() => { onDone?.(); prefetchRunning--; drainPrefetchQueue(); });
    }
}

// ── Helpers compteurs ─────────────────────────────────────────────────

function setBadgeCount(badge, count) {
    if (!badge) return;
    badge.textContent = count;
}

function updateAllRegionCounts() {
    // Region counts are static (number of sites/sub-groups), set once in createRegionNode
}

// ============================================================
//  Footer de progression (scan)
// ============================================================
const scanFooter = {
    _total: 0,
    _done:  0,

    show(label, total) {
        this._total = total;
        this._done  = 0;
        document.getElementById('scan-label-text').textContent = label + ' —';
        document.getElementById('scan-current-ou').textContent = '';
        document.getElementById('scan-progress-text').textContent = `0 / ${total}`;
        document.getElementById('scan-bar').style.width = '0%';
        document.getElementById('scan-footer').hidden = false;
    },

    update(siteName) {
        this._done++;
        const pct = Math.round((this._done / this._total) * 100);
        document.getElementById('scan-current-ou').textContent = siteName;
        document.getElementById('scan-progress-text').textContent = `${this._done} / ${this._total}`;
        document.getElementById('scan-bar').style.width = pct + '%';
        if (this._done >= this._total) setTimeout(() => this.hide(), 1000);
    },

    hide() {
        document.getElementById('scan-footer').hidden = true;
    }
};


// ============================================================
//  Snapshot sessionStorage — persistance entre navigations
// ============================================================
const SNAPSHOT_KEY = 'explorer_snapshot';
const SNAPSHOT_TTL = 30 * 60 * 1000;  // 30 min

function saveSnapshot() {
    if (!state.treeData.length) return;
    try {
        const expandedNames = [...document.querySelectorAll('.tree-region.expanded')]
            .map(el => el.querySelector('.region-name')?.textContent)
            .filter(Boolean);
        sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
            ts:           Date.now(),
            treeData:     state.treeData,
            selectedDn:   state.selectedSite?.site.dn   ?? null,
            selectedSite: state.selectedSite?.site       ?? null,
            allUsers:     state.allUsers,
            sortCol:      state.sortCol,
            sortDir:      state.sortDir,
            groupBy:      state.groupBy,
            expandedNames,
        }));
    } catch { /* sessionStorage plein */ }
}

function tryRestoreSnapshot() {
    try {
        const raw = sessionStorage.getItem(SNAPSHOT_KEY);
        if (!raw) return false;
        const snap = JSON.parse(raw);
        if (!snap?.treeData?.length || Date.now() - snap.ts > SNAPSHOT_TTL) return false;

        // État en mémoire
        state.treeData = snap.treeData;
        state.sortCol  = snap.sortCol || 'displayName';
        state.sortDir  = snap.sortDir || 'asc';
        state.groupBy  = snap.groupBy || 'none';

        // Index DN → nom de site
        state.treeData.flatMap(r => r.children || [])
            .forEach(s => { dnNameMap[s.dn] = s.name; });

        // Rendu de l'arbre
        renderTree(snap.treeData);

        // Régions ouvertes
        if (snap.expandedNames?.length) {
            document.querySelectorAll('.tree-region').forEach(el => {
                const name = el.querySelector('.region-name')?.textContent;
                if (snap.expandedNames.includes(name)) el.classList.add('expanded');
            });
        }
        updateToggleTreeBtn();

        // Site sélectionné + tableau
        if (snap.selectedDn && snap.selectedSite && snap.allUsers?.length) {
            allSiteUsers[snap.selectedDn] = snap.allUsers;
            state.allUsers = snap.allUsers;

            let siteEl = null;
            document.querySelectorAll('.tree-site').forEach(el => {
                if (el.dataset.dn === snap.selectedDn) siteEl = el;
            });

            if (siteEl) {
                state.selectedSite = { site: snap.selectedSite, el: siteEl };
                siteEl.classList.add('selected');
                // Ouvrir la région parente si nécessaire
                const regionEl = siteEl.closest('.tree-region');
                if (regionEl && !regionEl.classList.contains('expanded')) {
                    regionEl.classList.add('expanded');
                    updateToggleTreeBtn();
                }
                updateSiteHeader(snap.selectedSite, snap.allUsers.length, false);
                document.getElementById('group-by').value    = state.groupBy;
                document.getElementById('group-by').disabled = false;
                document.getElementById('user-filter').disabled = false;
                // Icônes de tri
                resetSortIcons();
                const thSort = document.querySelector(`.users-table th[data-col="${state.sortCol}"]`);
                if (thSort) thSort.classList.add(`sort-${state.sortDir}`);
                renderUsers(state.allUsers);
            }
        }

        // Actualisation silencieuse en arrière-plan
        fetchAndApplyCounts().catch(() => {});
        const allSites = snap.treeData.flatMap(r => r.children || []);
        const uncached = allSites.filter(s => {
            const badge = document.getElementById('count-' + dnToId(s.dn));
            return !badge || badge.textContent === '';
        });
        if (uncached.length > 0) scanFooter.show('Génération du cache', uncached.length);
        const uncachedDns = new Set(uncached.map(s => s.dn));
        allSites.forEach(s => {
            const cb = uncachedDns.has(s.dn) ? () => scanFooter.update(s.name) : null;
            enqueuePrefetch(s.dn, cb);
        });

        return true;
    } catch {
        return false;
    }
}

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
    setupGroupBy();

    if (!tryRestoreSnapshot()) {
        loadTree();
    }

    setupFunctionModal();
    window.addEventListener('beforeunload', saveSnapshot);

    document.getElementById('refresh-all-btn').addEventListener('click', refreshAllCache);

    document.getElementById('toggle-tree-btn').addEventListener('click', () => {
        const anyCollapsed = document.querySelector('.tree-region:not(.expanded)');
        setAllRegions(!!anyCollapsed);
    });

    // ── Toggle panneau Détail ─────────────────────────────────────────────
    const detailPanel  = document.getElementById('detail-panel');
    const detailToggle = document.getElementById('btn-detail-toggle');
    const SVG_CHEVRON_LEFT  = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 2L5 7L9 12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const SVG_CHEVRON_RIGHT = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 2L9 7L5 12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    detailToggle.addEventListener('click', () => {
        const collapsed = detailPanel.classList.toggle('detail-collapsed');
        detailToggle.innerHTML = collapsed ? SVG_CHEVRON_RIGHT : SVG_CHEVRON_LEFT;
        detailToggle.title     = collapsed ? 'Afficher le panneau Détail' : 'Masquer le panneau Détail';
    });
});

// ============================================================
//  Chargement de l'arbre
// ============================================================
async function loadTree() {
    try {
        const data = await fetchJSON('/api/tree');
        state.treeData = data;
        renderTree(data);
        await fetchAndApplyCounts();

        const allSites = data.flatMap(r => r.children || []);

        // Index DN → nom de site pour la recherche cross-site
        allSites.forEach(s => { dnNameMap[s.dn] = s.name; });

        // Lire les compteurs depuis l'index de cache
        await fetchAndApplyCounts();

        const uncached = allSites.filter(s => {
            const badge = document.getElementById('count-' + dnToId(s.dn));
            return !badge || badge.textContent === '';
        });

        if (uncached.length > 0) {
            scanFooter.show('Génération du cache', uncached.length);
        }

        // Prefetch tous les sites (alimenter allSiteUsers + détecter stale)
        // Seuls les non-cachés font avancer le footer
        const uncachedDns = new Set(uncached.map(s => s.dn));
        allSites.forEach(s => {
            const cb = uncachedDns.has(s.dn) ? () => scanFooter.update(s.name) : null;
            enqueuePrefetch(s.dn, cb);
        });
    } catch (e) {
        document.getElementById('tree-container').innerHTML =
            `<p class="tree-hint" style="color:#dc2626">Erreur : ${esc(e.message)}</p>`;
        showToast('Impossible de charger l\'arbre AD', 'error');
    }
}

async function fetchAndApplyCounts() {
    try {
        const counts = await fetchJSON('/api/cache/counts');
        document.querySelectorAll('.tree-site').forEach(siteEl => {
            const dn = siteEl.dataset.dn;
            if (counts[dn] !== undefined) {
                const badge = document.getElementById('count-' + dnToId(dn));
                if (badge && badge.textContent !== String(counts[dn])) {
                    setBadgeCount(badge, counts[dn]);
                }
            }
        });
    } catch (e) {}
}

function renderTree(regions) {
    const container = document.getElementById('tree-container');
    container.innerHTML = '';

    if (!regions || regions.length === 0) {
        container.innerHTML = '<p class="tree-hint">Aucune OU trouvée</p>';
        return;
    }

    for (const region of regions) {
        container.appendChild(createRegionNode(region));
    }
}

function createRegionNode(region) {
    const wrap = document.createElement('div');
    wrap.className = 'tree-region';

    const header = document.createElement('div');
    header.className = 'tree-region-header';

    const arrow = document.createElement('span');
    arrow.className = 'tree-arrow';
    arrow.textContent = '▶';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'region-name';
    nameSpan.textContent = region.name;

    const nbSites = (region.children || []).length;
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'region-refresh-btn';
    refreshBtn.textContent = '↻';
    refreshBtn.title = `Actualiser le cache de "${region.name}" — ${nbSites} site(s)`;
    refreshBtn.addEventListener('click', e => { e.stopPropagation(); refreshRegionCache(region, wrap); });

    const regionBadge = document.createElement('span');
    regionBadge.className = 'region-count';
    const nbChildren = (region.children || []).length;
    regionBadge.textContent = nbChildren > 0 ? nbChildren : '';

    header.appendChild(arrow);
    header.appendChild(nameSpan);
    header.appendChild(regionBadge);
    header.appendChild(refreshBtn);
    header.addEventListener('click', () => toggleRegion(wrap));

    const children = document.createElement('div');
    children.className = 'tree-children';

    const sites = region.children || [];
    if (region.multiBase) {
        // Grouper par baseLabel (sous-catégorie)
        const groups = {};
        for (const site of sites) {
            const lbl = site.baseLabel || '';
            if (!groups[lbl]) groups[lbl] = [];
            groups[lbl].push(site);
        }
        for (const lbl of Object.keys(groups).sort()) {
            const subHeader = document.createElement('div');
            subHeader.className = 'tree-subgroup';
            subHeader.textContent = lbl;
            children.appendChild(subHeader);
            for (const site of groups[lbl]) {
                children.appendChild(createSiteNode(site));
            }
        }
    } else {
        for (const site of sites) {
            children.appendChild(createSiteNode(site));
        }
    }

    wrap.appendChild(header);
    wrap.appendChild(children);
    return wrap;
}

function createSiteNode(site) {
    const div = document.createElement('div');
    div.className = 'tree-site';
    div.dataset.dn   = site.dn;
    div.dataset.name = site.name;
    const safeId = dnToId(site.dn);

    const label  = document.createElement('span');
    label.className   = 'site-label';
    label.textContent = site.name;

    const badge  = document.createElement('span');
    badge.className = 'site-count';
    badge.id        = 'count-' + safeId;

    const btn = document.createElement('button');
    btn.className = 'site-refresh-btn';
    btn.textContent = '↻';
    btn.title = `Actualiser le cache de "${site.name}"`;
    btn.addEventListener('click', e => { e.stopPropagation(); refreshSiteCache(site, btn); });

    div.appendChild(label);
    div.appendChild(badge);
    div.appendChild(btn);
    div.addEventListener('click', () => selectSite(site, div));
    return div;
}

async function refreshSiteCache(site, btn) {
    const ok = confirm(`Actualiser le cache de "${site.name}" ?\n\nLes données seront rechargées depuis l'AD.`);
    if (!ok) return;

    btn.classList.add('spinning');
    btn.disabled = true;
    scanFooter.show(`Actualisation`, 1);
    document.getElementById('scan-current-ou').textContent = site.name;

    try {
        const res   = await fetch('/api/ou/users?dn=' + encodeURIComponent(site.dn) + '&fresh=1');
        const users = await res.json();
        if (Array.isArray(users)) {
            allSiteUsers[site.dn] = users;
            setBadgeCount(document.getElementById('count-' + dnToId(site.dn)), users.length);
            if (state.selectedSite?.site.dn === site.dn) {
                state.allUsers = users;
                renderUsers(users);
                updateSiteHeader(site, users.length, false);
            }
        }
        scanFooter.update(site.name);
        showToast(`Cache "${site.name}" actualisé`, 'info');
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error');
        scanFooter.hide();
    } finally {
        btn.classList.remove('spinning');
        btn.disabled = false;
    }
}

function dnToId(dn) {
    let hash = 0;
    for (let i = 0; i < dn.length; i++) {
        hash = (hash * 31 + dn.charCodeAt(i)) >>> 0;
    }
    return 'dn' + hash.toString(36);
}

function toggleRegion(regionEl) {
    const opening = !regionEl.classList.contains('expanded');

    if (opening) {
        // Fermer toutes les autres régions (accordéon)
        document.querySelectorAll('.tree-region.expanded').forEach(other => {
            if (other !== regionEl) other.classList.remove('expanded');
        });
        regionEl.classList.add('expanded');

        const regionId = regionEl.querySelector('.region-name')?.textContent;
        if (regionId && !warmupDone.has(regionId)) {
            warmupDone.add(regionId);
            regionEl.querySelectorAll('.tree-site').forEach(siteEl => {
                const badge = document.getElementById('count-' + dnToId(siteEl.dataset.dn));
                if (!badge || badge.textContent === '') enqueuePrefetch(siteEl.dataset.dn);
            });
        }
    } else {
        regionEl.classList.remove('expanded');
    }

    updateToggleTreeBtn();
}


async function refreshAllCache() {
    const allSites = state.treeData.flatMap(r => r.children || []);
    if (!allSites.length) return;

    const ok = confirm(`Vider et reconstruire tout le cache ?\n\n${allSites.length} site(s) rechargé(s) depuis l'AD.\nCette opération peut prendre plusieurs minutes.`);
    if (!ok) return;

    const btn = document.getElementById('refresh-all-btn');
    btn.disabled = true;
    btn.classList.add('spinning');

    try {
        const res  = await fetch('/api/cache/refresh-all', { method: 'POST' });
        const data = await res.json();

        // Vider l'index client
        for (const dn of Object.keys(allSiteUsers)) delete allSiteUsers[dn];
        prefetchedDns.clear();

        // Réinitialiser les badges
        document.querySelectorAll('.site-count').forEach(b => { b.textContent = ''; });

        // Vider le tableau si un site était sélectionné
        if (state.selectedSite) {
            state.allUsers = [];
            renderUsers([]);
            updateSiteHeader(state.selectedSite.site, null, false);
        }
        clearDetailPanel();

        // Relancer le prefetch de tous les sites
        scanFooter.show('Reconstruction du cache', allSites.length);
        allSites.forEach(s => enqueuePrefetch(s.dn, () => scanFooter.update(s.name)));

        showToast(`Cache vidé (${data.deleted} fichier(s)) — reconstruction en cours`, 'info');
        window.parent.postMessage({ type: 'cache-rebuilt' }, '*');
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.classList.remove('spinning');
    }
}

async function refreshRegionCache(region, regionEl) {
    const sites = region.children || [];
    const ok = confirm(`Actualiser le cache de "${region.name}" ?\n\n${sites.length} site(s) rechargé(s) depuis l'AD.\nCette opération peut prendre quelques secondes.`);
    if (!ok) return;

    const btn = regionEl.querySelector('.region-refresh-btn');
    btn.classList.add('spinning');
    btn.disabled = true;

    scanFooter.show(`Actualisation — ${region.name}`, sites.length);

    try {
        await Promise.all(sites.map(s =>
            fetch('/api/ou/users?dn=' + encodeURIComponent(s.dn) + '&fresh=1')
                .then(r => r.json())
                .then(users => {
                    if (!Array.isArray(users)) return;
                    allSiteUsers[s.dn] = users;
                    setBadgeCount(document.getElementById('count-' + dnToId(s.dn)), users.length);
                })
                .catch(() => {})
                .finally(() => scanFooter.update(s.name))
        ));
        showToast(`Cache "${region.name}" actualisé (${sites.length} site(s))`, 'info');
    } catch (e) {
        showToast('Erreur actualisation : ' + e.message, 'error');
        scanFooter.hide();
    } finally {
        btn.classList.remove('spinning');
        btn.disabled = false;
    }
}

function setAllRegions(expand) {
    document.querySelectorAll('.tree-region').forEach(regionEl => {
        const isOpen = regionEl.classList.contains('expanded');
        if (expand && !isOpen) {
            regionEl.classList.add('expanded');
            const regionId = regionEl.querySelector('.region-name')?.textContent;
            if (regionId && !warmupDone.has(regionId)) {
                warmupDone.add(regionId);
                regionEl.querySelectorAll('.tree-site').forEach(siteEl => {
                    const badge = document.getElementById('count-' + dnToId(siteEl.dataset.dn));
                    if (!badge || badge.textContent === '') enqueuePrefetch(siteEl.dataset.dn);
                });
            }
        } else if (!expand) {
            regionEl.classList.remove('expanded');
        }
    });
    updateToggleTreeBtn();
}

function updateToggleTreeBtn() {
    const total    = document.querySelectorAll('.tree-region').length;
    const expanded = document.querySelectorAll('.tree-region.expanded').length;
    const btn = document.getElementById('toggle-tree-btn');
    if (btn) btn.textContent = (total > 0 && expanded >= total) ? 'Tout fermer' : 'Tout ouvrir';
}

// ============================================================
//  Sélection d'un site → chargement des utilisateurs
// ============================================================
async function selectSite(site, el, forceRefresh = false) {
    document.querySelectorAll('.tree-site.selected').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    state.selectedSite = { site, el };
    clearDetailPanel();

    document.getElementById('user-filter').disabled = true;
    document.getElementById('user-filter').value = '';
    updateSiteHeader(site, null, false);
    setTableLoading();

    try {
        const url = `/api/ou/users?dn=${encodeURIComponent(site.dn)}${forceRefresh ? '&fresh=1' : ''}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const users = await res.json();
        const fromCache = res.headers.get('X-Cache') === 'HIT';

        state.allUsers = users || [];
        allSiteUsers[site.dn] = state.allUsers;
        state.sortCol  = 'displayName';
        state.sortDir  = 'asc';
        resetSortIcons();
        renderUsers(state.allUsers);
        updateSiteHeader(site, state.allUsers.length, fromCache);
        document.getElementById('user-filter').disabled = false;
        document.getElementById('group-by').disabled = false;

        if (fromCache) showToast('Données depuis le cache', 'info');

        setBadgeCount(document.getElementById('count-' + dnToId(site.dn)), state.allUsers.length);
    } catch (e) {
        setTableError(e.message);
        showToast('Erreur chargement utilisateurs : ' + e.message, 'error');
    }
}

function updateSiteHeader(site, count, fromCache) {
    document.getElementById('current-site-name').textContent = site.name;

    const countEl = document.getElementById('user-count');
    countEl.textContent = count !== null ? `${count} utilisateur(s)` : '';
    document.title = count !== null
        ? `${site.name} (${count}) — Explorateur AD`
        : 'Explorateur AD — I2N';
}

// ============================================================
//  Regroupement
// ============================================================
function setupGroupBy() {
    document.getElementById('group-by').addEventListener('change', e => {
        state.groupBy = e.target.value;
        const q = document.getElementById('user-filter').value.trim().toLowerCase();
        const source = q ? state.allUsers.filter(u => matchesFilter(u, q)) : state.allUsers;
        displayUsers(source);
    });

    document.getElementById('toggle-all-btn').addEventListener('click', () => {
        setAllGroups(!state.groupsExpanded);
    });
}

function updateToggleBtn() {
    const btn = document.getElementById('toggle-all-btn');
    if (state.groupBy === 'none') {
        btn.style.display = 'none';
    } else {
        btn.style.display = '';
        btn.textContent = state.groupsExpanded ? 'Tout fermer' : 'Tout ouvrir';
    }
}

function setAllGroups(expand) {
    state.groupsExpanded = expand;

    // Mettre à jour toutes les flèches
    document.querySelectorAll('.group-header .group-toggle').forEach(t => {
        t.classList.toggle('expanded', expand);
        t.textContent = expand ? '▼' : '▶';
    });

    if (state.groupBy === 'category') {
        // Sous-en-têtes + lignes utilisateurs : tout montrer ou tout cacher
        document.querySelectorAll('.group-sub, .group-member').forEach(row => {
            row.style.display = expand ? '' : 'none';
        });
    } else {
        document.querySelectorAll('.group-header').forEach(hdr => {
            let row = hdr.nextElementSibling;
            while (row && row.classList.contains('group-member')) {
                row.style.display = expand ? '' : 'none';
                row = row.nextElementSibling;
            }
        });
    }

    updateToggleBtn();
}

function displayUsers(users) {
    if (state.groupBy === 'none') {
        renderFlat(getSortedUsers(users));
    } else if (state.groupBy === 'category') {
        state.groupsExpanded = true;
        renderCategoryGrouped(users);
    } else {
        state.groupsExpanded = true;
        renderGrouped(users, state.groupBy);
    }
    updateToggleBtn();
}

// ============================================================
//  Rendu plat (sans regroupement)
// ============================================================
function renderFlat(users) {
    const tbody = document.getElementById('users-tbody');
    tbody.innerHTML = '';

    if (!users || users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="td-hint">Aucun utilisateur dans ce site</td></tr>';
        return;
    }

    const frag = document.createDocumentFragment();
    for (const u of users) {
        frag.appendChild(createUserRow(u));
    }
    tbody.appendChild(frag);
}

// ============================================================
//  Rendu groupé
// ============================================================
function renderGrouped(users, groupBy) {
    const tbody = document.getElementById('users-tbody');
    tbody.innerHTML = '';

    if (!users || users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="td-hint">Aucun utilisateur dans ce site</td></tr>';
        return;
    }

    const groups = {};
    for (const u of users) {
        let key;
        if (groupBy === 'letter') {
            key = (u.displayName || u.samAccountName || '?')[0].toUpperCase();
        } else if (groupBy === 'title') {
            key = u.title || '(sans fonction)';
        } else if (groupBy === 'department') {
            key = u.department || '(sans service)';
        }
        if (!groups[key]) groups[key] = [];
        groups[key].push(u);
    }

    const sortedKeys = Object.keys(groups).sort((a, b) => a.localeCompare(b, 'fr'));
    const frag = document.createDocumentFragment();

    for (const key of sortedKeys) {
        const groupUsers = groups[key].sort((a, b) =>
            (a.displayName || '').localeCompare(b.displayName || '', 'fr'));

        const isFormateur = key === 'FORMATEURS' || key.toLowerCase().includes('formateur');
        const isCategory  = groupBy === 'category';
        const headerTr = document.createElement('tr');
        headerTr.className = 'group-header'
            + (isFormateur ? ' group-formateur' : '')
            + (isCategory  ? ' group-category'  : '');
        headerTr.innerHTML = `
            <td colspan="5">
                <span class="group-toggle expanded">▼</span>
                <span class="group-label">${esc(key)}</span>
                <span class="group-count">${groupUsers.length}</span>
            </td>`;
        headerTr.addEventListener('click', () => toggleGroupRows(headerTr));
        frag.appendChild(headerTr);

        for (const u of groupUsers) {
            const tr = createUserRow(u);
            tr.classList.add('group-member');
            frag.appendChild(tr);
        }
    }
    tbody.appendChild(frag);
}

// ============================================================
//  Rendu catégorie deux niveaux (Formateurs / Administratif → Fonction)
// ============================================================
function renderCategoryGrouped(users) {
    const tbody = document.getElementById('users-tbody');
    tbody.innerHTML = '';

    if (!users || users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="td-hint">Aucun utilisateur dans ce site</td></tr>';
        return;
    }

    const buckets = [
        { key: 'FORMATEURS',    list: users.filter(u =>  (u.title || '').toLowerCase().includes('formateur')) },
        { key: 'ADMINISTRATIF', list: users.filter(u => !(u.title || '').toLowerCase().includes('formateur')) }
    ];

    const frag = document.createDocumentFragment();

    for (const { key: catKey, list: catUsers } of buckets) {
        if (catUsers.length === 0) continue;

        const isFormateur = catKey === 'FORMATEURS';

        const mainTr = document.createElement('tr');
        mainTr.className = 'group-header group-category' + (isFormateur ? ' group-formateur' : '');
        mainTr.innerHTML = `<td colspan="5">
            <span class="group-toggle expanded">▼</span>
            <span class="group-label">${esc(catKey)}</span>
            <span class="group-count">${catUsers.length}</span>
        </td>`;
        mainTr.addEventListener('click', () => toggleMainCategory(mainTr));
        frag.appendChild(mainTr);

        const titleGroups = {};
        for (const u of catUsers) {
            const k = u.title || '(sans fonction)';
            if (!titleGroups[k]) titleGroups[k] = [];
            titleGroups[k].push(u);
        }

        for (const title of Object.keys(titleGroups).sort((a, b) => a.localeCompare(b, 'fr'))) {
            const titleUsers = titleGroups[title].sort((a, b) =>
                (a.displayName || '').localeCompare(b.displayName || '', 'fr'));

            const subTr = document.createElement('tr');
            subTr.className = 'group-header group-sub' + (isFormateur ? ' group-formateur' : '');
            subTr.innerHTML = `<td colspan="5">
                <span class="group-toggle expanded">▼</span>
                <span class="group-label">${esc(title)}</span>
                <span class="group-count">${titleUsers.length}</span>
            </td>`;
            subTr.addEventListener('click', e => { e.stopPropagation(); toggleGroupRows(subTr); });
            frag.appendChild(subTr);

            for (const u of titleUsers) {
                const tr = createUserRow(u);
                tr.classList.add('group-member');
                frag.appendChild(tr);
            }
        }
    }

    tbody.appendChild(frag);
}

function toggleMainCategory(mainTr) {
    const toggle = mainTr.querySelector('.group-toggle');
    const expand = !toggle.classList.contains('expanded');
    toggle.classList.toggle('expanded', expand);
    toggle.textContent = expand ? '▼' : '▶';

    let subExpanded = false;
    let row = mainTr.nextElementSibling;
    while (row && !row.classList.contains('group-category')) {
        if (row.classList.contains('group-sub')) {
            row.style.display = expand ? '' : 'none';
            // On conserve l'état ouvert/fermé du sous-groupe
            subExpanded = expand && row.querySelector('.group-toggle')?.classList.contains('expanded');
        } else if (row.classList.contains('group-member')) {
            row.style.display = (expand && subExpanded) ? '' : 'none';
        }
        row = row.nextElementSibling;
    }
}

function toggleGroupRows(headerTr) {
    const toggle = headerTr.querySelector('.group-toggle');
    const isExpanded = toggle.classList.toggle('expanded');
    toggle.textContent = isExpanded ? '▼' : '▶';

    let row = headerTr.nextElementSibling;
    while (row && row.classList.contains('group-member')) {
        row.style.display = isExpanded ? '' : 'none';
        row = row.nextElementSibling;
    }
}

let _selectedUserRow = null;
let _detailUserSam   = null;   // samAccountName de l'utilisateur affiché dans le panneau détail

function createUserRow(u, siteDn) {
    const tr = document.createElement('tr');
    const disabledTag = u.enabled === false ? '<span class="tag-disabled">désactivé</span>' : '';
    tr.innerHTML = `
        <td class="col-name">${esc(u.displayName || u.samAccountName)}${disabledTag}</td>
        <td class="col-desc">${esc(u.description || '')}</td>
        <td class="col-func${u.title ? ' func-clickable' : ''}">${esc(u.title || '')}</td>
        <td class="col-mail">${esc(u.mail || '')}</td>
        <td class="col-dept">${esc(u.department || '')}</td>`;
    if (u.enabled === false) tr.classList.add('row-disabled');
    tr.addEventListener('click', () => {
        if (_selectedUserRow) _selectedUserRow.classList.remove('row-selected');
        _selectedUserRow = tr;
        tr.classList.add('row-selected');
        showUserDetail(u);
    });
    if (u.title) {
        tr.querySelector('.col-func').addEventListener('click', e => {
            e.stopPropagation();
            openFunctionModal(u.title, siteDn || state.selectedSite?.site.dn);
        });
    }
    return tr;
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
    _detailUserSam = u.samAccountName || null;
    const body = document.querySelector('.explorer-right-body');

    const initials = (() => {
        const parts = (u.displayName || u.samAccountName || '?').trim().split(/\s+/);
        return parts.length >= 2
            ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
            : (parts[0][0] || '?').toUpperCase();
    })();

    const statusHtml = u.enabled === false
        ? '<span class="detail-status detail-disabled">Compte désactivé</span>'
        : '<span class="detail-status detail-enabled">Compte actif</span>';

    // ---- Onglet Détail (champs d'origine) ----
    const scalarFields = [
        { label: 'Identifiant',  value: u.samAccountName },
        { label: 'Fonction',     value: u.title },
        { label: 'Service',      value: u.department },
        { label: 'Description',  value: u.description },
        { label: 'Messagerie',   value: u.mail },
        { label: 'OU',           value: u.ouDn },
    ];

    const paneInfo = `
        <div class="detail-card">
            <div class="detail-avatar">${esc(initials)}</div>
            <div class="detail-name">${esc(u.displayName || u.samAccountName)}</div>
            ${statusHtml}
            <div class="detail-fields">
                ${scalarFields.filter(f => f.value).map(f => `
                    <div class="detail-field">
                        <span class="detail-label">${esc(f.label)}</span>
                        <span class="detail-value">${esc(f.value)}</span>
                    </div>`).join('')}
                ${buildProxyHtml(u)}
            </div>
        </div>`;

    // ---- Onglet MAJ AD (nouveaux champs AD) ----
    const majFields = [
        { label: 'UPN (userPrincipalName)',      key: 'userPrincipalName' },
        { label: 'Type',                         key: 'type' },
        { label: 'Société (company)',             key: 'company' },
        { label: 'Matricule (employeeNumber)',    key: 'employeeNumber' },
        { label: 'Fonction (title)',              key: 'title' },
        { label: 'Responsable (manager)',         key: 'manager' },
        { label: 'Service (department)',          key: 'department' },
        { label: 'Bureau (office)',               key: 'office' },
        { label: 'extensionAttribute1',           key: 'extensionAttribute1' },
        { label: 'Code postal (postalCode)',      key: 'postalCode' },
        { label: 'Adresse (streetAddress)',       key: 'streetAddress' },
    ];

    const paneMaj = `
        <div class="detail-card">
            <div class="detail-avatar">${esc(initials)}</div>
            <div class="detail-name">${esc(u.displayName || u.samAccountName)}</div>
            ${statusHtml}
            <div class="detail-fields">
                ${majFields.filter(f => u[f.key]).map(f => `
                    <div class="detail-field">
                        <span class="detail-label">${esc(f.label)}</span>
                        <span class="detail-value">${esc(u[f.key])}</span>
                    </div>`).join('')}
            </div>
        </div>`;

    body.innerHTML = `
        <div class="detail-tabs">
            <span class="detail-tab active" data-tab="info">Détail</span>
            <span class="detail-tab" data-tab="maj">MAJ AD</span>
        </div>
        <div class="detail-tab-pane active" data-pane="info">${paneInfo}</div>
        <div class="detail-tab-pane" data-pane="maj">${paneMaj}</div>`;

    body.querySelectorAll('.detail-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            body.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
            body.querySelectorAll('.detail-tab-pane').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            body.querySelector(`.detail-tab-pane[data-pane="${tab.dataset.tab}"]`).classList.add('active');
        });
    });
}

function renderUsers(users) { displayUsers(users); }

function setTableLoading() {
    document.getElementById('users-tbody').innerHTML =
        '<tr><td colspan="5" class="td-loading">Chargement…</td></tr>';
}

function setTableError(msg) {
    document.getElementById('users-tbody').innerHTML =
        `<tr><td colspan="5" class="td-hint" style="color:#dc2626">Erreur : ${esc(msg)}</td></tr>`;
}

// ============================================================
//  Filtrage des utilisateurs (saisie temps réel)
// ============================================================
function setupSearch() {
    const treeInput = document.getElementById('tree-search');
    const userInput = document.getElementById('user-filter');

    let treeTimer, userTimer;

    const clearBtn = document.getElementById('tree-search-clear');

    treeInput.addEventListener('focus', () => treeInput.select());

    treeInput.addEventListener('input', () => {
        clearBtn.hidden = treeInput.value.trim() === '';
        clearTimeout(treeTimer);
        treeTimer = setTimeout(() => filterTree(treeInput.value.trim()), 150);
    });

    clearBtn.addEventListener('click', () => {
        treeInput.value = '';
        clearBtn.hidden = true;
        filterTree('');
        clearDetailPanel();
        treeInput.focus();
    });

    const userClearBtn = document.getElementById('user-filter-clear');

    userInput.addEventListener('focus', () => userInput.select());

    userInput.addEventListener('input', () => {
        userClearBtn.hidden = userInput.value.trim() === '';
        clearTimeout(userTimer);
        userTimer = setTimeout(() => filterUsers(userInput.value.trim()), 150);
    });

    userClearBtn.addEventListener('click', () => {
        userInput.value = '';
        userClearBtn.hidden = true;
        filterUsers('');
        userInput.focus();
    });
}

function filterTree(q) {
    if (q) {
        renderCrossSiteResults(q);
    } else {
        // Restaurer la sidebar : tout afficher, tout replier
        document.querySelectorAll('.tree-region').forEach(regionEl => {
            regionEl.style.display = '';
            regionEl.classList.remove('expanded');
            regionEl.querySelectorAll('.tree-site').forEach(siteEl => {
                siteEl.classList.remove('hidden', 'search-match');
            });
        });
        updateToggleTreeBtn();
        restoreMainPanel();
    }
}

function clearDetailPanel() {
    if (_selectedUserRow) { _selectedUserRow.classList.remove('row-selected'); _selectedUserRow = null; }
    _detailUserSam = null;
    document.querySelector('.explorer-right-body').innerHTML = '<p class="hint">Sélectionner un utilisateur</p>';
}

function renderCrossSiteResults(q, preserveScroll) {
    clearDetailPanel();
    const lq      = q.toLowerCase();
    const results = [];
    const seenDns = new Set();

    // Sites cachés : match par utilisateur OU par nom de site
    for (const [dn, users] of Object.entries(allSiteUsers)) {
        const siteName    = dnNameMap[dn] || dn;
        const siteMatches = siteName.toLowerCase().includes(lq);
        const matchUsers  = siteMatches ? users : users.filter(u => matchesFilter(u, lq));
        if (siteMatches || matchUsers.length > 0) {
            results.push({ dn, siteName, users: matchUsers, uncached: false });
            seenDns.add(dn);
        }
    }

    // Sites non cachés : match par nom de site uniquement
    for (const [dn, siteName] of Object.entries(dnNameMap)) {
        if (!seenDns.has(dn) && siteName.toLowerCase().includes(lq)) {
            results.push({ dn, siteName, users: [], uncached: true });
        }
    }

    results.sort((a, b) => a.siteName.localeCompare(b.siteName, 'fr'));

    // Sidebar : afficher uniquement les sites avec des résultats
    const matchingDns = new Set(results.map(r => r.dn));
    document.querySelectorAll('.tree-region').forEach(regionEl => {
        let regionVisible = false;
        regionEl.querySelectorAll('.tree-site').forEach(siteEl => {
            const match = matchingDns.has(siteEl.dataset.dn);
            siteEl.classList.toggle('hidden', !match);
            siteEl.classList.toggle('search-match', match);
            if (match) regionVisible = true;
        });
        regionEl.style.display = regionVisible ? '' : 'none';
        if (regionVisible) regionEl.classList.add('expanded');
    });
    updateToggleTreeBtn();

    const totalCached  = Object.keys(allSiteUsers).length;
    const totalSites   = Object.keys(dnNameMap).length;
    const totalUsers   = results.filter(r => !r.uncached).reduce((s, r) => s + r.users.length, 0);
    const uncachedHits = results.filter(r => r.uncached).length;

    document.getElementById('current-site-name').textContent = `Recherche : "${q}"`;
    document.getElementById('user-filter').disabled          = true;
    document.getElementById('group-by').disabled             = true;

    const cachedLabel = totalCached < totalSites
        ? ` <span class="search-cache-hint">(${totalCached}/${totalSites} sites en cache)</span>`
        : '';
    const uncachedLabel = uncachedHits > 0
        ? ` · <span class="search-cache-hint">${uncachedHits} site(s) non chargé(s)</span>`
        : '';
    document.getElementById('user-count').innerHTML = results.length
        ? `${totalUsers} résultat(s) dans ${results.length} site(s)${cachedLabel}${uncachedLabel}`
        : `Aucun résultat${cachedLabel}`;

    const tbody = document.getElementById('users-tbody');
    tbody.innerHTML = '';

    if (results.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="td-hint">Aucun résultat trouvé</td></tr>';
        return;
    }

    const frag = document.createDocumentFragment();
    for (const { siteName, dn, users, uncached } of results) {
        const headerTr = document.createElement('tr');
        headerTr.className = 'group-header';
        headerTr.dataset.dn = dn;
        headerTr.innerHTML = `
            <td colspan="5">
                <span class="group-toggle ${uncached ? '' : 'expanded'}">▼</span>
                <span class="group-label">${hlText(siteName, lq)}</span>
                <span class="group-count">${uncached ? '?' : users.length}</span>
                ${uncached ? '<span class="search-uncached-badge">non chargé — cliquer pour ouvrir</span>' : ''}
            </td>`;
        if (uncached) {
            headerTr.addEventListener('click', () => {
                const siteEl = document.querySelector(`.tree-site[data-dn="${CSS.escape(dn)}"]`);
                if (siteEl) siteEl.click();
            });
        } else {
            headerTr.addEventListener('click', () => toggleGroupRows(headerTr));
        }
        frag.appendChild(headerTr);

        if (uncached) {
            const tr = document.createElement('tr');
            tr.className = 'group-member';
            tr.innerHTML = `<td colspan="5" class="td-hint search-uncached-hint">Cache non disponible · cliquer sur le nom du site ci-dessus pour charger</td>`;
            frag.appendChild(tr);
        } else {
            for (const u of users.sort((a, b) =>
                    (a.displayName || '').localeCompare(b.displayName || '', 'fr'))) {
                const tr = createUserRow(u, dn);
                tr.classList.add('group-member');
                tr.querySelector('.col-name').innerHTML =
                    hlText(u.displayName || u.samAccountName || '', lq) +
                    (u.enabled === false ? '<span class="tag-disabled">désactivé</span>' : '');
                tr.querySelector('.col-desc').innerHTML = hlText(u.description || '', lq);
                tr.querySelector('.col-func').innerHTML = hlText(u.title       || '', lq);
                tr.querySelector('.col-mail').innerHTML = hlText(u.mail        || '', lq);
                tr.querySelector('.col-dept').innerHTML = hlText(u.department  || '', lq);
                frag.appendChild(tr);
            }
        }
    }
    tbody.appendChild(frag);
}

function restoreMainPanel() {
    if (state.selectedSite) {
        const { site } = state.selectedSite;
        document.getElementById('user-filter').disabled = false;
        document.getElementById('group-by').disabled    = false;
        renderUsers(state.allUsers);
        updateSiteHeader(site, state.allUsers.length, false);
    } else {
        document.getElementById('current-site-name').textContent = 'Sélectionner un site';
        document.getElementById('user-count').textContent        = '';
        document.getElementById('users-tbody').innerHTML         = '';
    }
}

function hlText(text, q) {
    if (!text) return '';
    if (!q)    return esc(text);
    const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re    = new RegExp(`(${safeQ})`, 'gi');
    return text.split(re).map((part, i) =>
        i % 2 === 1 ? `<mark class="hl">${esc(part)}</mark>` : esc(part)
    ).join('');
}

function matchesFilter(u, lq) {
    return (u.displayName  || '').toLowerCase().includes(lq) ||
           (u.mail         || '').toLowerCase().includes(lq) ||
           (u.department   || '').toLowerCase().includes(lq) ||
           (u.title        || '').toLowerCase().includes(lq) ||
           (u.description  || '').toLowerCase().includes(lq);
}

function filterUsers(q) {
    const filtered = q ? state.allUsers.filter(u => matchesFilter(u, q.toLowerCase())) : state.allUsers;
    displayUsers(filtered);
    document.getElementById('user-count').textContent = q
        ? `${filtered.length} / ${state.allUsers.length} utilisateur(s)`
        : `${state.allUsers.length} utilisateur(s)`;
}

// ============================================================
//  Tri des colonnes
// ============================================================
function setupSort() {
    document.querySelectorAll('.users-table th.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.col;
            if (state.sortCol === col) {
                state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
            } else {
                state.sortCol = col;
                state.sortDir = 'asc';
            }
            resetSortIcons();
            th.classList.add(`sort-${state.sortDir}`);

            const q = document.getElementById('user-filter').value.trim().toLowerCase();
            const source = q
                ? state.allUsers.filter(u => matchesFilter(u, q))
                : state.allUsers;
            displayUsers(getSortedUsers(source));
        });
    });
}

function getSortedUsers(users) {
    return [...users].sort((a, b) => {
        const va = (a[state.sortCol] || '').toLowerCase();
        const vb = (b[state.sortCol] || '').toLowerCase();
        const cmp = va.localeCompare(vb, 'fr');
        return state.sortDir === 'asc' ? cmp : -cmp;
    });
}

function resetSortIcons() {
    document.querySelectorAll('.users-table th.sortable').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
    });
}

// ============================================================
//  Modal Fonction
// ============================================================

let _modalTitle        = '';
let _modalSiteDn       = '';
let _modalActiveTitles = new Set();

function setupFunctionModal() {
    const modal = document.getElementById('function-modal');
    document.getElementById('modal-close').addEventListener('click', () => { modal.hidden = true; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') modal.hidden = true; });
    document.getElementById('btn-create-rule').addEventListener('click', createRuleFromModal);
    modal.querySelectorAll('.modal-level').forEach(btn => {
        btn.addEventListener('click', () => {
            modal.querySelectorAll('.modal-level').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const level = parseInt(btn.dataset.level);
            renderModalResults(getModalGroups(level), level);
        });
    });
}

function createRuleFromModal() {
    const titles = _modalActiveTitles.size > 0 ? [..._modalActiveTitles] : [_modalTitle];
    const draft  = {
        label:      _modalTitle,
        niveau:     3,
        conditions: {
            include: titles.map(t => ({ field: 'title', op: 'eq', value: t })),
            exclude: [],
        },
    };
    localStorage.setItem('regles_draft', JSON.stringify(draft));
    if (window !== window.top) {
        window.top.switchTab('regles');
    } else {
        window.open('/regles', 'i2n-regles');
    }
}

function openFunctionModal(title, siteDn) {
    _modalTitle        = title;
    _modalSiteDn       = siteDn;
    _modalActiveTitles = new Set([title]);

    document.getElementById('modal-function-title').textContent = title;

    populateModalFilterBar(title);
    refreshModalLevelCounts();

    document.querySelectorAll('.modal-level').forEach(b => b.classList.remove('active'));
    document.querySelector('.modal-level[data-level="1"]').classList.add('active');
    renderModalResults(getModalGroups(1), 1);

    document.getElementById('function-modal').hidden = false;
}

// Cherche les fonctions similaires à partir de tous les sites en cache
function findSimilarTitles(mainTitle) {
    const stopWords = new Set(['de','du','la','le','les','des','en','et','d','l','au','aux','sur','par','pour','un','une']);
    const norm      = s => s.toLowerCase().trim();
    const words     = s => norm(s).split(/[\s\-\/]+/).filter(w => w.length >= 3 && !stopWords.has(w));

    const mainNorm  = norm(mainTitle);
    const mainWords = words(mainTitle);

    const titleCounts = new Map();
    for (const users of Object.values(allSiteUsers)) {
        for (const u of users) {
            if (u.title) titleCounts.set(u.title, (titleCounts.get(u.title) || 0) + 1);
        }
    }

    const scored = [];
    for (const [title] of titleCounts) {
        const tNorm  = norm(title);
        const tWords = words(title);
        let score;
        if (tNorm === mainNorm) {
            score = 3;
        } else if (tNorm.includes(mainNorm) || mainNorm.includes(tNorm)) {
            score = 2;
        } else {
            const shared = tWords.filter(w => mainWords.some(m => m === w || m.startsWith(w) || w.startsWith(m)));
            score = shared.length / Math.max(mainWords.length, tWords.length, 1);
        }
        if (score > 0) scored.push({ title, score });
    }

    return scored
        .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'fr'))
        .map(s => ({ title: s.title, count: titleCounts.get(s.title) || 0 }));
}

function populateModalFilterBar(mainTitle) {
    const bar      = document.getElementById('modal-filter-bar');
    const similar  = findSimilarTitles(mainTitle);

    bar.innerHTML = '';
    if (similar.length <= 1) { bar.hidden = true; return; }
    bar.hidden = false;

    for (const { title: t, count } of similar) {
        const chip = document.createElement('label');
        chip.className = 'modal-func-chip' + (t === mainTitle ? ' active' : '');

        const cb = document.createElement('input');
        cb.type    = 'checkbox';
        cb.checked = t === mainTitle;
        cb.value   = t;
        cb.addEventListener('change', () => {
            if (cb.checked) { _modalActiveTitles.add(t); chip.classList.add('active'); }
            else            { _modalActiveTitles.delete(t); chip.classList.remove('active'); }
            refreshModalLevelCounts();
            const activeLevel = parseInt(document.querySelector('.modal-level.active')?.dataset.level || '1');
            renderModalResults(getModalGroups(activeLevel), activeLevel);
        });

                const lbl = document.createElement('span');
        lbl.className   = 'chip-label';
        lbl.textContent = t;

        const badge = document.createElement('span');
        badge.className   = 'chip-count';
        badge.textContent = count;

        chip.appendChild(cb);
        chip.appendChild(lbl);
        chip.appendChild(badge);
        bar.appendChild(chip);
    }
}

function refreshModalLevelCounts() {
    [1, 2, 3].forEach(lvl => {
        const groups = getModalGroups(lvl);
        const count  = groups.reduce((s, g) => s + g.users.length, 0);
        document.getElementById('modal-count-' + lvl).textContent = count + ' utilisateur(s)';
    });
}

function findRegionForSite(dn) {
    for (const region of state.treeData) {
        if ((region.children || []).some(s => s.dn === dn)) return region;
    }
    return null;
}

function getModalGroups(level) {
    const siteDn = _modalSiteDn;

    // Construire la liste des sites candidats selon le niveau
    let candidates = [];
    if (level === 1) {
        candidates = [{ dn: siteDn, name: dnNameMap[siteDn] || 'Ce centre', region: null }];
    } else if (level === 2) {
        const region = findRegionForSite(siteDn);
        if (!region) return [];
        candidates = (region.children || []).map(s => ({ dn: s.dn, name: s.name, region: null }));
    } else if (level === 3) {
        for (const region of state.treeData) {
            for (const site of (region.children || [])) {
                candidates.push({ dn: site.dn, name: site.name, region: region.name });
            }
        }
    }

    // Grouper : fonction → [DO] → centre
    const result = [];
    for (const activeTitle of _modalActiveTitles) {
        const matchTitle = u => (u.title || '').toLowerCase() === activeTitle.toLowerCase();
        for (const { dn, name, region } of candidates) {
            const pool  = dn === siteDn && level === 1
                ? (allSiteUsers[dn] || state.allUsers || [])
                : (allSiteUsers[dn] || []);
            const users = pool.filter(matchTitle);
            if (users.length) result.push({ label: activeTitle, region, sub: name, users });
        }
    }
    return result;
}

function renderModalResults(groups, level) {
    const container = document.getElementById('modal-results');
    if (!groups.length) {
        container.innerHTML = '<div class="modal-empty">Aucun utilisateur trouvé</div>';
        return;
    }

    const frag = document.createDocumentFragment();
    const needToggleBar = groups.length > 1 || groups.some(g => g.sub || g.region);

    if (needToggleBar) {
        const bar = document.createElement('div');
        bar.className = 'modal-toggle-bar';
        const btn = document.createElement('button');
        btn.className = 'modal-toggle-all-btn';
        btn.textContent = 'Tout fermer';
        btn.dataset.open = '1';
        btn.addEventListener('click', () => {
            const closing = btn.dataset.open === '1';
            container.querySelectorAll('.modal-group-body, .modal-do-body, .modal-sub-body').forEach(b => { b.hidden = closing; });
            container.querySelectorAll('.modal-caret').forEach(c => { c.textContent = closing ? '▶' : '▼'; });
            btn.textContent = closing ? 'Tout ouvrir' : 'Tout fermer';
            btn.dataset.open = closing ? '0' : '1';
        });
        bar.appendChild(btn);
        frag.appendChild(bar);
    }

    // Regrouper par label (fonction)
    const byLabel = new Map();
    for (const g of groups) {
        if (!byLabel.has(g.label)) byLabel.set(g.label, []);
        byLabel.get(g.label).push(g);
    }

    for (const [label, items] of byLabel) {
        const labelTotal = items.reduce((s, i) => s + i.users.length, 0);

        const groupWrap = document.createElement('div');
        groupWrap.className = 'modal-group-wrap';
        const groupBody = document.createElement('div');
        groupBody.className = 'modal-group-body';

        const groupHdr = document.createElement('div');
        groupHdr.className = 'modal-group-hdr';
        groupHdr.innerHTML =
            `<span class="modal-caret">▼</span>` +
            `<span class="modal-hdr-label">${esc(label)}</span>` +
            `<span class="modal-hdr-count">${labelTotal}</span>`;
        groupHdr.addEventListener('click', () => toggleModalBody(groupHdr, groupBody));
        groupWrap.appendChild(groupHdr);
        groupWrap.appendChild(groupBody);
        frag.appendChild(groupWrap);

        const hasRegion = items.some(i => i.region);

        if (hasRegion) {
            // Niveau 3 : fonction → DO → centre
            const byRegion = new Map();
            for (const item of items) {
                const r = item.region || '';
                if (!byRegion.has(r)) byRegion.set(r, []);
                byRegion.get(r).push(item);
            }

            for (const [region, regionItems] of byRegion) {
                const regionTotal = regionItems.reduce((s, i) => s + i.users.length, 0);

                const doWrap = document.createElement('div');
                doWrap.className = 'modal-do-wrap';
                const doBody = document.createElement('div');
                doBody.className = 'modal-do-body';

                const doHdr = document.createElement('div');
                doHdr.className = 'modal-do-hdr';
                doHdr.innerHTML =
                    `<span class="modal-caret">▼</span>` +
                    `<span class="modal-hdr-label">${esc(region)}</span>` +
                    `<span class="modal-hdr-count">${regionTotal}</span>`;
                doHdr.addEventListener('click', () => toggleModalBody(doHdr, doBody));
                doWrap.appendChild(doHdr);
                doWrap.appendChild(doBody);
                groupBody.appendChild(doWrap);

                const sorted = [...regionItems].sort((a, b) => (a.sub || '').localeCompare(b.sub || '', 'fr'));
                for (const { sub, users } of sorted) {
                    appendSiteBlock(sub, users, doBody);
                }
            }
        } else {
            // Niveaux 1 & 2 : fonction → centre
            const sorted = [...items].sort((a, b) => (a.sub || '').localeCompare(b.sub || '', 'fr'));
            for (const { sub, users } of sorted) {
                appendSiteBlock(sub, users, groupBody);
            }
        }
    }

    container.innerHTML = '';
    container.appendChild(frag);
}

function appendSiteBlock(sub, users, parentBody) {
    if (!sub) { appendUsersGrouped(users, parentBody); return; }

    const subWrap = document.createElement('div');
    subWrap.className = 'modal-sub-wrap';
    const subBody = document.createElement('div');
    subBody.className = 'modal-sub-body';

    const subHdr = document.createElement('div');
    subHdr.className = 'modal-sub-hdr';
    subHdr.innerHTML =
        `<span class="modal-caret">▼</span>` +
        `<span class="modal-hdr-label">${esc(sub)}</span>` +
        `<span class="modal-hdr-count">${users.length}</span>`;
    subHdr.addEventListener('click', () => toggleModalBody(subHdr, subBody));

    appendUsersGrouped(users, subBody);
    subWrap.appendChild(subHdr);
    subWrap.appendChild(subBody);
    parentBody.appendChild(subWrap);
}

function toggleModalBody(hdr, body) {
    body.hidden = !body.hidden;
    hdr.querySelector('.modal-caret').textContent = body.hidden ? '▶' : '▼';
}

const FUNC_COLORS = ['fc0','fc1','fc2','fc3','fc4','fc5','fc6','fc7'];

function funcColorClass(title) {
    if (!title) return '';
    let h = 0;
    for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
    return FUNC_COLORS[h % FUNC_COLORS.length];
}

// Trie par titre puis par nom, insère un séparateur quand le titre change (si multi-titres)
function appendUsersGrouped(users, container) {
    const sorted = [...users].sort((a, b) =>
        (a.title || '').localeCompare(b.title || '', 'fr') ||
        (a.displayName || '').localeCompare(b.displayName || '', 'fr')
    );
    const multiTitle = new Set(sorted.map(u => u.title || '')).size > 1;
    let lastTitle = null;

    for (const u of sorted) {
        const t = u.title || '';
        if (multiTitle && t !== lastTitle) {
            const sep = document.createElement('div');
            sep.className = 'modal-title-sep ' + funcColorClass(t);
            sep.textContent = t || '(sans fonction)';
            container.appendChild(sep);
            lastTitle = t;
        }
        container.appendChild(createModalUserRow(u));
    }
}

function createModalUserRow(u) {
    const row = document.createElement('div');
    row.className = 'modal-user-row';
    const cc = funcColorClass(u.title);
    row.innerHTML =
        `<span class="modal-user-name">${esc(u.displayName || u.samAccountName)}</span>` +
        `<span class="modal-user-dept">${esc(u.department || '')}</span>`;
    return row;
}

// ============================================================
//  Utilitaires
// ============================================================
async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

function esc(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let toastTimer;
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3500);
}
