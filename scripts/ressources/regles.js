'use strict';

let rules      = [];
let editingId  = null;
let activeFormTab = 'params';
let apercuCache = {};   // cache du rendu de l'onglet « Aperçu groupes », par signature de règle
let groupByNiveau = (() => { try { return localStorage.getItem('regles_group_niveau') === '1'; } catch { return false; } })();

const FIELDS = [
    ['title',              'Fonction (title)'],
    ['department',         'Service (department)'],
    ['office',             'Bureau (office)'],
    ['extensionAttribute1','Attribut ext. 1'],
    ['description',        'Description'],
    ['ou',                 "Unité d'organisation (OU)"],
];

const FIELD_LABELS = Object.fromEntries(FIELDS);

const OPS = [
    ['eq',       'est exactement'],
    ['ne',       "n'est pas"],
    ['like',     'contient'],
    ['notlike',  'ne contient pas'],
    ['empty',    'est vide'],
    ['notempty', "n'est pas vide"],
];

// Opérateurs qui ne nécessitent aucune valeur
const NO_VALUE_OPS = new Set(['empty', 'notempty']);

const NIV_LABELS = { 1: 'Global', 2: 'Par DO', 3: 'Par centre' };
const NIV_CSV    = { 1: '1 CSV global', 2: '2 CSV (DO + global)', 3: '3 CSV (centre + DO + global)' };
const NIV_DESCRIPTIONS = {
    1: `Un seul CSV avec tous les utilisateurs correspondants.<br>→ <strong>1 groupe AD global</strong> dont les membres sont les utilisateurs directement.`,
    2: `1 CSV par Direction Opérationnelle + 1 CSV global.<br>→ <strong>Groupes DO</strong> (membres = utilisateurs) + <strong>1 groupe global</strong> (membres = groupes DO).`,
    3: `1 CSV par centre + 1 CSV par DO + 1 CSV global.<br>→ <strong>Groupes centres</strong> (utilisateurs) → <strong>Groupes DO</strong> (groupes centres) → <strong>Groupe global</strong> (groupes DO).`,
};

function metaLabel(rule) {
    if (rule?.invertOf) {
        const src = rules.find(r => r.id === rule.invertOf);
        return [
            `Inverse de ${src ? src.label : '?'}`,
            NIV_LABELS[rule?.niveau] || `Niv. ${rule?.niveau ?? '?'}`,
            NIV_CSV[rule?.niveau]    || '',
        ].filter(Boolean).join(' · ');
    }
    const nInc  = rule?.conditions?.include?.length || 0;
    const nExc  = rule?.conditions?.exclude?.length || 0;
    const total = nInc + nExc;
    return [
        NIV_LABELS[rule?.niveau] || `Niv. ${rule?.niveau ?? '?'}`,
        NIV_CSV[rule?.niveau]    || '',
        `${total} condition${total !== 1 ? 's' : ''}`,
    ].filter(Boolean).join(' · ');
}

function autoUpdateDesc() {
    const fDesc = document.getElementById('f-desc');
    if (!fDesc) return;
    const nInc  = document.querySelectorAll('#cond-include .cond-row').length;
    const nExc  = document.querySelectorAll('#cond-exclude .cond-row').length;
    const total = nInc + nExc;
    const radio = document.querySelector('input[name="f-niveau"]:checked');
    const niveau = radio ? parseInt(radio.value) : 3;
    fDesc.value = [
        NIV_LABELS[niveau] || `Niv. ${niveau}`,
        NIV_CSV[niveau]    || '',
        `${total} condition${total !== 1 ? 's' : ''}`,
    ].filter(Boolean).join(' · ');
}

const adValuesCache = {};

const CARD_ICONS = {
    edit:  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    pause: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
    play:  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
    trash: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`,
    csv:   `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
};

// ── LDAP & Circuit ───────────────────────────────────────────────────

const LDAP_FIELD_MAP = {
    title:               'title',
    department:          'department',
    office:              'physicalDeliveryOfficeName',
    extensionAttribute1: 'extensionAttribute1',
    description:         'description',
    ou:                  'ou',
};

function escLdapVal(v) {
    return String(v || '').replace(/[*()\\\x00]/g, c =>
        '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

function condToLdapHtml(cond) {
    const f  = LDAP_FIELD_MAP[cond.field] || cond.field;
    const v  = escLdapVal(cond.value);
    const p  = s => `<span class="lc-p">${s}</span>`;
    const op = s => `<span class="lc-op">${s}</span>`;
    const fH = `<span class="lc-field">${esc(f)}</span>`;
    const vH = `<span class="lc-val">${esc(v)}</span>`;
    switch (cond.op) {
        case 'eq':      return `${p('(')}${fH}=${vH}${p(')')}`;
        case 'ne':      return `${p('(')}${op('!')}${p('(')}${fH}=${vH}${p(')')}${p(')')}`;
        case 'like':    return `${p('(')}${fH}=${op('*')}${vH}${op('*')}${p(')')}`;
        case 'notlike': return `${p('(')}${op('!')}${p('(')}${fH}=${op('*')}${vH}${op('*')}${p(')')}${p(')')}`;
        case 'notempty':return `${p('(')}${fH}=${op('*')}${p(')')}`;
        case 'empty':   return `${p('(')}${op('!')}${p('(')}${fH}=${op('*')}${p(')')}${p(')')}`;
        default:        return `${p('(')}${fH}=${vH}${p(')')}`;
    }
}

function buildLdapHtml() {
    const p  = s => `<span class="lc-p">${s}</span>`;
    const op = s => `<span class="lc-op">${s}</span>`;
    const kw = s => `<span class="lc-kw">${s}</span>`;
    const cm = s => `<span class="lc-comment">${s}</span>`;

    const staticHtml =
        p('(') + op('&') + '\n' +
        '  ' + p('(') + kw('objectClass') + '=' + cm('user') + p(')') + '\n' +
        '  ' + p('(') + op('!') + p('(') + kw('userAccountControl') +
            ':1.2.840.113556.1.4.803:=' + cm('2') + p(')') + p(')') + '\n' +
        p(')');

    const existing   = editingId ? rules.find(r => r.id === editingId) : null;
    const isInvertOf = !!existing?.invertOf;
    let dynamicHtml;

    if (isInvertOf) {
        const srcRule = rules.find(r => r.id === existing.invertOf);
        if (!srcRule) {
            dynamicHtml = cm('/* règle source introuvable */');
        } else {
            const inc = (srcRule.conditions?.include || []).filter(c => c.value || NO_VALUE_OPS.has(c.op));
            if (!inc.length) {
                dynamicHtml = cm('/* source sans conditions */');
            } else {
                const parts = inc.map(condToLdapHtml);
                const inner = parts.length === 1
                    ? parts[0]
                    : p('(') + op('|') + '\n  ' + parts.join('\n  ') + '\n' + p(')');
                dynamicHtml = p('(') + op('!') + inner + p(')');
            }
        }
    } else {
        const inc = readCondList('cond-include');
        const exc = readCondList('cond-exclude');
        if (!inc.length) {
            dynamicHtml = cm('/* aucune condition — ajouter des critères */');
        } else {
            // Reflète la vraie logique du moteur (Test-UserMatchesRule) :
            //  - positifs (eq / like)      → combinés en OU
            //  - négatifs (ne / notlike / empty / notempty) → contraintes ET
            //  - exclusions                → chacune niée, en ET
            const POS       = new Set(['eq', 'like']);
            const positives = inc.filter(c => POS.has(c.op));
            const negatives = inc.filter(c => !POS.has(c.op));
            const posHtml = positives.length
                ? (positives.length === 1
                    ? condToLdapHtml(positives[0])
                    : p('(') + op('|') + '\n  ' + positives.map(condToLdapHtml).join('\n  ') + '\n' + p(')'))
                : null;
            const andParts = [
                posHtml,
                ...negatives.map(condToLdapHtml),
                ...exc.map(c => p('(') + op('!') + condToLdapHtml(c) + p(')')),
            ].filter(Boolean);
            dynamicHtml = andParts.length === 1
                ? andParts[0]
                : p('(') + op('&') + '\n  ' + andParts.join('\n  ') + '\n' + p(')');
        }
    }

    return { staticHtml, dynamicHtml };
}

function updateLdapDisplay() {
    const dEl = document.getElementById('ldap-dynamic');
    if (!dEl) return;
    const { dynamicHtml } = buildLdapHtml();
    dEl.innerHTML = dynamicHtml;
}

function buildCircuitHtml() {
    const rows = [
        ['1', 'ad-reader.psm1',     '245',        'Construction cache AD',  'Lit tous les utilisateurs actifs → <code>scripts/cache/_users_global.json</code>'],
        ['2', 'ad-reader.psm1',     '237',        'Lecture cache JSON',      '<code>Get-AllUsersFromCache</code> — charge le fichier JSON en RAM'],
        ['3', 'csv-generator.psm1', '90–111',     'Filtrage règle',          '<code>Test-UserMatchesRule</code> — applique conditions include/exclude'],
        ['4', 'csv-generator.psm1', '113–125',    'Test condition unitaire', '<code>Test-Condition</code> — compare champ par champ (title, department, office…)'],
        ['5', 'http-server.psm1',   '234,248–251','Prévisualisation',        'Route <code>POST /api/regles/preview-groups</code> — même logique de filtrage'],
        ['6', 'csv-generator.psm1', '10,21–27',   'Génération CSV',          '<code>Invoke-RuleGeneration</code> → fichiers dans <code>application/output/</code>'],
    ];
    return `<div class="circuit-wrap">` +
        `<p class="circuit-note">Les conditions sont évaluées <strong>en mémoire</strong> sur le cache JSON local — aucune requête LDAP n'est envoyée à l'AD lors du filtrage.</p>` +
        `<table class="circuit-table"><thead><tr>` +
        `<th>#</th><th>Fichier</th><th>Ligne</th><th>Étape</th><th>Détail</th>` +
        `</tr></thead><tbody>` +
        rows.map(([n, file, line, role, detail]) =>
            `<tr><td class="ct-step">${n}</td><td><code class="ct-file">${file}</code></td>` +
            `<td class="ct-line">${line}</td><td class="ct-role">${role}</td>` +
            `<td class="ct-detail">${detail}</td></tr>`
        ).join('') +
        `</tbody></table></div>`;
}

// ── Init ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    if (window !== window.top) {
        document.querySelector('header').style.display = 'none';
        document.querySelector('.regles-layout').style.height = '100vh';
    }

    await loadRules();
    const raw = localStorage.getItem('regles_draft');
    if (raw) {
        localStorage.removeItem('regles_draft');
        try { renderForm(JSON.parse(raw)); } catch { /* draft invalide */ }
    }
    document.getElementById('btn-new-rule').addEventListener('click', openNewForm);
    document.getElementById('btn-view-json').addEventListener('click', openJsonModal);
    setupGroupNiveauBtn();

    const sidebar = document.querySelector('.regles-sidebar');
    if (sidebar) {
        try { if (localStorage.getItem('regles_sidebar_collapsed') === '1') sidebar.classList.add('collapsed'); } catch { /* ignore */ }
        document.getElementById('btn-toggle-sidebar')?.addEventListener('click', () => {
            const c = sidebar.classList.toggle('collapsed');
            try { localStorage.setItem('regles_sidebar_collapsed', c ? '1' : '0'); } catch { /* ignore */ }
        });
    }
    setupJsonModal();
    setupHelpModal();
    setupCsvModal();
    setupCsvFileModal();
    setupGroupsPreviewModal();
    setupTooltip();
    setupCacheInfoBar();
});

async function loadRules() {
    try {
        const r = await fetch('/api/regles');
        const data = await r.json();
        rules = Array.isArray(data) ? data : [];
        renderList();
    } catch {
        showToast('Erreur chargement des règles', 'error');
        rules = [];
        renderList();
    }
}

// ── Liste ─────────────────────────────────────────────────────────────
function renderList() {
    const el = document.getElementById('regles-list');
    if (!rules.length) {
        el.innerHTML = '<p class="hint">Aucune règle définie</p>';
        return;
    }
    el.innerHTML = '';

    if (groupByNiveau) {
        for (const niv of [1, 2, 3]) {
            const inNiv = rules.filter(r => (r.niveau || 1) === niv);
            if (!inNiv.length) continue;
            const hdr = document.createElement('div');
            hdr.className = 'rules-niveau-hdr';
            hdr.innerHTML = `<span class="niv-full">Niveau ${niv} (${NIV_LABELS[niv] || ''})</span><span class="niv-mini">N${niv}</span><span class="rules-niveau-count">${inNiv.length}</span>`;
            el.appendChild(hdr);
            const activeN   = inNiv.filter(r => r.active !== false);
            const inactiveN = inNiv.filter(r => r.active === false);
            for (const rule of activeN)   el.appendChild(buildCard(rule));
            for (const rule of inactiveN) el.appendChild(buildCard(rule));
        }
        return;
    }

    const active   = rules.filter(r => r.active !== false);
    const inactive = rules.filter(r => r.active === false);
    for (const rule of active)   el.appendChild(buildCard(rule));
    if (inactive.length) {
        const sep = document.createElement('div');
        sep.className = 'rules-section-sep';
        sep.innerHTML = '<span>Inactives</span>';
        el.appendChild(sep);
        for (const rule of inactive) el.appendChild(buildCard(rule));
    }
}

function setupGroupNiveauBtn() {
    const btn = document.getElementById('btn-group-niveau');
    if (!btn) return;
    btn.classList.toggle('active', groupByNiveau);
    btn.addEventListener('click', () => {
        groupByNiveau = !groupByNiveau;
        try { localStorage.setItem('regles_group_niveau', groupByNiveau ? '1' : '0'); } catch { /* ignore */ }
        btn.classList.toggle('active', groupByNiveau);
        renderList();
    });
}

// Maître : icône "git-fork" (la règle alimente d'autres règles)
const SVG_MASTER = `<svg class="rule-link-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v4m0 0-5 6m5-6 5 6"/></svg>`;
// Subordonné : icône "corner-down-right" (↳ — dérivé du maître)
const SVG_LINK   = `<svg class="rule-link-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>`;

