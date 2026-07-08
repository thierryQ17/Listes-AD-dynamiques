'use strict';
// Onglet « GROUPES » : une page HTML par règle, menu vertical repliable à gauche.
// Rendu STRICTEMENT identique à l'aperçu (buildGroupsHtmlDoc de groups-doc.js).
//
// Cache PAR PAGE : chaque règle produit <label>.html + <label>.sig (sa signature). Une page est
// relue du cache tant que sa signature (version + cache AD + règle) n'a pas changé. Pas de reset
// ni de commit global → robuste, jamais de régénération inutile, sûr même si on ferme en cours.
//
// Rendu PARESSEUX : seul l'onglet actif se charge ; les autres au clic. Un remplissage doux
// (1 page à la fois) complète le cache en arrière-plan sans saturer le serveur.
(function () {
    const tablist = document.getElementById('ag-tablist');
    const content = document.getElementById('ag-content');
    const emptyEl = document.getElementById('ag-empty');
    const sidebar = document.getElementById('ag-sidebar');

    let rules = [];
    const rulesById = {};
    const state = {};       // ruleId -> { rule, data, html, pending, rendered, useCache, sig, tabEl, frameEl, cntEl }
    let activeId = null;
    let pageCounts = {};    // { safeFileName(label): nb de groupes } — compteurs mis en cache par le serveur

    // ── Menu groupé par rubrique + accordéon (identique à l'onglet Règles) ──
    let rubriques = [];
    let groupByRubrique = (() => { try { const v = localStorage.getItem('ag_group_rubrique'); return v === null ? true : v === '1'; } catch { return true; } })();
    let expandedRubriques = (() => {
        try { const raw = localStorage.getItem('ag_expanded_rubriques'); return raw === null ? undefined : new Set(JSON.parse(raw || '[]')); }
        catch { return undefined; }
    })();
    function saveExpanded() { try { localStorage.setItem('ag_expanded_rubriques', JSON.stringify(expandedRubriques instanceof Set ? [...expandedRubriques] : [])); } catch { /* ignore */ } }

    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const byLabelFr = (a, b) => String(a.label || '').localeCompare(String(b.label || ''), 'fr', { sensitivity: 'base' });
    const miniOf = s => String(s).split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 3).toUpperCase();
    function sortedRubriques() { return [...rubriques].sort((a, b) => (a.ordre || 0) - (b.ordre || 0)); }
    function orderRulesInRubrique(items, rub) {
        const ord  = (rub && Array.isArray(rub.ruleOrder)) ? rub.ruleOrder : [];
        const rank = id => { const i = ord.indexOf(id); return i < 0 ? 1e9 : i; };
        return [...items].sort((a, b) => (rank(a.id) - rank(b.id)) || byLabelFr(a, b));
    }
    function groupKeysFromData() {
        const known = new Set(rubriques.map(r => r.id));
        const keys = new Set(); let hasUnclassed = false;
        for (const r of rules) { if (r.rubriqueId && known.has(r.rubriqueId)) keys.add(r.rubriqueId); else hasUnclassed = true; }
        if (hasUnclassed) keys.add('__none__');
        return [...keys];
    }

    const AG_CHEVRON = '<svg class="ag-rub-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

    // (Re)construit le menu en ré-utilisant les onglets déjà créés (state[id].tabEl).
    function renderMenu() {
        tablist.innerHTML = '';
        tablist.classList.toggle('by-rubrique', groupByRubrique);

        if (groupByRubrique) {
            const groups = sortedRubriques().map(rub => ({
                key: rub.id, label: rub.label, rub, items: rules.filter(r => r.rubriqueId === rub.id),
            })).sort(byLabelFr);
            const known     = new Set(rubriques.map(r => r.id));
            const unclassed = rules.filter(r => !r.rubriqueId || !known.has(r.rubriqueId));
            if (unclassed.length) groups.push({ key: '__none__', label: 'Non classé', rub: null, items: unclassed });

            if (expandedRubriques === undefined) {
                const first = groups.find(g => g.items.length)?.key;
                expandedRubriques = new Set(first ? [first] : []);
            }

            for (const g of groups) {
                if (!g.items.length) continue;
                const block = document.createElement('div');
                block.className = 'ag-rub-block' + (expandedRubriques.has(g.key) ? '' : ' collapsed');
                block.dataset.key = g.key;

                const hdr = document.createElement('div');
                hdr.className = 'ag-rub-hdr' + (g.key === '__none__' ? ' unclassed' : '');
                hdr.innerHTML =
                    '<span class="ag-rub-hdr-left">' + AG_CHEVRON +
                        '<span class="ag-rub-lbl">' + esc(g.label) + '</span>' +
                        '<span class="ag-rub-mini" title="' + esc(g.label) + '">' + esc(miniOf(g.label)) + '</span>' +
                    '</span>' +
                    '<span class="ag-rub-cnt">' + g.items.length + '</span>';
                hdr.addEventListener('click', () => toggleRubriqueAccordion(g.key));
                block.appendChild(hdr);

                const wrap = document.createElement('div');
                wrap.className = 'ag-rub-items';
                const ordered   = orderRulesInRubrique(g.items, g.rub);
                const activeN   = ordered.filter(r => r.active !== false);
                const inactiveN = ordered.filter(r => r.active === false);
                for (const r of activeN)   if (state[r.id]) wrap.appendChild(state[r.id].tabEl);
                for (const r of inactiveN) if (state[r.id]) wrap.appendChild(state[r.id].tabEl);
                block.appendChild(wrap);
                tablist.appendChild(block);
            }
            updateCycleBtn();
            return;
        }

        // Vue à plat : actives triées A→Z, puis inactives.
        const active   = rules.filter(r => r.active !== false).sort(byLabelFr);
        const inactive = rules.filter(r => r.active === false).sort(byLabelFr);
        for (const r of active)   if (state[r.id]) tablist.appendChild(state[r.id].tabEl);
        for (const r of inactive) if (state[r.id]) tablist.appendChild(state[r.id].tabEl);
        updateCycleBtn();
    }

    // Accordéon STRICT : clic sur un en-tête → n'ouvre que celui-ci (referme les autres).
    function toggleRubriqueAccordion(key) {
        if (expandedRubriques.has(key) && expandedRubriques.size === 1) expandedRubriques = new Set();
        else expandedRubriques = new Set([key]);
        saveExpanded();
        renderMenu();
    }

    // Bouton unique cyclique : Ouvrir → Fermer → À plat (l'icône = action du prochain clic).
    function nextViewAction() {
        if (!groupByRubrique) return 'expand';
        const keys = groupKeysFromData();
        const exp  = expandedRubriques instanceof Set ? expandedRubriques : new Set();
        const allOpen = keys.length > 0 && keys.every(k => exp.has(k));
        return allOpen ? 'collapse' : 'flat';
    }
    function cycleView() {
        const act = nextViewAction();
        if (act === 'expand') {
            groupByRubrique = true;
            try { localStorage.setItem('ag_group_rubrique', '1'); } catch { /* ignore */ }
            expandedRubriques = new Set(groupKeysFromData());
            saveExpanded();
        } else if (act === 'collapse') {
            expandedRubriques = new Set();
            saveExpanded();
        } else {
            groupByRubrique = false;
            try { localStorage.setItem('ag_group_rubrique', '0'); } catch { /* ignore */ }
        }
        renderMenu();
    }
    function updateCycleBtn() {
        const btn = document.getElementById('ag-cycle');
        if (!btn) return;
        const act = nextViewAction();
        btn.classList.remove('act-expand', 'act-collapse', 'act-flat');
        btn.classList.add('act-' + act);
        btn.title = act === 'expand' ? 'Grouper et tout déplier' : act === 'collapse' ? 'Tout replier' : 'Liste à plat';
    }

    // ── Repli du menu (comme la sidebar Règles) ──
    const COLLAPSE_KEY = 'ag_sidebar_collapsed';
    function applyCollapsed(c) {
        sidebar.classList.toggle('collapsed', c);
        const ic  = document.getElementById('ag-collapse-ic');
        const btn = document.getElementById('ag-collapse');
        if (ic)  ic.style.transform = c ? 'rotate(180deg)' : '';
        if (btn) btn.title = c ? 'Déplier le menu' : 'Réduire le menu';
    }
    let collapsed = false;
    try { collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { /* ignore */ }
    applyCollapsed(collapsed);
    document.getElementById('ag-collapse').addEventListener('click', () => {
        collapsed = !collapsed;
        try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
        applyCollapsed(collapsed);
    });
    document.getElementById('ag-refresh').addEventListener('click', () => refreshAll());
    document.getElementById('ag-fullscreen').addEventListener('click', () => {
        // Appel DIRECT (même origine) sur le document du shell → le geste utilisateur est conservé.
        try {
            const doc = window.top.document;
            if (doc.fullscreenElement) doc.exitFullscreen();
            else doc.documentElement.requestFullscreen();
        } catch { /* fallback : plein écran de l'iframe */ try { document.documentElement.requestFullscreen(); } catch { /* ignore */ } }
    });

    // ── Utilitaires ──
    function initials(l) { return (l || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?'; }
    // Nom de fichier = label de la règle (miroir de Get-SafeFileName côté serveur)
    function safeFileName(s) {
        s = (s == null ? '' : String(s));
        if (!s.trim()) return 'SANS-NOM';
        const out = s.replace(/[<>:"/\\|?*]/g, ' ').replace(/\s{2,}/g, ' ').trim().replace(/^\.+|\.+$/g, '').trim();
        return out || 'SANS-NOM';
    }
    const cachePageUrl = rule => '/api/groupes/html-cache/page?name=' + encodeURIComponent(rule.label || '');

    function activate(id) {
        activeId = id;
        Object.values(state).forEach(s => {
            const on = s.rule.id === id;
            s.tabEl.classList.toggle('active', on);
            s.frameEl.classList.toggle('active', on);
        });
        const s = state[id];
        if (s) s.tabEl.scrollIntoView({ block: 'nearest' });
        render(id);
    }

    async function ensureData(id) {
        const s = state[id];
        if (!s || s.data) return s ? s.data : null;
        try {
            const r = await fetch('/api/regles/preview-groups', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(s.rule),
            });
            const data = await r.json();
            s.data = (data && data.error) ? { error: data.error } : (data || { error: 'Réponse vide' });
        } catch { s.data = { error: 'Erreur de chargement des groupes' }; }
        return s.data;
    }

    function saveCache(rule, html, count) {
        return fetch('/api/groupes/html-cache', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ name: rule.label, count, html }),
        }).catch(() => { /* best-effort */ });
    }

    function placeholderDoc(rule) {
        return '<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:15px \'Segoe UI\',system-ui,sans-serif;color:#6b7280;background:#f4f5f7;text-align:center">' +
            '<div>Page non générée pour <b>' + (rule.label || '') + '</b>.<br><br>' +
            'Cliquez sur <b>⟳ Rafraîchir</b> (en haut du menu) pour générer toutes les pages.</div></body>';
    }

    // Rendu : lecture du cache UNIQUEMENT (aucune génération à l'activation). Sinon → placeholder.
    function render(id) {
        const s = state[id];
        if (!s || s.rendered) return;
        // ⚠ srcdoc a PRIORITÉ sur src : toujours retirer l'attribut opposé avant de basculer,
        // sinon un placeholder (srcdoc) déjà posé empêche l'affichage de la page en cache (src).
        if (s.useCache) { s.frameEl.removeAttribute('srcdoc'); s.frameEl.src = cachePageUrl(s.rule); }
        else            { s.frameEl.removeAttribute('src');    s.frameEl.srcdoc = placeholderDoc(s.rule); }
        s.rendered = true;
    }

    // Bandeau bloquant sur TOUTE l'application (géré par le shell) pendant la génération.
    function setOverlay(on) {
        try { window.top.postMessage({ type: 'groupes-generating', on: !!on }, '*'); } catch { /* hors iframe */ }
    }

    function postProgress(done, total, label) {
        try { window.top.postMessage({ type: 'groupes-progress', done, total, label }, '*'); } catch { /* hors iframe */ }
    }

    // Génère (ou régénère) les pages des règles listées, bandeau bloquant + barre de progression.
    async function generatePages(ids) {
        if (!ids.length) return;
        const total = ids.length;
        let done = 0;
        setOverlay(true);
        postProgress(0, total, '');
        await new Promise(r => setTimeout(r, 60));   // laisse le bandeau s'afficher avant de bloquer
        try {
            const queue = ids.slice();
            const CONC  = 3;   // = threads Pode
            async function worker() {
                while (queue.length) {
                    const id = queue.shift();
                    const s  = state[id];
                    if (!s) continue;
                    postProgress(done, total, s.rule.label);   // groupe en cours de création
                    s.data = null; s.html = null;
                    const data = await ensureData(id);
                    if (data && !data.error) {
                        const count = (data.groups || []).length;   // = nombre de groupes, mis en cache (.sig)
                        try { s.html = buildGroupsHtmlDoc(data, s.rule); } catch { s.html = null; }
                        if (s.html) {
                            await saveCache(s.rule, s.html, count);
                            s.useCache = true;
                            pageCounts[safeFileName(s.rule.label)] = count;
                            s.cntEl.textContent = count;             // pastille à jour tout de suite
                        }
                    }
                    done++;
                    postProgress(done, total, s.rule.label);
                }
            }
            await Promise.all(Array.from({ length: CONC }, worker));
        } finally {
            setOverlay(false);
        }
        // Recharge les iframes depuis le cache fraîchement écrit (seul l'actif tout de suite)
        Object.values(state).forEach(s => { s.rendered = false; try { s.frameEl.removeAttribute('srcdoc'); s.frameEl.src = 'about:blank'; } catch { /* ignore */ } });
        render(activeId);
    }

    // Bouton ⟳ Rafraîchir : régénère TOUTES les pages (avec confirmation).
    async function refreshAll() {
        if (!window.confirm('Regénérer TOUTES les pages HTML des groupes ?\n\nL’application sera bloquée le temps de la génération.')) return;
        await generatePages(rules.map(r => r.id));
    }

    // fetch JSON avec timeout (évite tout blocage indéfini si le serveur est lent/saturé)
    function fetchJson(url, fallback) {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20000);
        return fetch(url, { signal: ctrl.signal }).then(r => r.json()).catch(() => fallback).finally(() => clearTimeout(timer));
    }

    async function init() {
        // 1) Les RÈGLES d'abord → on construit les onglets tout de suite (indépendant du cache).
        const rr = await fetchJson('/api/regles', []);
        rules = Array.isArray(rr) ? rr : [];
        if (!rules.length) { if (emptyEl) emptyEl.textContent = 'Aucune règle définie.'; return; }
        if (emptyEl) emptyEl.remove();
        rules.forEach(r => { rulesById[r.id] = r; });

        // Rubriques (pour le regroupement du menu) — même source que l'onglet Règles.
        const rub = await fetchJson('/api/rubriques', []);
        rubriques = Array.isArray(rub) ? rub : [];

        rules.forEach(rule => {
            const tab = document.createElement('button');
            tab.className = 'ag-tab' + (rule.active === false ? ' inactive' : '');
            tab.type = 'button';
            tab.title = rule.label || '';
            const ini = document.createElement('span'); ini.className = 'ag-tab-ini'; ini.textContent = initials(rule.label);
            const lbl = document.createElement('span'); lbl.className = 'ag-tab-lbl'; lbl.textContent = rule.label || '(sans nom)';
            const cnt = document.createElement('span'); cnt.className = 'ag-cnt';
            tab.appendChild(ini); tab.appendChild(lbl); tab.appendChild(cnt);
            tab.addEventListener('click', () => activate(rule.id));
            // (les onglets sont placés dans le menu par renderMenu — groupés par rubrique)

            const frame = document.createElement('iframe');
            frame.className = 'ag-frame';
            frame.title = rule.label || '';
            frame.setAttribute('allow', 'fullscreen');
            content.appendChild(frame);

            state[rule.id] = { rule, data: null, html: null, rendered: false, useCache: false, tabEl: tab, frameEl: frame, cntEl: cnt };
        });

        renderMenu();            // place les onglets dans le menu groupé par rubrique (accordéon)
        document.getElementById('ag-cycle')?.addEventListener('click', cycleView);

        activate(rules[0].id);   // affiche l'onglet actif (placeholder pour l'instant)

        // 2) UNE seule requête RAPIDE (~0,2 s) : meta → existence des pages + compteurs mis en cache.
        //    Plus AUCUN appel à /api/regles/counts (le fameux 26 s) : le nombre de groupes vient du cache.
        const mm = await fetchJson('/api/groupes/html-cache/meta', { counts: {} });
        pageCounts = (mm && mm.counts) ? mm.counts : {};

        rules.forEach(rule => {
            const s   = state[rule.id];
            const key = safeFileName(rule.label);
            // Existence = la clé est présente dans meta.counts. Pastille = la valeur (compteur en cache).
            s.useCache = Object.prototype.hasOwnProperty.call(pageCounts, key);
            if (typeof pageCounts[key] === 'number') s.cntEl.textContent = pageCounts[key];
            if (rule.id === activeId && s.useCache) { s.rendered = false; render(rule.id); }
        });

        // Premier chargement : les pages HTML manquantes sont créées automatiquement (bandeau + progression).
        const missing = rules.filter(r => !state[r.id].useCache).map(r => r.id);
        if (missing.length) await generatePages(missing);
    }

    init();
})();
