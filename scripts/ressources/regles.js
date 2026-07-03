'use strict';

let rules      = [];
let groupCounts = {};   // { ruleId: nombre total de groupes (hiérarchie complète) } — pastille sidebar
let editingId  = null;
let activeFormTab = 'params';
let apercuCache = {};   // cache du rendu de l'onglet « Aperçu groupes », par signature de règle
let groupByNiveau = (() => { try { return localStorage.getItem('regles_group_niveau') === '1'; } catch { return false; } })();


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
        loadGroupCounts();
        // Notifie le shell (onglet principal) du nombre total de règles → pastille de nav
        try { window.top.postMessage({ type: 'rules-changed', count: rules.length }, '*'); } catch { /* hors iframe */ }
    } catch {
        showToast('Erreur chargement des règles', 'error');
        rules = [];
        renderList();
    }
}

// Nombre total de groupes (global + DO + centres) par règle — pour la pastille de la liste.
// Calcul léger côté serveur (cache en mémoire, sans les membres) ; re-rend la liste à réception.
async function loadGroupCounts() {
    try {
        const r = await fetch('/api/regles/counts');
        const data = await r.json();
        if (data && !data.error) {
            groupCounts = data;
            renderList();
            updateTotalGroupsBadge();
        }
    } catch { /* silencieux — la pastille est un confort, pas un bloquant */ }
}