function buildCard(rule) {
    const isActive = rule.active !== false;

    const sourceRule  = rule.invertOf ? rules.find(r => r.id === rule.invertOf) : null;
    const inverseRule = rules.find(r => r.invertOf === rule.id);

    const linkedRule = sourceRule || inverseRule || null;

    let linkBadge = '';
    if (sourceRule) {
        linkBadge = `<span class="rule-link-badge rule-link-sub" title="Subordonné — inverse de « ${esc(sourceRule.label)} »">${SVG_LINK}</span>`;
    } else if (inverseRule) {
        linkBadge = `<span class="rule-link-badge rule-link-master" title="Maître — « ${esc(inverseRule.label)} » est l'inverse de cette règle">${SVG_MASTER}</span>`;
    }

    const card = document.createElement('div');
    card.className = 'rule-card'
        + (editingId === rule.id ? ' active' : '')
        + (isActive ? '' : ' inactive');
    card.dataset.id = rule.id;
    card.title = rule.label || '';
    const initials = (rule.label || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
    card.innerHTML =
        `<span class="rule-initials">${esc(initials)}</span>` +
        `<div class="rule-card-row">` +
            `<span class="rule-card-label">${esc(rule.label || '(sans nom)')}</span>` +
            linkBadge +
            (linkedRule ? `<button class="btn-card-peer-preview" title="Prévisualiser « ${esc(linkedRule.label)} »" data-peer-id="${esc(linkedRule.id)}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>` : '') +
            (!isActive ? `<span class="badge-inactive">Inactif</span>` : '') +
            (rule.locked ? `<span class="rule-lock-ic" title="Règle verrouillée">🔒</span>` : '') +
        `</div>` +
        (rule.locked ? `<span class="rule-lock-mini" title="Règle verrouillée">🔒</span>` : '');

    card.addEventListener('click', () => openEditForm(rule.id));

    if (linkedRule) {
        card.querySelector('.btn-card-peer-preview').addEventListener('click', e => {
            e.stopPropagation();
            fetchAndShowPreview(linkedRule, e.currentTarget);
        });
    }

    return card;
}

// ── Formulaire ────────────────────────────────────────────────────────
function openNewForm() {
    editingId = null;
    activeFormTab = 'params';
    renderList();
    renderForm(null);
}

function openEditForm(id) {
    editingId = id;
    renderList();
    renderForm(rules.find(r => r.id === id) || null);
}

function closeForm() {
    editingId = null;
    renderList();
    document.getElementById('regles-main').innerHTML =
        '<div class="regles-empty"><p>Sélectionner une règle ou créer une nouvelle règle</p></div>';
}

function renderForm(rule) {
    const main         = document.getElementById('regles-main');
    const isNew        = !rule?.id;
    const niveau       = rule?.niveau ?? 3;
    const inc          = rule?.conditions?.include || [];
    const exc          = rule?.conditions?.exclude || [];
    const activeChecked = (rule?.active !== false) ? ' checked' : '';
    const hasPeer = !!editingId && (!!rule?.invertOf || rules.some(r => r.invertOf === editingId));
    const locked  = !!rule?.locked;

    main.innerHTML =
        `<div class="regles-form" id="rule-form">` +
            `<div class="form-tabs-bar">` +
                `<button class="form-tab-btn active" data-tab="params">Paramètres</button>` +
                `<button class="form-tab-btn" data-tab="apercu">Aperçu groupes</button>` +
                `<button class="form-tab-btn" data-tab="circuit">Circuit</button>` +
            `</div>` +
            `<div class="form-tab-pane" id="tab-params">` +
            `<div class="form-title">${isNew ? 'Nouvelle règle' : 'Modifier — ' + esc(rule.label || '')}</div>` +

            `<div class="form-row-top">` +
                `<div class="form-row-top-col">` +
                    `<label class="form-label" for="f-label">Nom de la règle</label>` +
                    `<input id="f-label" class="form-input" type="text" placeholder="ex. Administratif" value="${esc(rule?.label || '')}">` +
                `</div>` +
                `<div class="form-row-top-col">` +
                    `<label class="form-label" for="f-prefix">Préfixe technique <span class="form-label-opt">(optionnel)</span></label>` +
                    `<div class="prefix-wrap">` +
                        `<input id="f-prefix" class="form-input" type="text" placeholder="Si vide, dérivé du nom" value="${esc(rule?.prefix || '')}">` +
                    `</div>` +
                    `<small class="prefix-hint" id="prefix-hint"></small>` +
                `</div>` +
                `<div class="form-row-top-toggle">` +
                    `<label class="toggle-switch">` +
                        `<input type="checkbox" id="f-active"${activeChecked}>` +
                        `<span class="toggle-track"></span>` +
                    `</label>` +
                    `<span class="toggle-label">Règle active</span>` +
                `</div>` +
            `</div>` +

            `<div class="form-group">` +
                `<label class="form-label" for="f-desc">Description</label>` +
                `<input id="f-desc" class="form-input form-input-auto" type="text" value="${esc(metaLabel(rule || {}))}" readonly>` +
            `</div>` +

            `<div class="form-group">` +
                `<label class="form-label">Niveau de groupement</label>` +
                `<div class="niveau-options${rule?.invertOf ? ' niveau-locked' : ''}" id="niveau-options">` +
                    [1, 2, 3].map(n =>
                        `<label class="niveau-option${niveau === n ? ' selected' : ''}" data-n="${n}">` +
                            `<input type="radio" name="f-niveau" value="${n}"${niveau === n ? ' checked' : ''}${rule?.invertOf ? ' disabled' : ''}>` +
                            `<div class="niveau-opt-num">${n}</div>` +
                            `<div class="niveau-opt-lbl">${NIV_LABELS[n]}</div>` +
                            `<div class="niveau-opt-desc">${NIV_CSV[n]}</div>` +
                        `</label>`
                    ).join('') +
                `</div>` +
                (rule?.invertOf
                    ? `<div class="niveau-locked-note"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Hérité de « ${esc(rules.find(r => r.id === rule.invertOf)?.label || rule.invertOf)} » — non modifiable</div>`
                    : '') +
                `<div class="niveau-desc" id="niveau-desc"></div>` +
            `</div>` +

            (() => {
                const srcRule = rule?.invertOf ? rules.find(r => r.id === rule.invertOf) : null;
                if (srcRule) {
                    const OPS_MAP = Object.fromEntries(OPS);
                    const condPills = (srcRule.conditions?.include || []).map(c =>
                        `<span class="invertof-cond-pill">${FIELD_LABELS[c.field] || c.field} ${OPS_MAP[c.op] || c.op} <strong>${esc(c.value)}</strong></span>`
                    ).join('');
                    return `<div class="form-group">` +
                        `<div class="invertof-banner">` +
                            SVG_LINK +
                            `<div class="invertof-banner-body">` +
                                `<div class="invertof-banner-title">Critères verrouillés — inverse de « ${esc(srcRule.label)} »</div>` +
                                `<div class="invertof-banner-desc">Les membres sont tous les utilisateurs actifs qui <strong>ne correspondent pas</strong> à la règle <em>${esc(srcRule.label)}</em>. Modifiez cette règle pour mettre à jour automatiquement.</div>` +
                                (condPills ? `<div class="invertof-source-conds">${condPills}</div>` : '') +
                            `</div>` +
                        `</div>` +
                    `</div>`;
                }
                return `<div class="form-group">` +
                    `<div class="cond-row-2col">` +
                        `<div class="cond-section">` +
                            `<div class="cond-section-hdr">` +
                                `<span class="cond-section-lbl include">Inclure</span>` +
                                `<span class="cond-section-hint">utilisateurs répondant à ces critères</span>` +
                            `</div>` +
                            `<div class="cond-list" id="cond-include"></div>` +
                            `<button class="btn-add-cond" id="btn-add-include">+ Ajouter une condition</button>` +
                        `</div>` +
                        `<div class="cond-section">` +
                            `<div class="cond-section-hdr">` +
                                `<span class="cond-section-lbl exclude">Exclure</span>` +
                                `<span class="cond-section-hint">parmi les inclus, retirer ces utilisateurs</span>` +
                            `</div>` +
                            `<div class="cond-list" id="cond-exclude"></div>` +
                            `<button class="btn-add-cond" id="btn-add-exclude">+ Ajouter une exclusion</button>` +
                        `</div>` +
                    `</div>` +
                `</div>`;
            })() +
            `<div class="ldap-zone" id="ldap-display">` +
                `<div class="ldap-zone-title">Filtre LDAP équivalent</div>` +
                `<div class="ldap-cols">` +
                    `<div class="ldap-col"><pre class="ldap-code" id="ldap-dynamic"></pre></div>` +
                `</div>` +
                `<div class="ldap-note">Appliqué aux comptes utilisateurs <strong>activés</strong> uniquement (comptes désactivés exclus en amont).</div>` +
            `</div>` +
        `</div>` +
        `<div class="form-tab-pane" id="tab-circuit" hidden>` +
            buildCircuitHtml() +
        `</div>` +
        `<div class="form-tab-pane" id="tab-apercu" hidden>` +
            `<iframe id="apercu-frame" class="apercu-frame" title="Aperçu des groupes" allowfullscreen></iframe>` +
        `</div>` +
        `</div>` +
        `<div class="form-footer">` +
            `<div class="gen-progress" id="gen-progress" hidden>` +
                `<div class="gen-progress-bar"></div>` +
                `<span class="gen-progress-msg" id="gen-progress-msg"></span>` +
            `</div>` +
            `<div class="form-footer-buttons">` +
                `<div class="form-footer-left">` +
                    (editingId
                        ? (locked
                            ? `<button class="btn-unlock" id="btn-unlock" type="button" title="Déverrouiller pour autoriser les modifications">🔓 Déverrouiller</button>`
                            : `<button class="btn-danger" id="btn-delete-rule">Supprimer</button>`)
                        : '') +
                `</div>` +
                `<div class="form-footer-right">` +
                    `<button class="btn-secondary" id="btn-cancel">Annuler</button>` +
                    (editingId
                        ? `<button class="btn-preview-groups" id="btn-preview-groups" type="button" title="Prévisualiser les groupes AD et adresses mail">` +
                            `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>` +
                            ` Prévisualiser les groupes` +
                          `</button>`
                        : '') +
                    (editingId
                        ? `<button class="btn-html-page" id="btn-html-page" type="button" title="Ouvrir une page HTML récapitulative de tous les groupes">` +
                            `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>` +
                            ` Afficher page HTML` +
                          `</button>`
                        : '') +
                    (hasPeer && !locked ? `<button class="btn-generate-form" id="btn-generate-form">Générer les CSVs FORMATEURS et ADMINISTRATIF</button>` : '') +
                    (locked
                        ? `<span class="lock-badge" title="Règle verrouillée">🔒 Verrouillée</span>`
                        : (editingId ? `<button class="btn-lock" id="btn-lock" type="button" title="Verrouiller la règle (bloque toute modification et suppression)">🔒 Verrouiller</button>` : '') +
                          `<button class="btn-primary" id="btn-save">Enregistrer</button>`) +
                `</div>` +
            `</div>` +
        `</div>`;

    if (!rule?.invertOf) {
        for (const c of inc) addCondRow('cond-include', c);
        for (const c of exc) addCondRow('cond-exclude', c);
    }

    main.querySelectorAll('.niveau-option').forEach(opt => {
        opt.addEventListener('click', () => {
            if (opt.querySelector('input')?.disabled) return;
            main.querySelectorAll('.niveau-option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            opt.querySelector('input').checked = true;
            autoUpdateDesc();
            const d = document.getElementById('niveau-desc');
            if (d) d.innerHTML = NIV_DESCRIPTIONS[parseInt(opt.dataset.n)] || '';
        });
    });
    const initNivDesc = document.getElementById('niveau-desc');
    if (initNivDesc) initNivDesc.innerHTML = NIV_DESCRIPTIONS[niveau] || '';

    document.getElementById('btn-add-include')?.addEventListener('click', () => { addCondRow('cond-include'); autoUpdateDesc(); });
    document.getElementById('btn-add-exclude')?.addEventListener('click', () => { addCondRow('cond-exclude'); autoUpdateDesc(); });
    document.getElementById('btn-save')?.addEventListener('click', saveRule);
    document.getElementById('btn-cancel')?.addEventListener('click', closeForm);
    document.getElementById('btn-preview-groups')?.addEventListener('click', previewGroups);
    document.getElementById('btn-html-page')?.addEventListener('click', showGroupsHtmlPage);

    const prefixInput = document.getElementById('f-prefix');
    const prefixHint  = document.getElementById('prefix-hint');
    function updatePrefixHint() {
        const raw = prefixInput.value.trim();
        if (!raw) { prefixHint.textContent = ''; return; }
        const cleaned = cleanForFileName(raw);
        prefixHint.textContent = cleaned
            ? `→ Sera utilisé comme : ${cleaned}  |  Mail : ${cleaned.toLowerCase()}@…`
            : '';
        prefixHint.className = 'prefix-hint' + (cleaned.length > 20 ? ' prefix-hint-warn' : '');
    }
    prefixInput.addEventListener('input', updatePrefixHint);
    updatePrefixHint();
    const genFormBtn = document.getElementById('btn-generate-form');
    if (genFormBtn) genFormBtn.addEventListener('click', generatePairCsv);
    const delRuleBtn = document.getElementById('btn-delete-rule');
    if (delRuleBtn) delRuleBtn.addEventListener('click', () => confirmDelete(editingId, document.getElementById('f-label')?.value.trim() || editingId));

    document.getElementById('btn-lock')?.addEventListener('click', () => toggleLock(true));
    document.getElementById('btn-unlock')?.addEventListener('click', () => toggleLock(false));
    if (locked) document.getElementById('rule-form')?.classList.add('rule-form--locked');

    document.getElementById('f-active').addEventListener('change', async e => {
        const newVal = e.target.checked;
        e.target.checked = !newVal;
        const label  = document.getElementById('f-label')?.value.trim() || 'cette règle';
        const action = newVal ? 'Réactiver' : 'Désactiver';
        if (await showConfirm(`${action} la règle "${label}" ?`)) {
            e.target.checked = newVal;
        }
    });

    document.querySelectorAll('.form-tab-btn').forEach(btn =>
        btn.addEventListener('click', () => {
            activeFormTab = btn.dataset.tab;
            document.querySelectorAll('.form-tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.form-tab-pane').forEach(p => { p.hidden = true; });
            btn.classList.add('active');
            document.getElementById('tab-' + btn.dataset.tab).hidden = false;
            if (btn.dataset.tab === 'apercu') loadApercuGroupes();
        })
    );
    document.getElementById('rule-form')?.addEventListener('input',  updateLdapDisplay);
    document.getElementById('rule-form')?.addEventListener('change', updateLdapDisplay);
    updateLdapDisplay();

    // Conserver l'onglet actif quand on change de règle (et recharger l'aperçu le cas échéant)
    if (activeFormTab && activeFormTab !== 'params') {
        document.querySelector('.form-tab-btn[data-tab="' + activeFormTab + '"]')?.click();
    } else {
        document.getElementById('f-label').focus();
    }
}

function createCondRow(cond = null) {
    const row = document.createElement('div');
    row.className = 'cond-row';

    const selField = `<select class="cond-field">` +
        FIELDS.map(([v, l]) => `<option value="${v}"${cond?.field === v ? ' selected' : ''}>${l}</option>`).join('') +
        `</select>`;
    const selOp = `<select class="cond-op">` +
        OPS.map(([v, l]) => `<option value="${v}"${cond?.op === v ? ' selected' : ''}>${l}</option>`).join('') +
        `</select>`;

    row.innerHTML =
        selField + selOp +
        `<div class="cond-val-wrap">` +
            `<input type="text" class="cond-val" placeholder="valeur…" value="${esc(cond?.value || '')}" autocomplete="off">` +
            `<div class="val-picker-panel" hidden></div>` +
        `</div>` +
        `<button class="btn-remove-cond" title="Supprimer">` +
            `<svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">` +
                `<path d="M1 1l9 9M10 1L1 10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>` +
            `</svg>` +
        `</button>`;

    row.querySelector('.btn-remove-cond').addEventListener('click', () => { row.remove(); autoUpdateDesc(); });
    initPicker(row.querySelector('.cond-val'), row.querySelector('.cond-field'), row.querySelector('.cond-val-wrap'));

    // "est vide" / "n'est pas vide" : aucune valeur à saisir → champ désactivé
    const opSel  = row.querySelector('.cond-op');
    const valInp = row.querySelector('.cond-val');
    const syncValState = () => {
        const noVal = NO_VALUE_OPS.has(opSel.value);
        valInp.disabled = noVal;
        if (noVal) { valInp.value = ''; valInp.placeholder = '(aucune valeur)'; }
        else if (valInp.placeholder === '(aucune valeur)') { valInp.placeholder = 'valeur…'; }
    };
    opSel.addEventListener('change', syncValState);
    syncValState();

    return row;
}

function addCondRow(listId, cond = null) {
    document.getElementById(listId).appendChild(createCondRow(cond));
}

function readCondList(listId) {
    return [...document.querySelectorAll(`#${listId} .cond-row`)].map(row => ({
        field: row.querySelector('.cond-field').value,
        op:    row.querySelector('.cond-op').value,
        value: row.querySelector('.cond-val').value.trim(),
    })).filter(c => c.value !== '' || NO_VALUE_OPS.has(c.op));
}

function cleanForFileName(name) {
    if (!name) return '';
    const normalized = name.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return normalized.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').toUpperCase().replace(/^-+|-+$/g, '');
}

function readForm() {
    const label  = document.getElementById('f-label')?.value.trim();
    const radio  = document.querySelector('input[name="f-niveau"]:checked');
    const niveau = radio ? parseInt(radio.value) : 3;

    if (!label) { showToast('Le nom est obligatoire', 'error'); return null; }

    const existing   = editingId ? rules.find(r => r.id === editingId) : null;
    const isInvertOf = !!existing?.invertOf;
    const include    = isInvertOf ? [] : readCondList('cond-include');
    if (!isInvertOf && !include.length) { showToast('Au moins une condition "Inclure" est requise', 'error'); return null; }

    const exclude    = isInvertOf ? [] : readCondList('cond-exclude');
    const activeChk  = document.getElementById('f-active');
    const rawPrefix  = document.getElementById('f-prefix')?.value.trim() || '';

    return {
        id:         editingId || uid(),
        label,
        prefix:     rawPrefix || null,
        niveau,
        monoNiveau: existing?.monoNiveau ?? false,
        ...(existing?.invertOf ? { invertOf: existing.invertOf } : {}),
        ...(existing?.locked ? { locked: true } : {}),
        conditions: { include, exclude },
        active:     activeChk ? activeChk.checked : (existing?.active !== false),
        createdAt:  existing?.createdAt || now(),
        updatedAt:  now(),
    };
}

async function toggleLock(lock) {
    if (lock) {
        const rule = readForm();
        if (!rule) return;
        if (!await showConfirm(`Verrouiller la règle « ${rule.label} » ?\nToute modification et suppression sera bloquée (déverrouillage possible ensuite).`)) return;
        rule.locked = true;
        try {
            await fetch('/api/regles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rule) });
            editingId = rule.id;
            showToast('Règle verrouillée', 'success');
        } catch { showToast('Erreur lors du verrouillage', 'error'); return; }
    } else {
        const src = rules.find(r => r.id === editingId);
        if (!src) return;
        if (!await showConfirm(`Déverrouiller la règle « ${src.label} » pour autoriser les modifications ?`)) return;
        try {
            await fetch('/api/regles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...src, locked: false, updatedAt: now() }) });
            showToast('Règle déverrouillée', 'success');
        } catch { showToast('Erreur lors du déverrouillage', 'error'); return; }
    }
    await loadRules();
    renderForm(rules.find(r => r.id === editingId));
}

async function saveRule() {
    const rule = readForm();
    if (!rule) return;
    try {
        await fetch('/api/regles', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(rule),
        });
        editingId = rule.id;
        await loadRules();

        // Propager niveau + monoNiveau aux règles enfants (invertOf)
        const children = rules.filter(r => r.invertOf === rule.id);
        const toSync   = children.filter(c => c.niveau !== rule.niveau || c.monoNiveau !== rule.monoNiveau);
        for (const child of toSync) {
            await fetch('/api/regles', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ ...child, niveau: rule.niveau, monoNiveau: rule.monoNiveau, updatedAt: now() }),
            });
        }
        if (toSync.length) await loadRules();

        renderForm(rule);
        showToast(toSync.length
            ? `Règle enregistrée · niveau propagé à ${toSync.map(c => c.label).join(', ')}`
            : 'Règle enregistrée',
            'success');
    } catch {
        showToast('Erreur lors de la sauvegarde', 'error');
    }
}

