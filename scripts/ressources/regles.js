'use strict';

let rules      = [];
let editingId  = null;

const FIELDS = [
    ['title',              'Fonction (title)'],
    ['department',         'Service (department)'],
    ['office',             'Bureau (office)'],
    ['extensionAttribute1','Attribut ext. 1'],
    ['description',        'Description'],
];

const OPS = [
    ['eq',      'est exactement'],
    ['ne',      "n'est pas"],
    ['like',    'contient'],
    ['notlike', 'ne contient pas'],
];

const NIV_LABELS = { 1: 'Par centre', 2: 'Par DO', 3: 'Global' };
const NIV_CSV    = { 1: '3 CSV (centre + DO + global)', 2: '2 CSV (DO + global)', 3: '1 CSV global' };

function metaLabel(rule) {
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

// ── Init ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    if (window !== window.top) {
        document.querySelector('header').style.display = 'none';
        document.querySelector('.regles-layout').style.height = '100vh';
    }

    await loadRules();
    preloadUsers();
    const raw = localStorage.getItem('regles_draft');
    if (raw) {
        localStorage.removeItem('regles_draft');
        try { renderForm(JSON.parse(raw)); } catch { /* draft invalide */ }
    }
    document.getElementById('btn-new-rule').addEventListener('click', openNewForm);
    document.getElementById('btn-view-json').addEventListener('click', openJsonModal);
    setupJsonModal();
    setupHelpModal();
    setupCsvModal();
    setupTooltip();
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
    const active   = rules.filter(r => r.active !== false);
    const inactive = rules.filter(r => r.active === false);
    el.innerHTML = '';
    for (const rule of active)   el.appendChild(buildCard(rule));
    if (inactive.length) {
        const sep = document.createElement('div');
        sep.className = 'rules-section-sep';
        sep.innerHTML = '<span>Inactives</span>';
        el.appendChild(sep);
        for (const rule of inactive) el.appendChild(buildCard(rule));
    }
}

function buildCard(rule) {
    const isActive = rule.active !== false;

    const card = document.createElement('div');
    card.className = 'rule-card'
        + (editingId === rule.id ? ' active' : '')
        + (isActive ? '' : ' inactive');
    card.dataset.id = rule.id;
    card.innerHTML =
        `<div class="rule-card-row">` +
            `<span class="rule-card-label">${esc(rule.label || '(sans nom)')}</span>` +
            (!isActive ? `<span class="badge-inactive">Inactif</span>` : '') +
        `</div>`;

    card.addEventListener('click', () => openEditForm(rule.id));
    return card;
}