// Total des groupes à créer = somme des pastilles des règles ACTIVES (inactives non générées).
function updateTotalGroupsBadge() {
    const el = document.getElementById('regles-total-badge');
    if (!el) return;
    const actives = rules.filter(r => r.active !== false && typeof groupCounts[r.id] === 'number');
    if (!actives.length) { el.hidden = true; return; }
    const total = actives.reduce((sum, r) => sum + groupCounts[r.id], 0);
    el.hidden = false;
    el.textContent = `${total} groupes`;
    el.title = `Total des groupes à créer — ${actives.length} règle${actives.length > 1 ? 's' : ''} active${actives.length > 1 ? 's' : ''}`;
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
// Éditer un gabarit : icône crayon
const SVG_PATTERN_EDIT = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;

// ── Modale d'édition d'un gabarit (nom / mail par niveau) ───────────────
const PATTERN_TOKENS = ['{{prefix}}', '{{region}}', '{{nomCentre}}'];

// Configuration par type de gabarit édité.
//   id      : champ cible dans le formulaire
//   isMail  : applique le nettoyage mail (minuscules, espaces→tiret) à l'aperçu
//   level   : niveau de groupe → détermine quels tokens sont non vides dans l'aperçu
//   fallback: champ dont on reprend la valeur si le champ cible est vide (à l'ouverture)
// fallback: champ dont on hérite la valeur si le champ cible est vide — les 3 mails
// héritent par défaut du gabarit « Nom groupe » (f-name-pattern).
const PATTERN_KINDS = {
    name:       { id: 'f-name-pattern',        title: 'Gabarit — Nom du groupe',            isMail: false, level: 'centre', fallback: null },
    mailGlobal: { id: 'f-mail-pattern-global', title: 'Gabarit — Mail · groupe Global',     isMail: true,  level: 'global', fallback: 'f-name-pattern' },
    mailDo:     { id: 'f-mail-pattern-do',     title: 'Gabarit — Mail · groupes DO',        isMail: true,  level: 'do',     fallback: 'f-name-pattern' },
    mailCentre: { id: 'f-mail-pattern',        title: 'Gabarit — Mail · groupes Centre',    isMail: true,  level: 'centre', fallback: 'f-name-pattern' },
};

let patternModalKind = 'name';   // type courant édité — piloté par openPatternModal

// Résout un gabarit avec des valeurs d'exemple selon le niveau (tokens vides au-delà du niveau)
// puis reproduit le nettoyage du backend (Resolve-Pattern / mail). Pour l'aperçu uniquement.
function resolvePatternSample(val, kind) {
    const cfg = PATTERN_KINDS[kind] || PATTERN_KINDS.name;
    const sample = {
        '{{prefix}}':    'FORM',
        '{{region}}':    cfg.level === 'global' ? '' : 'SUD',
        '{{nomCentre}}': cfg.level === 'centre' ? 'MARSEILLE' : '',
    };
    let out = val;
    for (const [t, v] of Object.entries(sample)) out = out.split(t).join(v);
    // Nettoyage des séparateurs orphelins (miroir de Resolve-Pattern côté backend)
    out = out.replace(/-{2,}/g, '-').replace(/\.{2,}/g, '.')
             .replace(/[-.\s]+@/g, '@').replace(/@[-.\s]+/g, '@')
             .replace(/^[-.\s]+/, '').replace(/[-.\s]+$/, '').trim();
    if (cfg.isMail) {
        out = out.replace(/\s+/g, '-').replace(/-{2,}/g, '-').toLowerCase();
        if (out && !out.includes('@')) out += '@…';   // domaine ajouté automatiquement à la génération
    }
    return out;
}

function renderPatternPreview() {
    const val = document.getElementById('pattern-modal-input').value;
    const out = resolvePatternSample(val, patternModalKind);
    document.getElementById('pattern-preview-val').textContent = out || '—';
    const lvl = (PATTERN_KINDS[patternModalKind] || {}).level || 'centre';
    const lbl = { global: 'Global', do: 'DO', centre: 'centre' }[lvl] || lvl;
    const lblEl = document.querySelector('#pattern-modal .pattern-preview-lbl');
    if (lblEl) lblEl.textContent = `Aperçu (${lbl}) :`;
}

function insertPatternToken(input, tok) {
    const start = input.selectionStart ?? input.value.length;
    const end   = input.selectionEnd   ?? input.value.length;
    input.value = input.value.slice(0, start) + tok + input.value.slice(end);
    const pos = start + tok.length;
    input.focus();
    input.setSelectionRange(pos, pos);
    renderPatternPreview();
}

function openPatternModal(kind) {
    const cfg = PATTERN_KINDS[kind] || PATTERN_KINDS.name;
    patternModalKind = kind;

    const modal     = document.getElementById('pattern-modal');
    const input     = document.getElementById('pattern-modal-input');
    const okBtn     = document.getElementById('pattern-modal-ok');
    const cancelBtn = document.getElementById('pattern-modal-cancel');
    const closeBtn  = document.getElementById('pattern-modal-close');
    const target    = document.getElementById(cfg.id);

    document.getElementById('pattern-modal-title').textContent = cfg.title;
    document.getElementById('pattern-modal-hint').textContent  = cfg.isMail
        ? 'Vide → dérivé du nom de la règle ; le domaine (@…) est ajouté automatiquement.'
        : 'Cliquez sur un token pour l’insérer à la position du curseur.';

    // Valeur initiale ; si le champ est vide → valeur dérivée du nom de la règle
    let initial = target.value.trim();
    if (!initial) { const c = derivedCfg(cfg.id); if (c) initial = c.fn(document.getElementById('f-label')?.value || ''); }
    input.value = initial;

    const tokBox = document.getElementById('pattern-tokens');
    tokBox.innerHTML = '';
    PATTERN_TOKENS.forEach(tok => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pattern-token-chip';
        b.textContent = tok;
        b.addEventListener('click', () => insertPatternToken(input, tok));
        tokBox.appendChild(b);
    });

    renderPatternPreview();
    modal.removeAttribute('hidden');
    input.focus();

    function cleanup() {
        modal.setAttribute('hidden', '');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        closeBtn.removeEventListener('click', onCancel);
        modal.removeEventListener('click', onOverlay);
        input.removeEventListener('input', renderPatternPreview);
    }
    function onOk() {
        target.value = input.value.trim();
        // Champ dérivé (nom groupe ou mail) : vide → ré-hérite (dérivé du nom de règle) ; sinon propre
        const dCfg = derivedCfg(cfg.id);
        if (dCfg) {
            if (!target.value) { target.dataset.inherited = '1'; target.value = dCfg.fn(document.getElementById('f-label')?.value || ''); }
            else target.dataset.inherited = '';
        }
        cleanup();
    }
    function onCancel()   { cleanup(); }
    function onOverlay(e) { if (e.target === modal) cleanup(); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onOverlay);
    input.addEventListener('input', renderPatternPreview);
}

// Les 3 gabarits mail (Global / DO / Centre). f-mail-pattern = Centre (commun/rétro-compat).
const MAIL_FIELD_IDS = ['f-mail-pattern-global', 'f-mail-pattern-do', 'f-mail-pattern'];

// Base d'adresse mail : minuscule, SANS accents, espaces → tiret (jamais d'accent ni d'espace).
function toMailBase(s) {
    return (s || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')   // retire les accents
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '');
}

// Champs dérivés du NOM DE LA RÈGLE (f-label), chacun avec sa transformation :
//   - Nom groupe    : MAJUSCULE (accents conservés)
//   - Mail Global   : base mail (minuscule, sans accent, tirets)
//   - Mail DO/Centre: base mail + un point final (séparateur avant le token {{region}}/{{nomCentre}})
const DERIVED_FIELDS = [
    { id: 'f-name-pattern',        fn: s => (s || '').toUpperCase() },
    { id: 'f-mail-pattern-global', fn: s => toMailBase(s) },
    { id: 'f-mail-pattern-do',     fn: s => { const b = toMailBase(s); return b ? b + '.' : ''; } },
    { id: 'f-mail-pattern',        fn: s => { const b = toMailBase(s); return b ? b + '.' : ''; } },
];
function derivedCfg(id) { return DERIVED_FIELDS.find(d => d.id === id) || null; }