function showConfirm(message, { danger = false } = {}) {
    return new Promise(resolve => {
        const modal     = document.getElementById('confirm-modal');
        const okBtn     = document.getElementById('confirm-ok');
        const cancelBtn = document.getElementById('confirm-cancel');

        document.getElementById('confirm-modal-msg').textContent = message;
        okBtn.className = danger ? 'btn-danger' : 'btn-primary';
        modal.removeAttribute('hidden');

        function cleanup() {
            modal.setAttribute('hidden', '');
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            modal.removeEventListener('click', onOverlay);
        }
        function onOk()      { cleanup(); resolve(true);  }
        function onCancel()  { cleanup(); resolve(false); }
        function onOverlay(e){ if (e.target === modal) { cleanup(); resolve(false); } }

        okBtn.addEventListener('click',     onOk);
        cancelBtn.addEventListener('click', onCancel);
        modal.addEventListener('click',     onOverlay);
    });
}

async function confirmDelete(id, label) {
    if (!await showConfirm(`Supprimer la règle "${label}" ?`, { danger: true })) return;
    try {
        await fetch(`/api/regles/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (editingId === id) closeForm();
        await loadRules();
        showToast('Règle supprimée');
    } catch {
        showToast('Erreur lors de la suppression', 'error');
    }
}

async function toggleActive(id) {
    const rule = rules.find(r => r.id === id);
    if (!rule) return;
    const willActivate = rule.active === false;
    const action = willActivate ? 'Réactiver' : 'Désactiver';
    if (!await showConfirm(`${action} la règle "${rule.label}" ?`)) return;
    const updated = { ...rule, active: willActivate, updatedAt: now() };
    try {
        await fetch('/api/regles', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(updated),
        });
        await loadRules();
        if (editingId === id) renderForm(rules.find(r => r.id === id));
        showToast(updated.active ? 'Règle activée' : 'Règle désactivée');
    } catch {
        showToast('Erreur lors de la mise à jour', 'error');
    }
}

// ── Barre info cache utilisateurs ─────────────────────────────────────

function setupCacheInfoBar() {
    const msg = document.getElementById('cache-info-msg');
    const btn = document.getElementById('btn-refresh-cache');
    if (!msg || !btn) return;

    async function loadCacheInfo() {
        try {
            const data = await fetch('/api/users/cache-info').then(r => r.json());
            if (data.ok && data.count > 0) {
                msg.textContent = `✓ ${data.count.toLocaleString('fr-FR')} util. — ${data.ts}`;
                msg.className = 'cache-info-msg ok';
            } else {
                msg.textContent = '⚠ Cache vide — cliquez ↻';
                msg.className = 'cache-info-msg warn';
            }
        } catch {
            msg.textContent = '⚠ Erreur lecture cache';
            msg.className = 'cache-info-msg warn';
        }
    }

    async function refreshCache() {
        msg.textContent = 'Chargement AD…';
        msg.className = 'cache-info-msg spin';
        btn.classList.add('spinning');
        btn.disabled = true;
        try {
            const data = await fetch('/api/users/preload', { method: 'POST' }).then(r => r.json());
            if (data.ok) {
                apercuCache = {};   // les données AD ont changé → invalider le cache d'aperçu
                msg.textContent = `✓ ${data.count.toLocaleString('fr-FR')} util. mis à jour`;
                msg.className = 'cache-info-msg ok';
                showToast('Tous les caches mis à jour (utilisateurs, OUs, sites)', 'success');
            } else {
                msg.textContent = `⚠ ${data.error || 'Erreur'}`;
                msg.className = 'cache-info-msg warn';
            }
        } catch {
            msg.textContent = '⚠ Erreur chargement';
            msg.className = 'cache-info-msg warn';
        } finally {
            btn.classList.remove('spinning');
            btn.disabled = false;
            loadCacheInfo();
        }
    }

    btn.addEventListener('click', refreshCache);
    loadCacheInfo();
}

// ── Génération CSV ────────────────────────────────────────────────────

function getGenSteps() {
    return [
        'Lecture du cache JSON…',
        'Filtrage selon les conditions…',
        'Groupement par Direction Opérationnelle…',
        'Écriture des fichiers CSV…',
        'Finalisation…'
    ];
}

async function generateCsv(id) {
    const rule  = rules.find(r => r.id === id);
    const label = rule?.label || id;

    const btn         = document.getElementById('btn-generate-form');
    const progress    = document.getElementById('gen-progress');
    const msg         = document.getElementById('gen-progress-msg');
    const overlay     = document.getElementById('gen-overlay');
    const overlayStep = document.getElementById('gen-overlay-step');

    if (btn)     { btn.disabled = true; btn.textContent = 'Génération…'; }
    if (progress) progress.removeAttribute('hidden');
    if (overlay)  overlay.removeAttribute('hidden');

    const steps = getGenSteps();
    let stepIdx = 0;
    function showStep() {
        const step = steps[stepIdx % steps.length];
        if (msg)         msg.textContent  = step;
        if (overlayStep) overlayStep.textContent = step;
    }
    showStep();
    const ticker = setInterval(() => { stepIdx++; showStep(); }, 2000);

    try {
        const r    = await fetch(`/api/regles/${encodeURIComponent(id)}/generate`, { method: 'POST' });
        const data = await r.json();

        if (!data.ok) {
            showToast(`Erreur : ${data.error}`, 'error');
            return;
        }

        showCsvModal(data, rule || { label });
    } catch {
        showToast('Erreur lors de la génération', 'error');
    } finally {
        clearInterval(ticker);
        if (btn)      { btn.disabled = false; btn.textContent = 'Générer le CSV'; }
        if (progress) progress.setAttribute('hidden', '');
        if (overlay)  overlay.setAttribute('hidden', '');
    }
}

// ── Génération paire FORMATEURS + ADMINISTRATIF ──────────────────────

const PAIR_LABEL = 'Générer les CSVs FORMATEURS et ADMINISTRATIF';

async function generatePairCsv() {
    const rule = readForm();
    if (!rule) return;

    const confirmed = await showConfirm(
        `Générer tous les CSVs FORMATEURS et ADMINISTRATIF ?\n\nLes fichiers seront écrits dans application/output/.`
    );
    if (!confirmed) return;

    const btn         = document.getElementById('btn-generate-form');
    const progress    = document.getElementById('gen-progress');
    const msg         = document.getElementById('gen-progress-msg');
    const overlay     = document.getElementById('gen-overlay');
    const overlayStep = document.getElementById('gen-overlay-step');

    if (btn)     { btn.disabled = true; btn.textContent = 'Génération…'; }
    if (progress) progress.removeAttribute('hidden');
    if (overlay)  overlay.removeAttribute('hidden');

    const steps = getGenSteps();
    let stepIdx = 0;
    const showStep = () => {
        const step = steps[stepIdx % steps.length];
        if (msg)         msg.textContent      = step;
        if (overlayStep) overlayStep.textContent = step;
    };
    showStep();
    const ticker = setInterval(() => { stepIdx++; showStep(); }, 2000);

    try {
        const r    = await fetch('/api/regles/generate-pair', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(rule),
        });
        const data = await r.json();
        if (!data.ok) { showToast(`Erreur : ${data.error}`, 'error'); return; }
        showPairCsvModal(data);
    } catch {
        showToast('Erreur lors de la génération', 'error');
    } finally {
        clearInterval(ticker);
        if (btn)      { btn.disabled = false; btn.textContent = PAIR_LABEL; }
        if (progress) progress.setAttribute('hidden', '');
        if (overlay)  overlay.setAttribute('hidden', '');
    }
}

function showPairCsvModal(data) {
    const files  = data.files  || [];
    const outDir = data.outDir || '';

    const modal    = document.getElementById('csv-modal');
    const title    = document.getElementById('csv-modal-title');
    const summary  = document.getElementById('csv-modal-summary');
    const criteria = document.getElementById('csv-modal-criteria');
    const tabs     = document.getElementById('csv-modal-tabs');
    const body     = document.getElementById('csv-modal-body');
    const mailPnl  = document.getElementById('csv-mail-panel');
    const footer   = document.getElementById('csv-modal-footer');

    if (!modal) return;

    if (title)    title.textContent   = 'CSV FORMATEURS + ADMINISTRATIF';
    if (summary)  summary.textContent = `${files.length} fichier${files.length !== 1 ? 's' : ''} générés`;
    if (criteria) criteria.innerHTML  = '';
    if (tabs)     tabs.innerHTML      = '';
    if (mailPnl)  { mailPnl.innerHTML = ''; mailPnl.setAttribute('hidden', ''); }
    if (footer)   footer.innerHTML    = `<span class="csv-outdir-path" title="${esc(outDir)}">${esc(outDir)}</span>`;

    if (body) {
        const sorted = [...files].sort();
        body.innerHTML =
            `<ul class="csv-file-list">` +
            sorted.map(f => {
                const name = f.split(/[/\\]/).pop() || f;
                return `<li class="csv-file-item csv-file-item--global"><span class="csv-file-name">${esc(name)}</span></li>`;
            }).join('') +
            `</ul>`;
    }

    modal.removeAttribute('hidden');
}

// ── Prévisualisation groupes AD ───────────────────────────────────────

async function fetchAndShowPreview(rule, spinEl = null) {
    if (spinEl) { spinEl.disabled = true; }
    try {
        const r    = await fetch('/api/regles/preview-groups', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(rule),
        });
        const data = await r.json();
        if (data.error) { showToast(data.error, 'error'); return; }
        showGroupsPreviewModal(data, rule);
    } catch {
        showToast('Erreur lors de la prévisualisation', 'error');
    } finally {
        if (spinEl) { spinEl.disabled = false; }
    }
}

async function showGroupsHtmlPage() {
    const rule = readForm();
    if (!rule) return;
    const btn = document.getElementById('btn-html-page');
    if (btn) { btn.disabled = true; }
    try {
        const r    = await fetch('/api/regles/preview-groups', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(rule),
        });
        const data = await r.json();
        if (data.error) { showToast(data.error, 'error'); return; }
        const w = window.open('', '_blank');
        if (!w) { showToast('Pop-up bloquée — autorisez les fenêtres pour ce site', 'error'); return; }
        w.document.open();
        w.document.write(buildGroupsHtmlDoc(data, rule));
        w.document.close();
    } catch {
        showToast('Erreur lors de la génération de la page HTML', 'error');
    } finally {
        if (btn) { btn.disabled = false; }
    }
}

function buildGroupsHtmlBody(data) {
    const groups   = data.groups || [];
    const global   = groups.find(g => g.type === 'global');
    const doGroups  = groups.filter(g => g.type === 'do').sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    const centres  = groups.filter(g => g.type === 'centre');
    for (const dg of doGroups) {
        dg._centres = centres
            .filter(c => c.name.startsWith(dg.name + '-'))
            .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    }

    const membersHtml = g => {
        if (!g.members || !g.members.length) return '';
        return `<ul class="members">` + g.members.map(m =>
            `<li><span class="m-name">${esc(m.name)}</span>${m.title ? `<span class="m-title">${esc(m.title)}</span>` : ''}</li>`
        ).join('') + `</ul>`;
    };
    const card = (g, lvl, badge) =>
        `<div class="grp lvl${lvl}">` +
            `<div class="grp-hd">` +
                `<span class="grp-badge">${badge}</span>` +
                `<span class="grp-name">${esc(g.name)}</span>` +
                `<span class="grp-count" title="${g.count ?? 0} utilisateur(s)">${g.count ?? 0}</span>` +
            `</div>` +
            (g.mail ? `<div class="grp-mail">${esc(g.mail)}</div>` : '') +
            membersHtml(g) +
        `</div>`;

    let body = '';
    if (global) body += card(global, 1, 'Niveau 1 · Global');
    for (const dg of doGroups) {
        body += `<div class="branch">` + card(dg, 2, 'Niveau 2 · DO');
        for (const c of (dg._centres || [])) body += card(c, 3, 'Niveau 3 · Centre');
        body += `</div>`;
    }
    if (!body) body = `<p class="empty">Aucun groupe — la règle ne correspond à aucun utilisateur.</p>`;
    return body;
}

function apercuMsgDoc(msg) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
        '<body style="margin:0;font-family:\'Segoe UI\',system-ui,sans-serif;color:#6b7280;background:#f4f5f7;padding:24px;font-style:italic;">' +
        esc(msg) + '</body></html>';
}

async function loadApercuGroupes() {
    const frame = document.getElementById('apercu-frame');
    if (!frame) return;
    const rule = readForm();
    if (!rule) { frame.srcdoc = apercuMsgDoc('Complétez la règle (nom + conditions) pour afficher les groupes.'); return; }

    // Signature du contenu de la règle → si inchangée, on réutilise le rendu en cache
    const sig = JSON.stringify({
        id: editingId, label: rule.label, prefix: rule.prefix,
        niveau: rule.niveau, monoNiveau: rule.monoNiveau,
        invertOf: rule.invertOf, conditions: rule.conditions,
    });
    if (apercuCache[sig]) { frame.srcdoc = apercuCache[sig]; return; }

    frame.srcdoc = apercuMsgDoc('Chargement…');
    try {
        const r    = await fetch('/api/regles/preview-groups', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(rule),
        });
        const data = await r.json();
        if (data.error) { frame.srcdoc = apercuMsgDoc(data.error); return; }
        // Exactement la même page que « Afficher page HTML », dans l'iframe
        const doc = buildGroupsHtmlDoc(data, rule);
        apercuCache[sig] = doc;
        frame.srcdoc = doc;
    } catch {
        frame.srcdoc = apercuMsgDoc('Erreur lors du chargement des groupes.');
    }
}

function buildGroupsHtmlDoc(data, rule) {
    const groups   = data.groups || [];
    const global   = groups.find(g => g.type === 'global');
    const doGroups = groups.filter(g => g.type === 'do').sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    const centres  = groups.filter(g => g.type === 'centre');
    for (const dg of doGroups) {
        dg._centres = centres.filter(c => c.name.startsWith(dg.name + '-')).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    }
    // Nombre de sous-groupes : global → nb de DO ; DO → nb de centres
    if (global) global._grpCount = doGroups.length;
    doGroups.forEach(dg => { dg._grpCount = dg._centres.length; });

    const memHtml = g => {
        if (!g.members || !g.members.length) return '';
        return '<ul class="members">' + g.members.map(m =>
            '<li class="mem" data-s="' + esc((m.name + ' ' + (m.title || '')).toLowerCase()) + '">' +
                '<span class="m-name">' + esc(m.name) + '</span>' +
                (m.title ? '<span class="m-title">' + esc(m.title) + '</span>' : '') +
            '</li>'
        ).join('') + '</ul>';
    };
    const card = (g, lvl, badge, cls, toggle) => {
        // Conteneur = a des sous-groupes → clic sur le mail ouvre l'arbre des adresses/groupes
        const isContainer = lvl < 3 && g._grpCount > 0;
        const nameHtml = '<span class="grp-name">' + esc(g.name) + '</span>';
        const mailHtml = g.mail
            ? (isContainer
                ? '<div class="grp-mail grp-mail-link grp-mail-cta" data-key="' + esc(g.name || '') + '" title="Voir les groupes et leurs membres">' + esc(g.mail) + '</div>'
                : '<div class="grp-mail">' + esc(g.mail) + '</div>')
            : '';
        return '<div class="grp lvl' + lvl + (cls ? ' ' + cls : '') + '" data-name="' + esc((g.name || '').toLowerCase()) + '">' +
            '<div class="grp-hd">' +
                (toggle ? '<span class="do-toggle">▾</span>' : '') +
                (badge ? '<span class="grp-badge">' + badge + '</span>' : '') +
                nameHtml +
                ((lvl < 3 && g._grpCount) ? '<span class="grp-gcount" title="Nombre de groupes">' + g._grpCount + ' gr.</span>' : '') +
                '<span class="grp-count" title="Nombre d\'utilisateurs">' + (g.count ?? 0) + '</span>' +
            '</div>' +
            mailHtml +
            memHtml(g) +
        '</div>';
    };

    const n     = doGroups.length;
    const isN3  = (data.niveau === 3) && n > 0;
    const globalCardHtml = global ? card(global, 1, 'Niveau 1 · Global', '', false) : '';

    // Niveau 1/2 : empilement vertical (carte DO + centres)
    const branchesHtml = doGroups.map(dg => {
        const hasC = (dg._centres || []).length > 0;
        return '<div class="branch" data-do="' + esc(dg.name) + '">' +
                   card(dg, 2, 'Niveau 2 · DO', 'do-head', hasC) +
                   '<div class="do-children">' +
                       (dg._centres || []).map(c => card(c, 3, '', '', false)).join('') +
                   '</div>' +
               '</div>';
    }).join('');

    // Niveau 3 : en-têtes DO (figés dans la topbar) séparés des colonnes de centres (défilantes)
    const doHeaderCards = doGroups.map(dg =>
        '<div class="do-head-cell" data-do="' + esc(dg.name) + '">' + card(dg, 2, 'Niveau 2 · DO', '', false) + '</div>'
    ).join('');
    const centreColumns = doGroups.map(dg =>
        '<div class="do-centres" data-do="' + esc(dg.name) + '">' +
            (dg._centres || []).map(c => card(c, 3, '', '', false)).join('') +
        '</div>'
    ).join('');

    // Bloc figé (niveau 3) : global + rangée d'en-têtes DO — placé DANS la topbar sticky
    const stickyGroups = isN3
        ? '<div class="topbar-groups">' + globalCardHtml + '<div class="do-headers cols-' + n + '">' + doHeaderCards + '</div></div>'
        : '';

    // Corps défilant
    let mainBody = isN3
        ? '<div class="do-columns cols-' + n + '">' + centreColumns + '</div>'
        : (globalCardHtml + branchesHtml);
    if (!mainBody) mainBody = '<p class="empty">Aucun groupe — la règle ne correspond à aucun utilisateur.</p>';

    // Arborescence des mails — modale au clic sur un mail de niveau 1 (global) ou 2 (DO)
    const mailNode = g => ({ name: g.name, mail: g.mail || '', count: g.count ?? 0 });
    const mailTree = {};
    doGroups.forEach(dg => { mailTree[dg.name] = Object.assign(mailNode(dg), { children: (dg._centres || []).map(mailNode) }); });
    if (global) mailTree[global.name] = Object.assign(mailNode(global), {
        children: doGroups.map(dg => Object.assign(mailNode(dg), { children: (dg._centres || []).map(mailNode) }))
    });

    // Membres par groupe — modale au clic sur un groupe/mail qui possède des membres
    const groupMembers = {};
    groups.forEach(g => { if (g.members && g.members.length) groupMembers[g.name] = g.members.map(m => ({ n: m.name, t: m.title || '' })); });

    // Auto-complétion : noms de membres + de groupes
    const nameSet = new Set();
    groups.forEach(g => { (g.members || []).forEach(m => nameSet.add(m.name)); if (g.name) nameSet.add(g.name); });
    const datalistHtml = '<datalist id="allnames">' +
        [...nameSet].sort((a, b) => a.localeCompare(b, 'fr')).map(n => '<option value="' + esc(n) + '">').join('') +
        '</datalist>';

    // Catégorisation par DO
    const catOpts     = doGroups.map(dg => '<option value="' + esc(dg.name) + '">' + esc(dg.name) + '</option>').join('');
    const hasBranches = doGroups.length > 0;
    const toolbar =
        '<div class="toolbar">' +
            '<div class="search-wrap"><input id="q" list="allnames" type="text" placeholder="Rechercher un nom, une fonction, un groupe…" autocomplete="off"><button id="qclear" class="qclear" type="button" hidden title="Vider">×</button></div>' +
            (hasBranches ? '<select id="cat"><option value="">Toutes les DO</option>' + catOpts + '</select>' : '') +
            (hasBranches ? '<button id="collapseAll" type="button">Tout replier</button>' : '') +
            '<button id="toggleMembers" type="button">Masquer les membres</button>' +
            '<span class="count" id="count"></span>' +
        '</div>';

    // Filtre de la règle (comment ce groupe est filtré)
    const opMap    = Object.fromEntries(OPS);
    const condText = c => {
        const f = FIELD_LABELS[c.field] || c.field;
        const o = opMap[c.op] || c.op;
        return NO_VALUE_OPS.has(c.op) ? (f + ' ' + o) : (f + ' ' + o + ' « ' + c.value + ' »');
    };
    const inc = (rule && rule.conditions && rule.conditions.include) || [];
    const exc = (rule && rule.conditions && rule.conditions.exclude) || [];
    let filterHtml = '';
    if (rule && rule.invertOf) {
        filterHtml = '<div class="fl-row">Règle <b>inverse</b> : tous les utilisateurs <b>sauf</b> ceux de la règle source.</div>';
    } else {
        if (inc.length) filterHtml += '<div class="fl-row"><span class="fl-tag inc">INCLURE</span><ul class="fl-list">' + inc.map(c => '<li>' + esc(condText(c)) + '</li>').join('') + '</ul></div>';
        if (exc.length) filterHtml += '<div class="fl-row"><span class="fl-tag exc">EXCLURE</span><ul class="fl-list">' + exc.map(c => '<li>' + esc(condText(c)) + '</li>').join('') + '</ul></div>';
        if (!inc.length && !exc.length) filterHtml = '<div class="fl-row">Aucune condition définie.</div>';
    }
    const nivMap = { 1: 'Global (1 groupe)', 2: 'Par DO (DO + global)', 3: 'Par centre (centre + DO + global)' };
    filterHtml += '<div class="fl-row fl-note">Groupement niveau ' + (data.niveau || '?') + ' · ' + esc(nivMap[data.niveau] || '') + ' — comptes activés uniquement, OU « Comptes generiques » exclues.</div>';

    // Ligne compacte du filtre — affichée dans l'en-tête
    let filterLine;
    if (rule && rule.invertOf) {
        filterLine = 'Règle inverse (tous sauf la règle source)';
    } else {
        const fp = [];
        if (inc.length) fp.push('INCLURE ' + inc.map(condText).join(' ou '));
        if (exc.length) fp.push('EXCLURE ' + exc.map(condText).join(' et '));
        filterLine = (fp.length ? fp.join(' · ') : 'Aucune condition') + ' · comptes activés, OU génériques exclues';
    }

    const css = `
        *{box-sizing:border-box;}
        body{font-family:"Segoe UI",system-ui,-apple-system,sans-serif;margin:0;background:#f4f5f7;color:#1f2430;}
        .topbar{position:sticky;top:0;z-index:10;background:#f4f5f7;box-shadow:0 3px 8px rgba(0,0,0,.08);}
        .topbar-inner{max-width:none;margin:0 auto;padding:12px 28px 10px;}
        .doc-hd{background:linear-gradient(120deg,#374151,#6b7280 68%,#9ca3af);color:#fff;padding:14px 28px;display:flex;align-items:center;justify-content:space-between;gap:16px;}
        .doc-hd-txt{min-width:0;}
        .fs-btn{display:inline-flex;align-items:center;gap:7px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.3);color:#fff;padding:7px 13px;border-radius:8px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;}
        .fs-btn:hover{background:rgba(255,255,255,.28);}
        .doc-eyebrow{font-size:.68rem;text-transform:uppercase;letter-spacing:.09em;opacity:.82;margin-bottom:2px;}
        .doc-hd-actions{display:flex;align-items:center;gap:8px;flex:none;}
        .info-btn{display:inline-flex;align-items:center;justify-content:center;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.3);color:#fff;width:34px;height:34px;border-radius:8px;cursor:pointer;padding:0;}
        .info-btn:hover{background:rgba(255,255,255,.28);}
        .info-modal{position:fixed;inset:0;z-index:1000;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;padding:20px;}
        .info-modal[hidden]{display:none;}
        .info-box{background:#fff;color:#1f2430;border-radius:12px;border-top:4px solid #2563eb;box-shadow:0 16px 50px rgba(0,0,0,.3);width:min(760px,94vw);max-height:85vh;overflow:auto;padding:22px 24px;position:relative;}
        .info-close{position:absolute;top:8px;right:12px;background:none;border:none;font-size:22px;line-height:1;color:#6b7280;cursor:pointer;}
        .info-close:hover{color:#111827;}
        .info-meta{font-size:.85rem;color:#4b5568;margin:2px 30px 14px 0;padding-bottom:12px;border-bottom:1px solid #e2e5ea;}
        .info-meta b{color:#1e293b;}
        .info-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#2563eb;margin-bottom:8px;}
        .grp-mail-link{cursor:pointer;}
        .grp-mail-link:hover{color:#2563eb;text-decoration:underline;}
        .grp-name-click,.grp-mail-mem{cursor:pointer;}
        .grp-name-click:hover,.grp-mail-mem:hover{color:#2563eb;text-decoration:underline;}
        .grp-mail-cta{color:#2563eb;font-weight:600;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px;}
        .grp-mail-cta:hover{background:#eff6ff;}
        .mail-hint{margin-left:8px;font-size:.66rem;font-weight:700;color:#1d4ed8;background:#eff6ff;border:1px solid #bfdbfe;border-radius:999px;padding:1px 7px;text-decoration:none;white-space:nowrap;vertical-align:middle;}
        .mem-modal{position:fixed;inset:0;z-index:1001;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;padding:20px;}
        .mem-modal[hidden]{display:none;}
        .mem-box{background:#fff;color:#1f2430;border-radius:12px;border-top:4px solid #2563eb;box-shadow:0 16px 50px rgba(0,0,0,.3);width:min(620px,95vw);max-height:88vh;overflow:auto;padding:22px 26px;position:relative;}
        .mem-close{position:absolute;top:10px;right:14px;background:none;border:none;font-size:22px;line-height:1;color:#6b7280;cursor:pointer;}
        .mem-close:hover{color:#111827;}
        .mem-title{font-size:14px;font-weight:700;color:#1e3a5f;margin:0 30px 14px 0;}
        .mem-tc{background:#dbeafe;color:#1d4ed8;border-radius:999px;padding:1px 9px;font-size:.72rem;font-weight:700;margin-left:6px;}
        .mem-list{display:flex;flex-direction:column;}
        .memr{display:grid;grid-template-columns:150px 1fr;gap:8px;padding:3px 0;break-inside:avoid;border-bottom:1px dashed #eef1f5;}
        .memr-n{font-weight:600;color:#1e3a5f;font-size:.8rem;word-break:break-word;}
        .memr-t{color:#6b7280;font-size:.72rem;text-transform:uppercase;}
        .mails-modal{position:fixed;inset:0;z-index:1000;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;padding:20px;}
        .mails-modal[hidden]{display:none;}
        .mails-box{background:#fff;color:#1f2430;border-radius:12px;border-top:4px solid #2563eb;box-shadow:0 16px 50px rgba(0,0,0,.3);width:min(1680px,97vw);max-height:90vh;overflow:auto;padding:0 26px 20px;position:relative;}
        .mails-head{position:sticky;top:0;background:#fff;z-index:5;padding:18px 0 8px;border-bottom:1px solid #e2e5ea;}
        .mails-actions{position:absolute;top:16px;right:0;display:flex;align-items:center;gap:6px;z-index:6;}
        .mails-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid #d5dbe4;background:#f6f8fb;color:#4b5568;border-radius:6px;cursor:pointer;padding:0;}
        .mails-icon:hover{background:#e8eef6;color:#1e3a5f;}
        .mm-tcount{background:#dbeafe;color:#1d4ed8;border-radius:999px;padding:1px 9px;font-size:.72rem;font-weight:700;margin-left:8px;vertical-align:middle;}
        .mails-btn{background:#eef2f8;border:1px solid #c3d0e0;color:#374151;padding:7px 14px;border-radius:6px;font-size:12.5px;font-weight:600;cursor:pointer;}
        .mails-btn:hover{background:#e2e8f0;}
        .mails-tree.mode-names .mm-item .mm-mail{display:none;}
        .mails-tree.mode-mails .mm-item .mm-cname{display:none;}
        .mm-colcount{font-size:.7rem;font-weight:700;color:#3730a3;background:#eef2ff;padding:4px 10px;border-bottom:1px solid #e2e5ea;}
        .mails-close{background:none;border:none;font-size:22px;line-height:1;color:#6b7280;cursor:pointer;padding:0 2px;}
        .mails-close:hover{color:#111827;}
        .mails-title{font-size:14px;font-weight:700;color:#1e3a5f;margin:0 80px 0 0;}
        .mails-title .mm-tmail{font-family:"Cascadia Code",Consolas,monospace;font-size:.78rem;color:#6b7280;font-weight:400;margin-left:8px;}
        .mm-cols{display:grid;gap:18px;align-items:start;}
        .mm-cols-1{grid-template-columns:minmax(0,1fr);}
        .mm-cols-2{grid-template-columns:repeat(2,minmax(0,1fr));}
        .mm-cols-3{grid-template-columns:repeat(3,minmax(0,1fr));}
        .mm-cols-4{grid-template-columns:repeat(4,minmax(0,1fr));}
        .mm-col{border:1px solid #e2e5ea;border-radius:8px;}
        .mm-colhead{position:sticky;top:56px;background:#fff;z-index:3;border-radius:8px 8px 0 0;overflow:hidden;}
        .mm-do{background:#f0f5fc;border-bottom:1px solid #d5dbe4;border-left:4px solid #2563eb;padding:8px 10px;display:flex;align-items:center;flex-wrap:wrap;gap:6px;}
        .mm-do .mm-cname{font-weight:700;font-size:.82rem;color:#1e3a5f;flex-basis:100%;word-break:break-word;}
        .mm-do .mm-count{background:#374151;color:#fff;border-radius:999px;padding:0 7px;font-size:.7rem;font-weight:700;}
        .mm-list{padding:6px 8px;display:flex;flex-direction:column;gap:2px;}
        .mm-item{display:flex;align-items:center;gap:8px;padding:3px 2px;border-bottom:1px dashed #eef1f5;}
        .mm-item-txt{display:flex;flex-direction:column;min-width:0;flex:1;}
        .mm-icount{flex:none;background:#374151;color:#fff;border-radius:999px;padding:0 8px;font-size:.66rem;font-weight:700;}
        .mm-item-mem{cursor:pointer;border-radius:4px;}
        .mm-item-mem:hover{background:#eef1f5;}
        .mm-cname{font-weight:600;font-size:.78rem;color:#334155;word-break:break-word;}
        .mm-mail{font-family:"Cascadia Code",Consolas,monospace;font-size:.72rem;color:#6b7280;word-break:break-all;}
        .mails-foot{margin-top:14px;display:flex;align-items:center;gap:12px;}
        .mails-copy{background:#2563eb;border:none;color:#fff;padding:7px 14px;border-radius:6px;font-size:12.5px;font-weight:600;cursor:pointer;}
        .mails-copy:hover{background:#1d4ed8;}
        .mails-copied{font-size:.8rem;color:#16a34a;}
        .doc-hd h1{margin:0 0 6px;font-size:1.35rem;}
        .doc-meta{opacity:.94;font-size:.72rem;}
        .doc-meta b{color:#fff;}
        .doc-filter{opacity:.9;font-size:.72rem;margin-top:3px;color:#e5e7eb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}
        .doc-filter b{color:#fff;font-weight:700;}
        .wrap{max-width:none;margin:0 auto;padding:14px 28px 60px;}
        .filter-box{background:#fff;border:1px solid #e2e5ea;border-left:4px solid #6b7280;border-radius:10px;padding:10px 16px;margin:0 0 10px;}
        .filter-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;margin-bottom:6px;}
        .fl-row{font-size:.86rem;margin:5px 0;}
        .fl-tag{display:inline-block;font-size:9px;font-weight:700;padding:2px 8px;border-radius:999px;margin-right:6px;background:#e5e7eb;color:#374151;vertical-align:middle;}
        .fl-tag.inc{background:#dcfce7;color:#166534;}
        .fl-tag.exc{background:#fee2e2;color:#991b1b;}
        .fl-list{margin:5px 0 0;padding-left:24px;}
        .fl-list li{margin:2px 0;}
        .fl-note{color:#6b7280;font-size:.8rem;margin-top:9px;}
        .toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;}
        .search-wrap{position:relative;flex:1;min-width:230px;}
        .toolbar #q{width:100%;height:34px;padding:0 32px 0 12px;border:1px solid #cbd0d8;border-radius:8px;font-size:13px;font-family:inherit;}
        .qclear{position:absolute;right:8px;top:50%;transform:translateY(-50%);border:none;background:#cbd0d8;color:#fff;width:18px;height:18px;border-radius:50%;cursor:pointer;font-size:13px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0;}
        .qclear:hover{background:#9ca3af;}
        .qclear[hidden]{display:none;}
        .toolbar select{height:34px;border:1px solid #cbd0d8;border-radius:8px;padding:0 8px;font-size:13px;font-family:inherit;background:#fff;}
        .toolbar button{height:34px;border:1px solid #cbd0d8;background:#fff;border-radius:8px;padding:0 12px;font-size:12.5px;font-weight:600;cursor:pointer;color:#374151;}
        .toolbar button:hover{background:#eef0f3;}
        .toolbar .count{font-size:.82rem;color:#6b7280;margin-left:auto;}
        .grp{border-radius:11px;border:1px solid #cbd5e1;padding:12px 16px;margin:9px 0;background:#fff;box-shadow:0 2px 7px rgba(15,23,42,.09);}
        .grp.lvl1{border:1px solid #c3d0e0;border-left:6px solid #1e3a5f;background:#eef2f8;}
        .grp.lvl2{border:1px solid #c3d4ee;border-left:6px solid #2563eb;background:#f0f5fc;margin-left:26px;}
        .grp.lvl3{border:1px solid #d5dbe4;border-left:6px solid #7c8ba1;background:#fafbfd;margin-left:52px;}
        .branch{margin:2px 0 12px;}
        .branch.collapsed .do-children{display:none;}
        .do-columns{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;align-items:start;margin:10px auto 0;}
        .do-columns.cols-3{grid-template-columns:repeat(3,minmax(0,1fr));max-width:75%;}
        .do-columns.cols-2{grid-template-columns:repeat(2,minmax(0,1fr));max-width:50%;}
        .do-columns.cols-1{grid-template-columns:minmax(0,1fr);max-width:25%;}
        .topbar-groups{padding:2px 28px 10px;}
        .topbar-groups .grp.lvl1{margin:6px 0 0;}
        .do-headers{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:8px auto 0;}
        .do-headers.cols-3{grid-template-columns:repeat(3,minmax(0,1fr));max-width:75%;}
        .do-headers.cols-2{grid-template-columns:repeat(2,minmax(0,1fr));max-width:50%;}
        .do-headers.cols-1{grid-template-columns:minmax(0,1fr);max-width:25%;}
        .do-head-cell .grp.lvl2{margin:0;}
        .do-centres{display:flex;flex-direction:column;gap:9px;}
        .do-centres.collapsed{display:none;}
        .do-centres .grp.lvl3{margin-left:16px;}
        .do-centres .members{columns:1;}
        .do-centres .members li{grid-template-columns:135px 1fr;}
        .grp-hd{display:flex;align-items:center;gap:9px;}
        .do-toggle{cursor:pointer;user-select:none;font-size:11px;color:#6b7280;width:12px;}
        .do-head{cursor:pointer;}
        .grp-badge{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:2px 9px;border-radius:999px;background:#e5e7eb;color:#4b5563;white-space:nowrap;}
        .grp-name{font-weight:700;font-size:.97rem;color:#1e3a5f;letter-spacing:.01em;word-break:normal;overflow-wrap:break-word;}
        .grp-count{margin-left:auto;background:#374151;color:#fff;border-radius:999px;padding:1px 10px;font-size:.78rem;font-weight:700;}
        .grp-gcount{margin-left:auto;background:#e0e7ff;color:#3730a3;border-radius:999px;padding:1px 9px;font-size:.72rem;font-weight:700;}
        .grp-gcount + .grp-count{margin-left:6px;}
        .grp-mail{font-family:"Cascadia Code",Consolas,monospace;font-size:.78rem;color:#6b7280;margin-top:3px;}
        .members{list-style:none;margin:9px 0 0;padding:8px 0 0;border-top:1px dashed #d5dae1;columns:2;column-gap:30px;}
        .members li{break-inside:avoid;display:grid;grid-template-columns:155px 1fr;column-gap:8px;align-items:baseline;padding:1px 0;font-size:.82rem;}
        .m-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .m-title{color:#6b7280;text-transform:uppercase;font-size:.72rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .grp.hide,.branch.hide,.mem.hide{display:none;}
        #tree.hide-members .members{display:none;}
        .empty{color:#6b7280;font-style:italic;}
        @media print{.toolbar{display:none;}body{background:#fff;}.doc-hd,.grp{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}
    `;
    const meta =
        `Préfixe <b>${esc(data.prefix || '')}</b> · Domaine <b>@${esc(data.mailDomain || '')}</b> · ` +
        `Niveau <b>${data.niveau}</b> · <b>${groups.length}</b> groupe(s) · <b>${data.total}</b> utilisateur(s)` +
        (data.cacheTs ? ` · Cache du <b>${esc(data.cacheTs)}</b>` : '');

    const pageScript =
`(function(){
  var q=document.getElementById('q');
  var cat=document.getElementById('cat');
  var countEl=document.getElementById('count');
  var mems=[].slice.call(document.querySelectorAll('.mem'));
  var grps=[].slice.call(document.querySelectorAll('.grp'));
  var branches=[].slice.call(document.querySelectorAll('.branch, .do-centres'));
  var g1=document.querySelector('.grp.lvl1');
  function apply(){
    var term=((q&&q.value)||'').trim().toLowerCase();
    var catVal=(cat&&cat.value)||'';
    mems.forEach(function(li){
      var ok=!term||(li.getAttribute('data-s')||'').indexOf(term)!==-1;
      li.classList.toggle('hide',!ok);
    });
    grps.forEach(function(g){
      var name=g.getAttribute('data-name')||'';
      if(term&&name.indexOf(term)!==-1){
        var ms=g.querySelectorAll('.mem'); for(var i=0;i<ms.length;i++){ms[i].classList.remove('hide');}
      }
    });
    var shown=0; mems.forEach(function(li){ if(!li.classList.contains('hide'))shown++; });
    grps.forEach(function(g){
      var name=g.getAttribute('data-name')||'';
      var nameMatch=!term||name.indexOf(term)!==-1;
      var hasMemAny=g.querySelectorAll('.mem').length>0;
      var hasMemVis=g.querySelectorAll('.mem:not(.hide)').length>0;
      var visible=!term||nameMatch||hasMemVis;
      g.classList.toggle('hide',hasMemAny?!visible:false);
    });
    branches.forEach(function(b){
      var doName=b.getAttribute('data-do')||'';
      var catOk=!catVal||doName===catVal;
      var doMatch=!term||doName.toLowerCase().indexOf(term)!==-1;
      var hasVisChild=b.querySelectorAll('.grp.lvl3:not(.hide)').length>0;
      var termOk=!term||doMatch||hasVisChild;
      var show=catOk&&termOk;
      b.classList.toggle('hide',!show);
      var hc=document.querySelector('.do-head-cell[data-do="'+doName.replace(/"/g,'\\"')+'"]');
      if(hc)hc.classList.toggle('hide',!show);
    });
    if(g1){
      var hideG=!!catVal||(term&&(g1.getAttribute('data-name')||'').indexOf(term)===-1&&g1.querySelectorAll('.mem:not(.hide)').length===0);
      g1.classList.toggle('hide',hideG);
    }
    if(countEl)countEl.textContent=shown+' membre(s) affiche(s)';
  }
  var qc=document.getElementById('qclear');
  if(q){
    q.addEventListener('focus',function(){q.select();});
    q.addEventListener('input',function(){ if(qc)qc.hidden=!q.value; apply(); });
  }
  if(qc)qc.addEventListener('click',function(){ q.value=''; qc.hidden=true; apply(); q.focus(); });
  if(cat)cat.addEventListener('change',apply);
  [].slice.call(document.querySelectorAll('.do-head')).forEach(function(h){
    h.addEventListener('click',function(){ var br=h.closest('.branch'); if(br)br.classList.toggle('collapsed'); });
  });
  var cb=document.getElementById('collapseAll'); var col=false;
  if(cb)cb.addEventListener('click',function(){ col=!col; branches.forEach(function(b){b.classList.toggle('collapsed',col);}); cb.textContent=col?'Tout deplier':'Tout replier'; });
  var fsBtn=document.getElementById('fsBtn');
  if(fsBtn)fsBtn.addEventListener('click',function(){ if(document.fullscreenElement){document.exitFullscreen();}else{document.documentElement.requestFullscreen();} });
  var infoBtn=document.getElementById('infoBtn');
  var infoModal=document.getElementById('infoModal');
  var infoClose=document.getElementById('infoClose');
  function closeInfo(){ if(infoModal)infoModal.hidden=true; }
  if(infoBtn)infoBtn.addEventListener('click',function(){ if(infoModal)infoModal.hidden=false; });
  if(infoClose)infoClose.addEventListener('click',closeInfo);
  if(infoModal)infoModal.addEventListener('click',function(e){ if(e.target===infoModal)closeInfo(); });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape')closeInfo(); });

  // Modale des adresses mail sous-jacentes (clic sur un mail de niveau 1/2)
  var MT=window.MAILTREE||{};
  function eh(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];});}
  function mmItem(c){
    var hasMem=(window.GROUPMEMBERS||{})[c.name];
    return '<div class="mm-item'+(hasMem?' mm-item-mem':'')+'"'+(hasMem?' data-gkey="'+eh(c.name)+'" title="Voir les membres"':'')+'>'+
      '<div class="mm-item-txt"><span class="mm-cname">'+eh(c.name)+'</span><span class="mm-mail">'+eh(c.mail)+'</span></div>'+
      (c.count!=null?'<span class="mm-icount" title="Membres">'+c.count+'</span>':'')+
      '</div>';
  }
  function renderMails(node){
    var hasGC=node.children&&node.children.some(function(c){return c.children&&c.children.length;});
    if(hasGC){
      var n=Math.min(node.children.length,4);
      var h='<div class="mm-cols mm-cols-'+n+'">';
      node.children.forEach(function(dg){
        h+='<div class="mm-col"><div class="mm-colhead"><div class="mm-do"><span class="mm-cname">'+eh(dg.name)+'</span><span class="mm-count">'+(dg.count!=null?dg.count:'')+'</span><span class="mm-mail">'+eh(dg.mail)+'</span></div>'+
           '<div class="mm-colcount">'+((dg.children||[]).length)+' groupe(s)</div></div>'+
           '<div class="mm-list">'+(dg.children||[]).map(mmItem).join('')+'</div></div>';
      });
      return h+'</div>';
    }
    return '<div class="mm-list">'+(node.children||[]).map(mmItem).join('')+'</div>';
  }
  function collectMails(node,arr){ if(node.mail)arr.push(node.mail); if(node.children)node.children.forEach(function(c){collectMails(c,arr);}); }
  var mailsModal=document.getElementById('mailsModal'); var currentMails=[];
  function openMails(key){
    var node=MT[key]; if(!node||!mailsModal)return;
    currentMails=[]; collectMails(node,currentMails);
    document.getElementById('mailsTitle').innerHTML=eh(node.name)+' <span class="mm-tmail">'+eh(node.mail)+'</span> <span class="mm-tcount">'+currentMails.length+' groupe(s)</span>';
    document.getElementById('mailsTree').innerHTML=renderMails(node);
    var cp=document.getElementById('mailsCopied'); if(cp)cp.textContent='';
    applyMmMode();
    mailsModal.hidden=false;
    var head=mailsModal.querySelector('.mails-head');
    var hh=head?head.offsetHeight:0;
    var chs=mailsModal.querySelectorAll('.mm-colhead');
    for(var i=0;i<chs.length;i++)chs[i].style.top=(hh-1)+'px';
  }
  function closeMails(){ if(mailsModal)mailsModal.hidden=true; }
  [].slice.call(document.querySelectorAll('.grp-mail-link')).forEach(function(el){ el.addEventListener('click',function(){ openMails(el.getAttribute('data-key')); }); });
  var mailsClose=document.getElementById('mailsClose'); if(mailsClose)mailsClose.addEventListener('click',closeMails);
  if(mailsModal)mailsModal.addEventListener('click',function(e){ if(e.target===mailsModal)closeMails(); });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape'&&(!memModal||memModal.hidden))closeMails(); });
  var mailsCopy=document.getElementById('mailsCopy');
  if(mailsCopy)mailsCopy.addEventListener('click',function(){
    var txt=currentMails.join('; ');
    try{ if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(txt); }catch(e){}
    var cp=document.getElementById('mailsCopied'); if(cp)cp.textContent=currentMails.length+' adresse(s) copiee(s)';
  });
  var mmModes=['both','names','mails'], mmLbl={both:'Tout',names:'Noms seuls',mails:'Mails seuls'}, mmIdx=0;
  function applyMmMode(){ var t=document.getElementById('mailsTree'); if(t)t.className='mails-tree mode-'+mmModes[mmIdx]; var b=document.getElementById('mailsMode'); if(b)b.title='Affichage : '+mmLbl[mmModes[mmIdx]]; }
  var mailsMode=document.getElementById('mailsMode'); if(mailsMode)mailsMode.addEventListener('click',function(){ mmIdx=(mmIdx+1)%mmModes.length; applyMmMode(); });
  applyMmMode();

  // Modale des membres (clic sur un groupe/mail qui possede des membres)
  var GM=window.GROUPMEMBERS||{};
  var memModal=document.getElementById('memModal');
  function openMembers(key){
    var mem=GM[key]; if(!mem||!memModal)return;
    document.getElementById('memTitle').innerHTML=eh(key)+' <span class="mem-tc">'+mem.length+' membre(s)</span>';
    document.getElementById('memList').innerHTML=mem.map(function(m){return '<div class="memr"><span class="memr-n">'+eh(m.n)+'</span><span class="memr-t">'+eh(m.t)+'</span></div>';}).join('');
    memModal.hidden=false;
  }
  function closeMembers(){ if(memModal)memModal.hidden=true; }
  // Clic sur un groupe (centre) DANS la modale des adresses → sa liste de membres
  var mailsTreeEl=document.getElementById('mailsTree');
  if(mailsTreeEl)mailsTreeEl.addEventListener('click',function(e){ var it=e.target.closest?e.target.closest('.mm-item-mem'):null; if(it)openMembers(it.getAttribute('data-gkey')); });
  var memClose=document.getElementById('memClose'); if(memClose)memClose.addEventListener('click',closeMembers);
  if(memModal)memModal.addEventListener('click',function(e){ if(e.target===memModal)closeMembers(); });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape')closeMembers(); });
  var tmBtn=document.getElementById('toggleMembers');
  var treeEl=document.getElementById('tree');
  if(tmBtn&&treeEl)tmBtn.addEventListener('click',function(){ var h=treeEl.classList.toggle('hide-members'); tmBtn.textContent=h?'Afficher les membres':'Masquer les membres'; });
  apply();
})();`;

    return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">' +
        '<title>Groupes — ' + esc(data.prefix || '') + '</title><style>' + css + '</style></head><body>' +
        '<div class="topbar">' +
            '<header class="doc-hd">' +
                '<div class="doc-hd-txt"><div class="doc-eyebrow">Prévisualisation des groupes AD</div><h1>' + esc(data.prefix || 'Groupe') + '</h1></div>' +
                '<div class="doc-hd-actions">' +
                    '<button id="infoBtn" class="info-btn" type="button" title="Détails et filtre du groupe">' +
                        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>' +
                    '</button>' +
                    '<button id="fsBtn" class="fs-btn" type="button" title="Plein écran (F11)">' +
                        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>' +
                        '<span>Plein écran</span>' +
                    '</button>' +
                '</div>' +
            '</header>' +
            '<div class="topbar-inner">' +
                toolbar + datalistHtml +
            '</div>' +
            stickyGroups +
        '</div>' +
        '<div class="wrap"><main id="tree">' + mainBody + '</main></div>' +
        '<div class="info-modal" id="infoModal" hidden><div class="info-box">' +
            '<button class="info-close" id="infoClose" type="button" aria-label="Fermer">×</button>' +
            '<div class="info-meta">' + meta + '</div>' +
            '<div class="info-title">Comment ce groupe est filtré</div>' +
            filterHtml +
        '</div></div>' +
        '<div class="mails-modal" id="mailsModal" hidden><div class="mails-box">' +
            '<div class="mails-head">' +
                '<div class="mails-actions">' +
                    '<button id="mailsMode" class="mails-icon" type="button" title="Affichage : Tout">' +
                        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>' +
                    '</button>' +
                    '<button class="mails-close" id="mailsClose" type="button" aria-label="Fermer">×</button>' +
                '</div>' +
                '<div class="mails-title" id="mailsTitle"></div>' +
            '</div>' +
            '<div class="mails-tree" id="mailsTree"></div>' +
        '</div></div>' +
        '<div class="mem-modal" id="memModal" hidden><div class="mem-box">' +
            '<button class="mem-close" id="memClose" type="button" aria-label="Fermer">×</button>' +
            '<div class="mem-title" id="memTitle"></div>' +
            '<div class="mem-list" id="memList"></div>' +
        '</div></div>' +
        '<script>window.MAILTREE=' + JSON.stringify(mailTree).replace(/</g, '\\u003c') + ';window.GROUPMEMBERS=' + JSON.stringify(groupMembers).replace(/</g, '\\u003c') + ';</script>' +
        '<script>' + pageScript + '</script>' +
        '</body></html>';
}

async function previewGroups() {
    const rule = readForm();
    if (!rule) return;

    const btn = document.getElementById('btn-preview-groups');
    if (btn) { btn.disabled = true; btn.textContent = 'Chargement…'; }

    try {
        await fetchAndShowPreview(rule);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML =
            `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Prévisualiser les groupes`; }
    }
}

function showGroupsPreviewModal(data, sourceRule = null) {
    const modal   = document.getElementById('groups-preview-modal');
    const summary = document.getElementById('gp-summary');
    const meta    = document.getElementById('gp-meta');
    const body    = document.getElementById('gp-body');

    const allGroups = data.groups || [];
    const warnings  = allGroups.filter(g => g.name.length > 64).length;
    const monoNiv   = !!data.monoNiveau;

    summary.textContent = `${allGroups.length} groupe${allGroups.length !== 1 ? 's' : ''} · ${data.total} utilisateur${data.total !== 1 ? 's' : ''}`;

    const globalGroup = allGroups.find(g => g.type === 'global');
    const doGroups    = allGroups.filter(g => g.type === 'do').sort((a, b) => a.name.localeCompare(b.name));
    const centres     = allGroups.filter(g => g.type === 'centre');

    for (const dg of doGroups) {
        dg._centres = centres
            .filter(c => c.name.startsWith(dg.name + '-'))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    const hasGlobal = !!globalGroup;
    const hasDO     = doGroups.length > 0;
    const hasCentre = centres.length > 0;
    const numCols   = [hasGlobal, hasDO, hasCentre].filter(Boolean).length;

    const niveauLabel = data.niveau
        ? `Niveau ${data.niveau}${(monoNiv && data.niveau === 3) ? ' — CSV : centres uniquement' : ''}`
        : '';

    meta.innerHTML =
        `<span class="gp-meta-item"><strong>Préfixe :</strong> ${esc(data.prefix)}</span>` +
        `<span class="gp-meta-item"><strong>Domaine :</strong> @${esc(data.mailDomain)}</span>` +
        (niveauLabel ? `<span class="gp-meta-item">${esc(niveauLabel)}</span>` : '') +
        (warnings ? `<span class="gp-meta-warn">⚠ ${warnings} nom${warnings > 1 ? 's' : ''} dépasse${warnings > 1 ? 'nt' : ''} 64 caractères</span>` : '') +
        (data.cacheTs ? `<span class="gp-meta-cache" title="Liste issue du cache local, pas d'une lecture AD en direct — rafraîchir le cache dans l'Explorateur AD (↻) pour des données à jour">🕓 Cache du ${esc(data.cacheTs)} — pensez à rafraîchir</span>` : '');

    const peerRule = sourceRule
        ? (sourceRule.invertOf
            ? rules.find(r => r.id === sourceRule.invertOf)
            : rules.find(r => r.invertOf === sourceRule.id))
        : null;

    const SVG_CHV = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2.5 1.5l5 3.5-5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

    const SVG_EYE_PEER = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

    function buildRow(g, { clickable = false, showBadge = true, baseLabel = '', hasPeer = false, peerLabel = '' } = {}) {
        const isWarn    = g.name.length > 64;
        const typeLabel = g.type === 'global' ? 'Global' : g.type === 'do' ? 'DO' : 'Centre';
        const n         = g.count ?? 0;

        let membersHtml = '';
        if (g.members && g.members.length > 0) {
            membersHtml = `<div class="gp-members-list">` +
                g.members.map(m =>
                    `<div class="gp-member">` +
                        `<span class="gp-member-name">${esc(m.name)}</span>` +
                        (m.title ? `<span class="gp-member-title">${esc(m.title)}</span>` : '') +
                    `</div>`
                ).join('') +
            `</div>`;
        }

        const eyeBtn = hasPeer
            ? `<button class="btn-gp-eye-peer" data-tooltip="Voir ${esc(peerLabel)}" tabindex="-1">${SVG_EYE_PEER}</button>`
            : '';

        const baseAttr = baseLabel ? ` data-base="${esc(baseLabel)}"` : '';
        return `<div class="gp-row-item${clickable ? ' clickable' : ''}${isWarn ? ' gp-warn' : ''}" data-name="${esc(g.name)}"${baseAttr}>` +
            (showBadge ? `<span class="gp-type-badge gp-type-${g.type}">${typeLabel}</span>` : '') +
            `<div class="gp-row-info">` +
                `<div class="gp-row-top">` +
                    `<div class="gp-row-name">${esc(g.name)}</div>` +
                    eyeBtn +
                    `<div class="gp-row-count" title="${n} utilisateur${n !== 1 ? 's' : ''}">${n}</div>` +
                `</div>` +
                `<div class="gp-row-mail">${esc(g.mail)}</div>` +
                membersHtml +
            `</div>` +
            (clickable ? `<span class="gp-row-chevron">${SVG_CHV}</span>` : '') +
            `</div>`;
    }

    let cols = '';

    const peerOpts = peerRule ? { hasPeer: true, peerLabel: peerRule.label } : {};

    if (hasGlobal) {
        cols += `<div class="gp-col">` +
            `<div class="gp-col-hdr">Groupe global</div>` +
            `<div class="gp-col-list">${buildRow(globalGroup, { ...peerOpts })}</div>` +
            `</div>`;
    }

    if (hasDO) {
        const doItems = doGroups.map(dg => buildRow(dg, { clickable: hasCentre, showBadge: false, ...peerOpts })).join('');
        cols += `<div class="gp-col">` +
            `<div class="gp-col-hdr">` +
                `Groupes DO <span class="gp-col-count">${doGroups.length}</span>` +
            `</div>` +
            `<div class="gp-col-list" id="gp-col-do-list">${doItems}</div>` +
            `</div>`;
    }

    if (hasCentre) {
        const initContent = hasDO
            ? `<div class="gp-col-empty">Cliquer sur un groupe DO<br>pour afficher ses centres</div>`
            : centres.map(c => buildRow(c, { showBadge: false, ...peerOpts })).join('');
        const countBadge = hasDO ? '' : ` <span class="gp-col-count">${centres.length}</span>`;
        cols += `<div class="gp-col">` +
            `<div class="gp-col-hdr" id="gp-col-centre-hdr">Centres${countBadge}</div>` +
            `<div class="gp-col-search">` +
                `<input type="text" id="gp-centre-search" class="gp-search-input" placeholder="Groupe, utilisateur, fonction…" autocomplete="off">` +
                `<button id="gp-centre-search-clear" class="gp-search-clear" title="Vider la recherche" hidden>` +
                    `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>` +
                `</button>` +
            `</div>` +
            `<div class="gp-col-list" id="gp-col-centre-list">${initContent}</div>` +
            `</div>`;
    }

    body.innerHTML = `<div class="gp-columns gp-cols-${numCols}">${cols}</div>`;

    if (hasCentre) {
        const centreSearch      = body.querySelector('#gp-centre-search');
        const centreSearchClear = body.querySelector('#gp-centre-search-clear');
        const centreList        = body.querySelector('#gp-col-centre-list');

        function applycentreSearch() {
            const q = centreSearch.value.trim().toLowerCase();
            centreSearchClear.hidden = !centreSearch.value;
            centreList.querySelectorAll('.gp-row-item').forEach(card => {
                if (!q) { card.classList.remove('gp-hidden'); return; }
                const groupName = (card.querySelector('.gp-row-name')?.textContent  || '').toLowerCase();
                const members   = [...card.querySelectorAll('.gp-member-name, .gp-member-title')]
                    .map(el => el.textContent.toLowerCase()).join(' ');
                card.classList.toggle('gp-hidden', !groupName.includes(q) && !members.includes(q));
            });
        }

        centreSearch.addEventListener('input', applycentreSearch);
        centreSearch.addEventListener('focus', () => centreSearch.select());
        centreSearchClear.addEventListener('click', () => {
            centreSearch.value = '';
            applycentreSearch();
            centreSearch.focus();
        });

        if (hasDO) {
            const doList    = body.querySelector('#gp-col-do-list');
            const centreHdr = body.querySelector('#gp-col-centre-hdr');

            doList.addEventListener('click', e => {
                const card = e.target.closest('.gp-row-item.clickable');
                if (!card) return;
                const dg = doGroups.find(d => d.name === card.dataset.name);
                if (!dg) return;

                doList.querySelectorAll('.gp-row-item').forEach(r => r.classList.remove('gp-selected'));
                card.classList.add('gp-selected');

                const activeCount = dg._centres.filter(c => (c.count ?? 0) > 0).length;
                const zeroCount   = dg._centres.length - activeCount;
                const zeroNote    = zeroCount > 0 ? ` (excluant ${zeroCount} avec 0 utilisateur)` : '';
                centreHdr.innerHTML = `${esc(dg.name)} — <span class="gp-col-count">${activeCount} Groupe${activeCount !== 1 ? 's' : ''}${zeroNote}</span> · ${dg.count ?? 0} pers.`;

                const centreHtml = dg._centres.map(c => buildRow(c, { showBadge: false, ...peerOpts })).join('');

                centreList.innerHTML = dg._centres.length
                    ? centreHtml
                    : `<div class="gp-col-empty">Aucun centre pour ce groupe DO</div>`;
                centreSearch.value = '';
                centreSearchClear.hidden = true;
            });
        }
    }

    // Reset tabs — toujours ouvrir sur l'onglet Groupes
    const tabsBar = document.getElementById('gp-tabs');
    tabsBar.querySelectorAll('.gp-tab').forEach(t => t.classList.remove('gp-tab--active'));
    tabsBar.querySelector('[data-tab="groupes"]').classList.add('gp-tab--active');
    body.removeAttribute('hidden');
    const mailPanel = document.getElementById('gp-mail-panel');
    mailPanel.setAttribute('hidden', '');
    delete mailPanel.dataset.rendered;
    modal._gpData = data;

    // ── Icônes œil sur chaque carte — ouvre la mini-modale de l'autre règle ──
    if (modal._peerClickListener) {
        body.removeEventListener('click', modal._peerClickListener);
        modal._peerClickListener = null;
    }
    if (peerRule) {
        modal._peerData  = null;
        modal._peerRule  = peerRule;
        modal._curPrefix = data.prefix;

        const peerClickListener = async e => {
            const btn = e.target.closest('.btn-gp-eye-peer');
            if (!btn) return;
            e.stopPropagation();
            const card      = btn.closest('.gp-row-item');
            const groupName = card?.dataset.name || '';

            // Surbrillance de la carte active
            if (modal._peerActiveCard && modal._peerActiveCard !== card) {
                modal._peerActiveCard.classList.remove('gp-peer-active');
            }
            if (card) { card.classList.add('gp-peer-active'); modal._peerActiveCard = card; }

            btn.disabled = true;
            if (!modal._peerData) {
                try {
                    const r = await fetch('/api/regles/preview-groups', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(modal._peerRule),
                    });
                    const d = await r.json();
                    if (d.error) { showToast(d.error, 'error'); btn.disabled = false; return; }
                    modal._peerData = d;
                } catch { showToast('Erreur', 'error'); btn.disabled = false; return; }
            }
            btn.disabled = false;

            const curPrefix  = modal._curPrefix;
            const peerPrefix = modal._peerData.prefix;
            const suffix     = groupName === curPrefix ? '' : groupName.startsWith(curPrefix + '-') ? groupName.slice(curPrefix.length + 1) : groupName;
            const peerName   = suffix ? `${peerPrefix}-${suffix}` : peerPrefix;
            const peerGroup  = (modal._peerData.groups || []).find(g => g.name === peerName);

            showPeerGroupMini(peerGroup || null, peerName, modal._peerRule.label, btn, () => {
                if (modal._peerActiveCard) {
                    modal._peerActiveCard.classList.remove('gp-peer-active');
                    modal._peerActiveCard = null;
                }
            });
        };
        modal._peerClickListener = peerClickListener;
        body.addEventListener('click', peerClickListener);
    }

    modal.removeAttribute('hidden');
}

function showPeerGroupMini(group, peerName, peerRuleLabel, anchorEl, onClose) {
    let mini = document.getElementById('peer-group-mini');
    if (!mini) {
        mini = document.createElement('div');
        mini.id = 'peer-group-mini';
        mini.className = 'peer-mini';
        document.body.appendChild(mini);

        let _dx = 0, _dy = 0, _ox = 0, _oy = 0;
        mini.addEventListener('pointerdown', e => {
            if (e.button !== 0 || e.target.closest('button')) return;
            _ox = e.clientX - _dx; _oy = e.clientY - _dy;
            mini.style.cursor = 'grabbing';
            mini.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        mini.addEventListener('pointermove', e => {
            if (!mini.hasPointerCapture(e.pointerId)) return;
            _dx = e.clientX - _ox; _dy = e.clientY - _oy;
            mini.style.transform = `translate(${_dx}px,${_dy}px)`;
        });
        const stopDrag = () => { mini.style.cursor = ''; };
        mini.addEventListener('pointerup', stopDrag);
        mini.addEventListener('pointercancel', stopDrag);
    }

    // Fonction de fermeture partagée (bouton × + clic extérieur)
    function closeMini() {
        if (mini.hidden) return;
        mini.hidden = true;
        document.removeEventListener('mousedown', outsideHandler, true);
        if (typeof onClose === 'function') onClose();
    }

    // Clic extérieur : ferme si target hors de la mini ET hors du bouton œil
    function outsideHandler(e) {
        if (mini.hidden) { document.removeEventListener('mousedown', outsideHandler, true); return; }
        if (mini.contains(e.target)) return;
        if (e.target.closest('.btn-gp-eye-peer')) return;
        closeMini();
    }

    const n       = group?.count ?? 0;
    const members = (group?.members || []).slice().sort((a, b) =>
        (a.title || '').localeCompare(b.title || '') || (a.name || '').localeCompare(b.name || ''));

    let membersHtml = '';
    if (!members.length) {
        membersHtml = `<div class="peer-mini-empty">Aucun membre</div>`;
    } else {
        const byTitle = new Map();
        for (const m of members) {
            const key = m.title || '';
            if (!byTitle.has(key)) byTitle.set(key, []);
            byTitle.get(key).push(m);
        }
        for (const [title, list] of byTitle) {
            if (title) membersHtml += `<div class="peer-mini-fn-hdr">${esc(title)} <span class="peer-mini-fn-count">${list.length}</span></div>`;
            membersHtml += list.map(m =>
                `<div class="peer-mini-member"><span class="peer-mini-name">${esc(m.name)}</span></div>`
            ).join('');
        }
    }

    mini.innerHTML =
        `<div class="peer-mini-hdr">` +
            `<div class="peer-mini-title-wrap">` +
                `<span class="peer-mini-rule">${esc(peerRuleLabel)}</span>` +
                `<span class="peer-mini-name-badge">${esc(peerName)}</span>` +
                `<span class="peer-mini-count">${n} pers.</span>` +
            `</div>` +
            `<button class="peer-mini-close" title="Fermer"><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>` +
        `</div>` +
        `<div class="peer-mini-body">${membersHtml}</div>`;

    mini.querySelector('.peer-mini-close').addEventListener('click', closeMini);
    mini.style.transform = '';

    // Positionner près du bouton cliqué
    const rect = anchorEl.getBoundingClientRect();
    mini.style.top  = Math.min(rect.bottom + 6, window.innerHeight - 300) + 'px';
    mini.style.left = Math.max(0, Math.min(rect.left, window.innerWidth - 300)) + 'px';
    mini.hidden = false;

    // Activer le listener extérieur au prochain tick (évite que le mousedown courant le déclenche)
    setTimeout(() => document.addEventListener('mousedown', outsideHandler, true), 0);
}

const SVG_EXPAND   = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SVG_COLLAPSE = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M5 1v4H1M13 5H9V1M9 13v-4h4M1 9h4v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function setupGroupsPreviewModal() {
    const modal     = document.getElementById('groups-preview-modal');
    const box       = modal.querySelector('.gp-box');
    const closeBtn  = document.getElementById('btn-gp-close');
    const expandBtn = document.getElementById('btn-gp-expand');
    const tabsBar   = document.getElementById('gp-tabs');

    // ── Drag ─────────────────────────────────────────────────────────────
    let _dragX = 0, _dragY = 0, _dragOx = 0, _dragOy = 0;
    const header = box.querySelector('.gp-header');

    header.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        if (e.target.closest('button, input, label')) return;
        _dragOx = e.clientX - _dragX;
        _dragOy = e.clientY - _dragY;
        header.style.cursor = 'grabbing';
        header.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    header.addEventListener('pointermove', e => {
        if (!header.hasPointerCapture(e.pointerId)) return;
        _dragX = e.clientX - _dragOx;
        _dragY = e.clientY - _dragOy;
        box.style.transform = `translate(${_dragX}px,${_dragY}px)`;
    });
    const stopModalDrag = () => { header.style.cursor = ''; };
    header.addEventListener('pointerup', stopModalDrag);
    header.addEventListener('pointercancel', stopModalDrag);

    function closeModal() {
        // Annuler un contrôle AD en cours
        const mailPanel = document.getElementById('gp-mail-panel');
        if (mailPanel) mailPanel._checkAborted = true;
        box.classList.remove('gp-box--wide');
        expandBtn.innerHTML = SVG_EXPAND;
        expandBtn.title     = 'Agrandir';
        _dragX = 0; _dragY = 0;
        box.style.transform = '';
        const mini = document.getElementById('peer-group-mini');
        if (mini) mini.hidden = true;
        if (modal._peerActiveCard) { modal._peerActiveCard.classList.remove('gp-peer-active'); modal._peerActiveCard = null; }
        if (modal._peerClickListener) {
            const gpBody = document.getElementById('gp-body');
            if (gpBody) gpBody.removeEventListener('click', modal._peerClickListener);
            modal._peerClickListener = null;
        }
        modal.setAttribute('hidden', '');
    }

    expandBtn.addEventListener('click', () => {
        const wide = box.classList.toggle('gp-box--wide');
        expandBtn.innerHTML = wide ? SVG_COLLAPSE : SVG_EXPAND;
        expandBtn.title     = wide ? 'Réduire' : 'Agrandir';
    });
    closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

    // Checkbox affichage membres
    const chkMembers = document.getElementById('chk-gp-members');
    chkMembers.addEventListener('change', () => {
        box.classList.toggle('hide-members', !chkMembers.checked);
    });

    // Onglets
    tabsBar.addEventListener('click', e => {
        const tab = e.target.closest('.gp-tab');
        if (!tab) return;
        const tabName = tab.dataset.tab;

        tabsBar.querySelectorAll('.gp-tab').forEach(t => t.classList.remove('gp-tab--active'));
        tab.classList.add('gp-tab--active');

        const bodyEl    = document.getElementById('gp-body');
        const mailPanel = document.getElementById('gp-mail-panel');

        if (tabName === 'groupes') {
            bodyEl.removeAttribute('hidden');
            mailPanel.setAttribute('hidden', '');
        } else if (tabName === 'mails') {
            bodyEl.setAttribute('hidden', '');
            mailPanel.removeAttribute('hidden');
            if (!mailPanel.dataset.rendered) {
                renderMailTab(modal._gpData, mailPanel);
            }
        }
    });
}

function renderMailTab(data, container) {
    const allGroups = data.groups || [];

    const globalGroup = allGroups.find(g => g.type === 'global');
    const doGroups    = allGroups.filter(g => g.type === 'do').sort((a, b) => a.name.localeCompare(b.name));
    const centres     = allGroups.filter(g => g.type === 'centre');

    for (const dg of doGroups) {
        dg._centres = centres
            .filter(c => c.name.startsWith(dg.name + '-'))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    function mailRow(g) {
        const typeLabel = g.type === 'global' ? 'Global' : g.type === 'do' ? 'DO' : 'Centre';
        const n         = g.count ?? 0;
        return `<div class="gp-mail-row gp-mail-row--${g.type}" data-mail="${esc(g.mail)}">` +
            `<span class="gp-mail-row-type gp-mail-type-${g.type}">${typeLabel}</span>` +
            `<span class="gp-mail-row-name">${esc(g.name)}</span>` +
            `<span class="gp-mail-row-sep">→</span>` +
            `<span class="gp-mail-row-addr">${esc(g.mail)}</span>` +
            `<span class="gp-mail-row-count">${n} util.</span>` +
            `<span class="gp-mail-row-status"></span>` +
            `</div>`;
    }

    // Ordre visuel : global → DO → centres de cette DO → DO suivante → …
    const orderedGroups = [];
    if (globalGroup) orderedGroups.push(globalGroup);
    for (const dg of doGroups) {
        orderedGroups.push(dg);
        for (const c of dg._centres) orderedGroups.push(c);
    }

    let rows = '';
    if (globalGroup) rows += mailRow(globalGroup);
    for (const dg of doGroups) {
        rows += `<div class="gp-mail-separator"></div>`;
        rows += mailRow(dg);
        for (const c of dg._centres) rows += mailRow(c);
    }
    if (doGroups.length === 0) {
        for (const c of centres.sort((a, b) => a.name.localeCompare(b.name))) rows += mailRow(c);
    }

    const SVG_CHECK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
    const SVG_STOP  = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`;

    container.innerHTML =
        `<div class="gp-mail-toolbar">` +
            `<button class="btn-check-mails">${SVG_CHECK} Vérifier disponibilité dans l'AD</button>` +
            `<button class="btn-stop-mails" hidden>${SVG_STOP} Arrêter</button>` +
            `<div class="gp-check-progress" hidden>` +
                `<div class="gp-check-progress-label"></div>` +
                `<div class="gp-check-progress-bar-wrap"><div class="gp-check-progress-bar"></div></div>` +
            `</div>` +
            `<span class="gp-check-summary"></span>` +
        `</div>` +
        `<div class="gp-mail-tree">${rows}</div>`;

    container.querySelector('.btn-check-mails').addEventListener('click', () => checkMails(orderedGroups, container));
    container.querySelector('.btn-stop-mails').addEventListener('click',  () => { container._checkAborted = true; });
    container.dataset.rendered = '1';
}

async function checkMails(groups, container) {
    const btn      = container.querySelector('.btn-check-mails');
    const progress = container.querySelector('.gp-check-progress');
    const bar      = container.querySelector('.gp-check-progress-bar');
    const label    = container.querySelector('.gp-check-progress-label');
    const summary  = container.querySelector('.gp-check-summary');
    const tree     = container.querySelector('.gp-mail-tree');
    const total    = groups.length;
    if (total === 0) return;

    const stopBtn = container.querySelector('.btn-stop-mails');

    if (!confirm(`Vérifier la disponibilité de ${total} adresse${total > 1 ? 's' : ''} dans l'AD ?\n\nLe traitement se fait adresse par adresse depuis le début de la liste.`)) return;

    container._checkAborted = false;
    btn.setAttribute('hidden', '');
    stopBtn.removeAttribute('hidden');
    progress.removeAttribute('hidden');
    summary.textContent = '';

    tree.querySelectorAll('.gp-mail-row-status').forEach(el => {
        el.textContent = '';
        el.className   = 'gp-mail-row-status';
    });

    let available = 0, taken = 0, errors = 0;

    for (let i = 0; i < total; i++) {
        if (container._checkAborted) break;

        const addr = groups[i].mail;
        bar.style.width   = `${Math.round((i / total) * 100)}%`;
        label.textContent = `${i + 1}/${total}  ${addr}…`;

        const row        = tree.querySelector(`.gp-mail-row[data-mail="${CSS.escape(addr)}"]`);
        row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        const statusCell = row?.querySelector('.gp-mail-row-status');
        if (statusCell) {
            statusCell.textContent = 'vérification…';
            statusCell.className   = 'gp-mail-row-status gp-mail-status-checking';
        }

        try {
            const r = await fetch('/api/regles/check-mail', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ address: addr }),
            });
            const d = await r.json();
            if (d.error) {
                if (statusCell) { statusCell.textContent = '⚠ erreur'; statusCell.className = 'gp-mail-row-status gp-mail-status-error'; }
                errors++;
            } else if (d.available) {
                if (statusCell) { statusCell.textContent = '✓ disponible'; statusCell.className = 'gp-mail-row-status gp-mail-status-available'; }
                available++;
            } else {
                if (statusCell) { statusCell.textContent = '✗ pris'; statusCell.className = 'gp-mail-row-status gp-mail-status-taken'; }
                taken++;
            }
        } catch {
            if (statusCell) { statusCell.textContent = '⚠ erreur'; statusCell.className = 'gp-mail-row-status gp-mail-status-error'; }
            errors++;
        }
    }

    const aborted = container._checkAborted;
    bar.style.width   = aborted ? bar.style.width : '100%';
    label.textContent = aborted ? `Arrêté à ${i}/${total}` : `${total}/${total}  Terminé`;
    const parts = [];
    if (available > 0) parts.push(`${available} disponible${available > 1 ? 's' : ''}`);
    if (taken > 0)     parts.push(`${taken} pris`);
    if (errors > 0)    parts.push(`${errors} erreur${errors > 1 ? 's' : ''}`);
    if (aborted)       parts.push(`arrêté`);
    summary.textContent = parts.join(' · ');

    stopBtn.setAttribute('hidden', '');
    btn.removeAttribute('hidden');
    setTimeout(() => { progress.setAttribute('hidden', ''); }, 2500);
}

function buildFileTree(files) {
    const sorted = [...files].sort((a, b) => a.length - b.length);
    const bases  = sorted.map(f => f.replace(/\.csv$/i, ''));

    function directParent(base) {
        let best = null;
        for (const b of bases) {
            if (b !== base && base.startsWith(b + '-')) {
                if (!best || b.length > best.length) best = b;
            }
        }
        return best;
    }

    const nodes = new Map();
    for (let i = 0; i < sorted.length; i++) {
        nodes.set(bases[i], { file: sorted[i], base: bases[i], children: [] });
    }

    const roots = [];
    for (const [base, node] of nodes) {
        const p = directParent(base);
        if (p && nodes.has(p)) nodes.get(p).children.push(node);
        else roots.push(node);
    }
    return roots;
}

function renderFileTree(nodes, level = 0) {
    return nodes.map(node => {
        const hasKids = node.children.length > 0;
        const cls = (level === 0 && hasKids) ? 'csv-file-global'
                  : (level === 1 && hasKids) ? 'csv-file-do'
                  : 'csv-file-item';
        const kids = hasKids
            ? `<ul class="csv-file-list csv-file-sublist">${renderFileTree(node.children, level + 1)}</ul>`
            : '';
        return `<li class="${cls}" data-file="${esc(node.file)}">${esc(node.file)}${kids}</li>`;
    }).join('');
}

function formatCond(cond) {
    const fLabel  = FIELDS.find(([k]) => k === cond.field)?.[1] || cond.field;
    const opLabel = OPS.find(([k])   => k === cond.op)?.[1]    || cond.op;
    return `${fLabel} ${opLabel} "${cond.value}"`;
}

function showCsvModal(data, rule) {
    const label = rule?.label || '';
    document.getElementById('csv-modal-title').textContent = `CSV — ${label}`;
    const n = data.total;
    const f = data.files?.length || 0;
    document.getElementById('csv-modal-summary').textContent =
        `${n} utilisateur${n !== 1 ? 's' : ''} · ${f} fichier${f !== 1 ? 's' : ''}`;
    document.getElementById('csv-modal-footer').textContent = data.outDir || '';

    const criteria = document.getElementById('csv-modal-criteria');
    if (criteria) {
        const inc = rule?.conditions?.include || [];
        const exc = rule?.conditions?.exclude || [];
        let html = '';
        if (inc.length) {
            html += `<span class="crit-label crit-inc">INCLURE</span>` +
                inc.map(c => `<span class="crit-pill crit-pill-inc">${esc(formatCond(c))}</span>`).join('');
        }
        if (exc.length) {
            html += `<span class="crit-label crit-exc">EXCLURE</span>` +
                exc.map(c => `<span class="crit-pill crit-pill-exc">${esc(formatCond(c))}</span>`).join('');
        }
        criteria.innerHTML = html;
        criteria.hidden = !html;
    }

    const body   = document.getElementById('csv-modal-body');
    const files  = data.files || [];
    const outDir = data.outDir || '';

    // Réinitialiser l'état des panels
    body.removeAttribute('hidden');
    const csvMailPanel = document.getElementById('csv-mail-panel');
    csvMailPanel.setAttribute('hidden', '');
    delete csvMailPanel.dataset.rendered;

    const tabsEl = document.getElementById('csv-modal-tabs');
    if (data.groups && data.groups.length) {
        tabsEl.innerHTML =
            `<button class="csv-tab active" data-csv-tab="files">Fichiers CSV</button>` +
            `<button class="csv-tab" data-csv-tab="mails">` +
                `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 8 10 7 10-7"/></svg>` +
                ` Adresses mail` +
            `</button>`;
        document.getElementById('csv-modal')._csvData = data;
    } else {
        tabsEl.innerHTML = '';
    }

    if (!files.length) {
        body.innerHTML = '<p class="csv-empty">Aucun fichier généré</p>';
    } else {
        const tree = buildFileTree(files);
        body.innerHTML = `<ul class="csv-file-list">${renderFileTree(tree)}</ul>`;
        body.querySelectorAll('[data-file]').forEach(el => {
            el.addEventListener('click', e => {
                e.stopPropagation();
                openCsvFileModal(outDir, el.dataset.file);
            });
        });
    }

    document.getElementById('csv-modal').removeAttribute('hidden');
}

async function openCsvFileModal(dir, file) {
    const modal = document.getElementById('csv-file-modal');
    const title = document.getElementById('csv-file-modal-title');
    const body  = document.getElementById('csv-file-modal-body');

    title.textContent = file;
    body.innerHTML    = '<p class="csv-empty">Chargement…</p>';
    modal.removeAttribute('hidden');

    try {
        const r    = await fetch(`/api/csv/read?dir=${encodeURIComponent(dir)}&file=${encodeURIComponent(file)}`);
        const rows = await r.json();
        if (!Array.isArray(rows) || !rows.length) {
            body.innerHTML = '<p class="csv-empty">Aucun utilisateur</p>';
        } else {
            body.innerHTML =
                `<table class="csv-table">` +
                    `<thead><tr><th>Nom</th><th>Fonction</th></tr></thead>` +
                    `<tbody>${rows.map(r => `<tr><td>${esc(r.nom)}</td><td>${esc(r.fonction)}</td></tr>`).join('')}</tbody>` +
                `</table>`;
        }
    } catch {
        body.innerHTML = '<p class="csv-empty">Erreur de chargement</p>';
    }
}

function setupCsvFileModal() {
    document.getElementById('btn-csv-file-close').addEventListener('click', () => {
        document.getElementById('csv-file-modal').setAttribute('hidden', '');
    });
    document.getElementById('csv-file-modal').addEventListener('click', e => {
        if (e.target === e.currentTarget) e.currentTarget.setAttribute('hidden', '');
    });
}

function setupCsvModal() {
    const modal = document.getElementById('csv-modal');

    function closeCsvModal() {
        const csvMailPanel = document.getElementById('csv-mail-panel');
        if (csvMailPanel) csvMailPanel._checkAborted = true;
        document.getElementById('csv-modal-body').removeAttribute('hidden');
        csvMailPanel?.setAttribute('hidden', '');
        modal.setAttribute('hidden', '');
    }

    document.getElementById('btn-csv-close').addEventListener('click', closeCsvModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeCsvModal(); });

    // Onglets CSV
    document.getElementById('csv-modal-tabs').addEventListener('click', e => {
        const tab = e.target.closest('.csv-tab');
        if (!tab) return;
        const tabName = tab.dataset.csvTab;

        document.querySelectorAll('#csv-modal-tabs .csv-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const bodyEl       = document.getElementById('csv-modal-body');
        const csvMailPanel = document.getElementById('csv-mail-panel');

        if (tabName === 'files') {
            bodyEl.removeAttribute('hidden');
            csvMailPanel.setAttribute('hidden', '');
        } else if (tabName === 'mails') {
            bodyEl.setAttribute('hidden', '');
            csvMailPanel.removeAttribute('hidden');
            if (!csvMailPanel.dataset.rendered) {
                renderMailTab(modal._csvData, csvMailPanel);
            }
        }
    });
}

// ── Value picker ──────────────────────────────────────────────────────
function initPicker(valInput, fieldSel, wrap) {
    const panel    = wrap.querySelector('.val-picker-panel');
    let allValues  = [];
    const selected = new Set();

    function getUsedValues() {
        const row  = wrap.closest('.cond-row');
        const list = row?.closest('.cond-list');
        if (!list) return new Set();
        return new Set(
            [...list.querySelectorAll('.cond-row')]
                .filter(r => r !== row)
                .map(r => r.querySelector('.cond-val')?.value.trim())
                .filter(v => v)
        );
    }

    function available() {
        const used = getUsedValues();
        return used.size ? allValues.filter(v => !used.has(v)) : allValues;
    }

    async function loadValues() {
        const field = fieldSel.value;
        if (!adValuesCache[field]) {
            panel.innerHTML = `<div class="picker-empty">Chargement…</div>`;
            try {
                const r = await fetch(`/api/ad/values?field=${encodeURIComponent(field)}`);
                adValuesCache[field] = await r.json();
            } catch {
                adValuesCache[field] = [];
            }
        }
        allValues = adValuesCache[field];
        renderPickerItems(panel, available(), valInput.value, selected);
    }

    function updateFooter() {
        const footer = panel.querySelector('.picker-footer');
        if (!footer) return;
        footer.hidden = selected.size === 0;
        const btn = footer.querySelector('.btn-picker-validate');
        if (btn) btn.textContent = selected.size > 1 ? `Valider (${selected.size} valeurs)` : 'Valider';
    }

    function handleValidate() {
        if (!selected.size) return;
        const vals   = [...selected];
        valInput.value = vals[0];
        selected.clear();
        panel.hidden = true;

        if (vals.length > 1) {
            const currentRow = wrap.closest('.cond-row');
            const currentOp  = currentRow.querySelector('.cond-op').value;
            let   ref        = currentRow;
            for (let i = 1; i < vals.length; i++) {
                const newRow = createCondRow({ field: fieldSel.value, op: currentOp, value: vals[i] });
                ref.insertAdjacentElement('afterend', newRow);
                ref = newRow;
            }
        }
    }

    panel.addEventListener('click', e => {
        if (e.target.closest('.btn-picker-validate')) { handleValidate(); return; }

        const item = e.target.closest('.picker-item');
        if (!item) return;

        const val       = item.dataset.val;
        const chk       = item.querySelector('.picker-chk');
        const isChkClick = e.target === chk;

        if (!isChkClick && selected.size === 0) {
            valInput.value = val;
            panel.hidden   = true;
            return;
        }

        if (selected.has(val)) {
            selected.delete(val);
            chk.checked = false;
            item.classList.remove('checked');
        } else {
            selected.add(val);
            chk.checked = true;
            item.classList.add('checked');
        }
        updateFooter();
    });

    panel.addEventListener('mousedown', e => e.preventDefault());

    valInput.addEventListener('focus', () => { panel.hidden = false; loadValues(); });
    valInput.addEventListener('blur',  () => { setTimeout(() => { panel.hidden = true; }, 150); });
    valInput.addEventListener('input', () => {
        panel.hidden = false;
        renderPickerItems(panel, available(), valInput.value, selected);
    });
    fieldSel.addEventListener('change', () => { if (!panel.hidden) loadValues(); });
}

function renderPickerItems(panel, allValues, query, selected = new Set()) {
    const q = (query || '').trim().toLowerCase();
    const filtered = q
        ? allValues.filter(v => v.toLowerCase().includes(q))
        : allValues;

    if (!filtered.length) {
        panel.innerHTML = `<div class="picker-empty">${q ? 'Aucun résultat' : 'Aucune valeur dans le cache'}</div>`;
        return;
    }

    const groups = new Map();
    for (const v of filtered) {
        const key = (v.split(/\s+/)[0] || '—').toUpperCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(v);
    }

    let html = '';
    const multiGroup = groups.size > 1;
    for (const [key, vals] of groups) {
        if (multiGroup) {
            html += `<div class="picker-group-hdr">${esc(key)}<span class="picker-group-count">${vals.length}</span></div>`;
        }
        for (const v of vals) {
            const chk = selected.has(v);
            html += `<div class="picker-item${chk ? ' checked' : ''}" data-val="${esc(v)}">` +
                `<input type="checkbox" class="picker-chk"${chk ? ' checked' : ''}>` +
                `<span class="picker-item-text">${esc(v)}</span>` +
            `</div>`;
        }
    }

    const nSel = selected.size;
    html += `<div class="picker-footer"${nSel === 0 ? ' hidden' : ''}>` +
        `<button class="btn-picker-validate">${nSel > 1 ? `Valider (${nSel} valeurs)` : 'Valider'}</button>` +
    `</div>`;

    panel.innerHTML = html;
}

// ── Modal JSON ────────────────────────────────────────────────────────
function setupJsonModal() {
    const modal = document.getElementById('json-modal');
    document.getElementById('btn-json-close').addEventListener('click', () => { modal.hidden = true; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) modal.hidden = true; });

    document.getElementById('btn-json-copy').addEventListener('click', () => {
        const text = JSON.stringify(rules, null, 2);
        navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById('btn-json-copy');
            btn.textContent = 'Copié !';
            setTimeout(() => { btn.textContent = 'Copier'; }, 1800);
        });
    });
}

// ── Modal Aide ────────────────────────────────────────────────────────
function setupHelpModal() {
    const modal = document.getElementById('help-modal');
    document.getElementById('btn-help').addEventListener('click',       () => { modal.hidden = false; });
    document.getElementById('btn-help-close').addEventListener('click', () => { modal.hidden = true; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
    });
}

// ── Tooltip ───────────────────────────────────────────────────────────
function setupTooltip() {
    const tip = document.createElement('div');
    tip.className = 'custom-tooltip';
    tip.hidden = true;
    document.body.appendChild(tip);

    let activeEl = null;

    document.addEventListener('mouseover', e => {
        const el = e.target.closest('[data-tooltip]');
        if (!el || el === activeEl) return;
        activeEl = el;
        tip.textContent = el.dataset.tooltip;
        tip.hidden = false;
        positionTip(el);
    });

    document.addEventListener('mouseout', e => {
        const el = e.target.closest('[data-tooltip]');
        if (!el) return;
        if (el.contains(e.relatedTarget)) return;
        tip.hidden = true;
        activeEl = null;
    });

    function positionTip(el) {
        const rect = el.getBoundingClientRect();
        tip.style.cssText = 'left:0;top:0;transform:none';
        tip.hidden = false;
        const tw = tip.offsetWidth;
        const th = tip.offsetHeight;
        let left = rect.left + rect.width / 2 - tw / 2;
        left = Math.max(6, Math.min(left, window.innerWidth - tw - 6));
        const above = rect.top - th - 8;
        const below = rect.bottom + 6;
        tip.style.left = left + 'px';
        tip.style.top  = (above >= 6 ? above : below) + 'px';
    }
}

function openJsonModal() {
    const modal    = document.getElementById('json-modal');
    const pre      = document.getElementById('json-content');
    const countEl  = document.getElementById('json-rule-count');

    countEl.textContent = `${rules.length} règle${rules.length !== 1 ? 's' : ''}`;
    pre.innerHTML = jsonHighlight(JSON.stringify(rules, null, 2));
    modal.hidden  = false;
}

function jsonHighlight(json) {
    const safe = json
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    return safe.replace(
        /("(\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
        match => {
            if (/^"/.test(match)) {
                return /:$/.test(match)
                    ? `<span class="jk">${match}</span>`   // clé
                    : `<span class="js">${match}</span>`;  // chaîne
            }
            if (match === 'true' || match === 'false') return `<span class="jb">${match}</span>`;
            if (match === 'null')                       return `<span class="jn">${match}</span>`;
            return `<span class="ji">${match}</span>`;    // nombre
        }
    );
}

// ── Helpers ───────────────────────────────────────────────────────────
function esc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function uid()  { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function now()  { return new Date().toISOString().slice(0, 19); }

let _toastTimer;
window.addEventListener('message', e => {
    if (e.data?.type !== 'tab-activated') return;
    const raw = localStorage.getItem('regles_draft');
    if (raw) {
        localStorage.removeItem('regles_draft');
        try { renderForm(JSON.parse(raw)); } catch {}
    }
});

function showToast(msg, type = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className   = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}