// ── Formulaire ────────────────────────────────────────────────────────
function openNewForm() {
    editingId = null;
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

    main.innerHTML =
        `<div class="regles-form" id="rule-form">` +
            `<div class="form-title">${isNew ? 'Nouvelle règle' : 'Modifier — ' + esc(rule.label || '')}</div>` +

            `<div class="form-group">` +
                `<label class="form-label" for="f-label">Nom de la règle</label>` +
                `<input id="f-label" class="form-input" type="text" placeholder="ex. Administratif" value="${esc(rule?.label || '')}">` +
            `</div>` +

            `<div class="form-group">` +
                `<label class="form-label" for="f-desc">Description</label>` +
                `<input id="f-desc" class="form-input form-input-auto" type="text" value="${esc(metaLabel(rule || {}))}" readonly>` +
            `</div>` +

            `<div class="form-group form-group-inline">` +
                `<label class="toggle-switch">` +
                    `<input type="checkbox" id="f-active"${activeChecked}>` +
                    `<span class="toggle-track"></span>` +
                `</label>` +
                `<span class="toggle-label">Règle active</span>` +
            `</div>` +

            `<div class="form-group">` +
                `<label class="form-label">Niveau de groupement</label>` +
                `<div class="niveau-options" id="niveau-options">` +
                    [1, 2, 3].map(n =>
                        `<label class="niveau-option${niveau === n ? ' selected' : ''}" data-n="${n}">` +
                            `<input type="radio" name="f-niveau" value="${n}"${niveau === n ? ' checked' : ''}>` +
                            `<div class="niveau-opt-num">${n}</div>` +
                            `<div class="niveau-opt-lbl">${NIV_LABELS[n]}</div>` +
                            `<div class="niveau-opt-desc">${NIV_CSV[n]}</div>` +
                        `</label>`
                    ).join('') +
                `</div>` +
            `</div>` +

            `<div class="form-group">` +
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
        `</div>` +
        `<div class="form-footer">` +
            `<div class="gen-progress" id="gen-progress" hidden>` +
                `<div class="gen-progress-bar"></div>` +
                `<span class="gen-progress-msg" id="gen-progress-msg"></span>` +
            `</div>` +
            `<div class="form-footer-buttons">` +
                `<button class="btn-secondary" id="btn-cancel">Annuler</button>` +
                (editingId ? `<button class="btn-danger" id="btn-delete-rule">Supprimer</button>` : '') +
                (editingId ? `<button class="btn-generate-form" id="btn-generate-form">Générer le CSV</button>` : '') +
                `<button class="btn-primary" id="btn-save">Enregistrer</button>` +
            `</div>` +
        `</div>`;

    for (const c of inc) addCondRow('cond-include', c);
    for (const c of exc) addCondRow('cond-exclude', c);

    main.querySelectorAll('.niveau-option').forEach(opt => {
        opt.addEventListener('click', () => {
            main.querySelectorAll('.niveau-option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            opt.querySelector('input').checked = true;
            autoUpdateDesc();
        });
    });

    document.getElementById('btn-add-include').addEventListener('click', () => { addCondRow('cond-include'); autoUpdateDesc(); });
    document.getElementById('btn-add-exclude').addEventListener('click', () => { addCondRow('cond-exclude'); autoUpdateDesc(); });
    document.getElementById('btn-save').addEventListener('click', saveRule);
    document.getElementById('btn-cancel').addEventListener('click', closeForm);
    const genFormBtn = document.getElementById('btn-generate-form');
    if (genFormBtn) genFormBtn.addEventListener('click', () => generateCsv(editingId));
    const delRuleBtn = document.getElementById('btn-delete-rule');
    if (delRuleBtn) delRuleBtn.addEventListener('click', () => confirmDelete(editingId, document.getElementById('f-label')?.value.trim() || editingId));

    document.getElementById('f-active').addEventListener('change', async e => {
        const newVal = e.target.checked;
        e.target.checked = !newVal;
        const label  = document.getElementById('f-label')?.value.trim() || 'cette règle';
        const action = newVal ? 'Réactiver' : 'Désactiver';
        if (await showConfirm(`${action} la règle "${label}" ?`)) {
            e.target.checked = newVal;
        }
    });

    document.getElementById('f-label').focus();
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
    })).filter(c => c.value !== '');
}