// Câble : NOM DE LA RÈGLE → NOM GROUPE + 3 mails (dérivation live tant que non personnalisé),
// MAJUSCULE forcée sur le nom de règle, « tout sélectionner » au focus. Appelé après chaque rendu.
function setupNamingFields() {
    const nameEl = document.getElementById('f-label');
    if (!nameEl) return;
    const derived = DERIVED_FIELDS.map(d => ({ fn: d.fn, el: document.getElementById(d.id) })).filter(d => d.el);

    // Init : champ vide → dérivé du nom de règle (hérité) ; champ déjà rempli → valeur propre
    derived.forEach(d => {
        if (!d.el.value.trim()) { d.el.dataset.inherited = '1'; d.el.value = d.fn(nameEl.value); }
        else d.el.dataset.inherited = '';
    });

    // Nom de règle : MAJUSCULE live + propagation aux champs encore hérités
    nameEl.addEventListener('input', () => {
        const up = nameEl.value.toUpperCase();
        if (nameEl.value !== up) {
            const pos = nameEl.selectionStart;
            nameEl.value = up;
            try { nameEl.setSelectionRange(pos, pos); } catch { /* ignore */ }
        }
        derived.forEach(d => { if (d.el.dataset.inherited === '1') d.el.value = d.fn(nameEl.value); });
    });

    // Saisie manuelle d'un dérivé → propre ; vidé puis quitté (blur) → ré-hérite du nom de règle
    derived.forEach(d => {
        d.el.addEventListener('input', () => { d.el.dataset.inherited = d.el.value.trim() ? '' : '1'; });
        d.el.addEventListener('blur',  () => { if (!d.el.value.trim()) { d.el.dataset.inherited = '1'; d.el.value = d.fn(nameEl.value); } });
    });

    // Tout sélectionner au focus (Nom groupe + 3 mails). setTimeout(0) pour survivre au clic.
    ['f-name-pattern', ...MAIL_FIELD_IDS].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('focus', () => setTimeout(() => { try { el.select(); } catch { /* ignore */ } }, 0));
    });
}

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
    const gCount = groupCounts[rule.id];
    const gBadge = (typeof gCount === 'number')
        ? `<span class="rule-gcount" title="${gCount} groupe${gCount > 1 ? 's' : ''} généré${gCount > 1 ? 's' : ''} (global + DO + centres)">${gCount}</span>`
        : '';
    card.innerHTML =
        `<span class="rule-initials">${esc(initials)}</span>` +
        `<div class="rule-card-row">` +
            `<span class="rule-card-label">${esc(rule.label || '(sans nom)')}</span>` +
            gBadge +
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
                `<div class="form-row-top-toggle">` +
                    `<label class="toggle-switch">` +
                        `<input type="checkbox" id="f-active"${activeChecked}>` +
                        `<span class="toggle-track"></span>` +
                    `</label>` +
                    `<span class="toggle-label">Règle active</span>` +
                `</div>` +
            `</div>` +

            `<div class="form-group naming-group">` +
                `<div class="naming-fields" id="naming-fields">` +
                    `<div class="form-row-top">` +
                        `<div class="form-row-top-col">` +
                            `<label class="form-label" for="f-name-pattern">Nom groupe</label>` +
                            `<div class="pattern-input-wrap">` +
                                `<input id="f-name-pattern" class="form-input" type="text" placeholder="ex. Formateurs-{{region}}-{{nomCentre}}" value="${esc(rule?.naming?.namePattern || '')}">` +
                                `<button type="button" class="pattern-edit-btn" id="btn-name-pattern" title="Éditer le gabarit du nom">${SVG_PATTERN_EDIT}</button>` +
                            `</div>` +
                        `</div>` +
                        `<div class="form-row-top-col">` +
                            `<label class="form-label">Adresse mail <span class="form-label-opt">(Global · DO · Centre)</span></label>` +
                            `<div class="naming-mail-stack">` +
                                `<div class="pattern-input-wrap">` +
                                    `<input id="f-mail-pattern-global" class="form-input" type="text" placeholder="Global — ex. centres-aftral" title="Mail du groupe Global" value="${esc(rule?.naming?.mailPatternGlobal || '')}">` +
                                    `<button type="button" class="pattern-edit-btn" id="btn-mail-pattern-global" title="Éditer le gabarit du mail (Global)">${SVG_PATTERN_EDIT}</button>` +
                                `</div>` +
                                `<div class="pattern-input-wrap">` +
                                    `<input id="f-mail-pattern-do" class="form-input" type="text" placeholder="DO — ex. centres-aftral-{{region}}" title="Mail des groupes DO" value="${esc(rule?.naming?.mailPatternDo || '')}">` +
                                    `<button type="button" class="pattern-edit-btn" id="btn-mail-pattern-do" title="Éditer le gabarit du mail (DO)">${SVG_PATTERN_EDIT}</button>` +
                                `</div>` +
                                `<div class="pattern-input-wrap">` +
                                    `<input id="f-mail-pattern" class="form-input" type="text" placeholder="Centre — ex. {{nomCentre}}" title="Mail des groupes Centre" value="${esc(rule?.naming?.mailPattern || '')}">` +
                                    `<button type="button" class="pattern-edit-btn" id="btn-mail-pattern" title="Éditer le gabarit du mail (Centre)">${SVG_PATTERN_EDIT}</button>` +
                                `</div>` +
                            `</div>` +
                        `</div>` +
                    `</div>` +
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

    document.getElementById('btn-name-pattern')?.addEventListener('click', () => openPatternModal('name'));
    document.getElementById('btn-mail-pattern-global')?.addEventListener('click', () => openPatternModal('mailGlobal'));
    document.getElementById('btn-mail-pattern-do')?.addEventListener('click', () => openPatternModal('mailDo'));
    document.getElementById('btn-mail-pattern')?.addEventListener('click', () => openPatternModal('mailCentre'));
    setupNamingFields();

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

    // Nommage personnalisé (gabarits) — actif dès que le "Nom groupe" est renseigné.
    // Mail par niveau : f-mail-pattern = Centre (commun/rétro-compat), + DO et Global dédiés.
    // Un champ mail hérité (data-inherited="1") est enregistré VIDE → le backend hérite du namePattern.
    const mailVal = id => {
        const el = document.getElementById(id);
        return (!el || el.dataset.inherited === '1') ? '' : (el.value.trim() || '');
    };
    const namePattern       = document.getElementById('f-name-pattern')?.value.trim() || '';
    const mailPattern       = mailVal('f-mail-pattern');
    const mailPatternDo     = mailVal('f-mail-pattern-do');
    const mailPatternGlobal = mailVal('f-mail-pattern-global');
    const naming = (namePattern || mailPattern || mailPatternDo || mailPatternGlobal)
        ? {
            usePattern: !!namePattern,
            namePattern,
            mailPattern,
            ...(mailPatternDo     ? { mailPatternDo }     : {}),
            ...(mailPatternGlobal ? { mailPatternGlobal } : {}),
        }
        : null;

    return {
        id:         editingId || uid(),
        label,
        // Préfixe technique retiré de l'UI — on préserve la valeur déjà stockée (nommage par défaut)
        ...(existing?.prefix ? { prefix: existing.prefix } : {}),
        niveau,
        monoNiveau: existing?.monoNiveau ?? false,
        ...(existing?.invertOf ? { invertOf: existing.invertOf } : {}),
        ...(existing?.locked ? { locked: true } : {}),
        conditions: { include, exclude },
        active:     activeChk ? activeChk.checked : (existing?.active !== false),
        ...(naming ? { naming } : {}),
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
    // Cle d'identite UNIQUE (base hierarchique renvoyee par le backend) ; repli sur le nom
    // pour compat. Ne jamais lier parent<->enfant par le NOM : un gabarit sans {{region}}
    // produit des DO homonymes et chaque centre apparaitrait alors sous tous les DO.
    const gk = g => (g && g.key != null) ? g.key : (g && g.name);
    const global   = groups.find(g => g.type === 'global');
    const doGroups  = groups.filter(g => g.type === 'do').sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    const centres  = groups.filter(g => g.type === 'centre');
    for (const dg of doGroups) {
        dg._centres = centres
            .filter(c => (c.parent != null ? c.parent === gk(dg) : c.name.startsWith(dg.name + '-')))
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


// Recalcul d'une page HTML déjà ouverte (appelée depuis la fenêtre enfant via window.opener)
window.recalcGroupsHtmlPage = async function (win, rule) {
    if (!win || win.closed || !rule) return;
    try {
        const r    = await fetch('/api/regles/preview-groups', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(rule),
        });
        const data = await r.json();
        if (data.error) { showToast(data.error, 'error'); return; }
        win.document.open();
        win.document.write(buildGroupsHtmlDoc(data, rule));
        win.document.close();
    } catch {
        showToast('Erreur lors du recalcul de la page HTML', 'error');
    }
};

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
            .filter(c => (c.parent != null ? c.parent === dg.name : c.name.startsWith(dg.name + '-')))
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
        `<span class="gp-meta-item"><strong>Règle :</strong> ${esc((sourceRule && sourceRule.label) || data.prefix || '')}</span>` +
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
            .filter(c => (c.parent != null ? c.parent === dg.name : c.name.startsWith(dg.name + '-')))
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