function readForm() {
    const label  = document.getElementById('f-label')?.value.trim();
    const radio  = document.querySelector('input[name="f-niveau"]:checked');
    const niveau = radio ? parseInt(radio.value) : 3;

    if (!label) { showToast('Le nom est obligatoire', 'error'); return null; }

    const include = readCondList('cond-include');
    if (!include.length) { showToast('Au moins une condition "Inclure" est requise', 'error'); return null; }

    const exclude    = readCondList('cond-exclude');
    const existing   = editingId ? rules.find(r => r.id === editingId) : null;
    const activeChk  = document.getElementById('f-active');

    return {
        id:         editingId || uid(),
        label,
        niveau,
        monoNiveau: existing?.monoNiveau ?? false,
        conditions: { include, exclude },
        active:     activeChk ? activeChk.checked : (existing?.active !== false),
        createdAt:  existing?.createdAt || now(),
        updatedAt:  now(),
    };
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
        renderForm(rule);
        showToast('Règle enregistrée', 'success');
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

// ── Génération CSV ────────────────────────────────────────────────────
// ── Préchargement utilisateurs AD ─────────────────────────────────────
let usersPreloaded = false;

async function preloadUsers() {
    const bar  = document.getElementById('preload-bar');
    const msg  = document.getElementById('preload-msg');
    const list = document.getElementById('regles-list');
    if (!bar || !msg) return;

    list?.classList.add('users-loading');
    bar.classList.add('loading');
    msg.textContent = 'Chargement des utilisateurs AD…';

    try {
        const r    = await fetch('/api/users/preload', { method: 'POST' });
        const data = await r.json();
        bar.classList.remove('loading');
        if (data.ok) {
            usersPreloaded = true;
            bar.classList.add('done');
            msg.textContent = `✓ ${data.count.toLocaleString('fr-FR')} utilisateurs en cache`;
        } else {
            bar.classList.add('error');
            msg.textContent = `⚠ Erreur préchargement`;
        }
    } catch {
        bar.classList.remove('loading');
        bar.classList.add('error');
        if (msg) msg.textContent = '⚠ Erreur préchargement';
    } finally {
        list?.classList.remove('users-loading');
    }
}

function getGenSteps() {
    return usersPreloaded
        ? ['Filtrage selon les conditions…', 'Écriture des fichiers CSV…']
        : ['Chargement des utilisateurs AD…', 'Filtrage selon les conditions…', 'Écriture des fichiers CSV…'];
}

async function generateCsv(id) {
    const rule  = rules.find(r => r.id === id);
    const label = rule?.label || id;

    const btn      = document.getElementById('btn-generate-form');
    const progress = document.getElementById('gen-progress');
    const msg      = document.getElementById('gen-progress-msg');

    if (btn) { btn.disabled = true; btn.textContent = 'Génération…'; }
    if (progress) progress.removeAttribute('hidden');

    const steps = getGenSteps();
    let stepIdx = 0;
    function showStep() { if (msg) msg.textContent = steps[stepIdx % steps.length]; }
    showStep();
    const ticker = setInterval(() => { stepIdx++; showStep(); }, 2500);

    try {
        const r    = await fetch(`/api/regles/${encodeURIComponent(id)}/generate`, { method: 'POST' });
        const data = await r.json();

        if (!data.ok) {
            showToast(`Erreur : ${data.error}`, 'error');
            return;
        }

        showCsvModal(data, label);
    } catch {
        showToast('Erreur lors de la génération', 'error');
    } finally {
        clearInterval(ticker);
        if (btn)      { btn.disabled = false; btn.textContent = 'Générer le CSV'; }
        if (progress) progress.setAttribute('hidden', '');
    }
}

function showCsvModal(data, label) {
    document.getElementById('csv-modal-title').textContent = `CSV — ${label}`;
    const n = data.total;
    const f = data.files?.length || 0;
    document.getElementById('csv-modal-summary').textContent =
        `${n} utilisateur${n !== 1 ? 's' : ''} · ${f} fichier${f !== 1 ? 's' : ''}`;
    document.getElementById('csv-modal-footer').textContent = data.outDir || '';

    const body  = document.getElementById('csv-modal-body');
    const files = data.files || [];

    document.getElementById('csv-modal-tabs').innerHTML = '';

    if (!files.length) {
        body.innerHTML = '<p class="csv-empty">Aucun fichier généré</p>';
    } else {
        body.innerHTML =
            `<ul class="csv-file-list">${
                files.map(f => `<li class="csv-file-item">${esc(f)}</li>`).join('')
            }</ul>`;
    }

    document.getElementById('csv-modal').removeAttribute('hidden');
}

function setupCsvModal() {
    document.getElementById('btn-csv-close').addEventListener('click', () => {
        document.getElementById('csv-modal').setAttribute('hidden', '');
    });
    document.getElementById('csv-modal').addEventListener('click', e => {
        if (e.target === e.currentTarget) e.currentTarget.setAttribute('hidden', '');
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
