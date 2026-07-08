'use strict';

let rubriques = [];   // [{ id, label, ordre }]
let dirty     = false;

const uid = () => 'rub-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function initRubriques() {
    if (window !== window.top) {
        const h = document.querySelector('header');
        if (h) h.style.display = 'none';
    }
    await loadRubriques();

    document.getElementById('rub-add-btn').addEventListener('click', addRubrique);
    document.getElementById('rub-new-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); addRubrique(); }
    });
    document.getElementById('rub-save-btn').addEventListener('click', saveRubriques);
}

// Robuste : si le DOM est déjà prêt (ex. iframe injectée après le DOMContentLoaded parent),
// lancer l'init tout de suite ; sinon attendre l'événement.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRubriques);
} else {
    initRubriques();
}

async function loadRubriques() {
    try {
        const r = await fetch('/api/rubriques');
        const d = await r.json();
        rubriques = (Array.isArray(d) ? d : [])
            .map((x, i) => ({ id: x.id || uid(), label: x.label || '', ordre: x.ordre ?? (i + 1) }))
            .sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
    } catch {
        rubriques = [];
        showToast('Erreur de chargement des rubriques', 'error');
    }
    setDirty(false);
    render();
}

function render() {
    const list  = document.getElementById('rub-list');
    const count = document.getElementById('rub-count');
    count.textContent = `${rubriques.length} rubrique${rubriques.length > 1 ? 's' : ''}`;

    if (!rubriques.length) {
        list.innerHTML = '<li class="rub-empty">Aucune rubrique — ajoutez-en une ci-dessus.</li>';
        return;
    }

    list.innerHTML = rubriques.map((r, i) =>
        `<li class="rub-item" data-id="${esc(r.id)}">` +
            `<span class="rub-handle">${i + 1}</span>` +
            `<input class="rub-item-label" type="text" value="${esc(r.label)}" maxlength="60" data-id="${esc(r.id)}">` +
            `<div class="rub-actions">` +
                `<button class="rub-ic rub-ic-up" title="Monter" data-id="${esc(r.id)}"${i === 0 ? ' disabled' : ''}>` +
                    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>` +
                `</button>` +
                `<button class="rub-ic rub-ic-down" title="Descendre" data-id="${esc(r.id)}"${i === rubriques.length - 1 ? ' disabled' : ''}>` +
                    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>` +
                `</button>` +
                `<button class="rub-ic rub-ic-del" title="Supprimer" data-id="${esc(r.id)}">` +
                    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>` +
                `</button>` +
            `</div>` +
        `</li>`
    ).join('');

    list.querySelectorAll('.rub-item-label').forEach(inp =>
        inp.addEventListener('input', () => {
            const r = rubriques.find(x => x.id === inp.dataset.id);
            if (r) { r.label = inp.value; setDirty(true); }
        }));
    list.querySelectorAll('.rub-ic-up').forEach(b   => b.addEventListener('click', () => move(b.dataset.id, -1)));
    list.querySelectorAll('.rub-ic-down').forEach(b => b.addEventListener('click', () => move(b.dataset.id, +1)));
    list.querySelectorAll('.rub-ic-del').forEach(b  => b.addEventListener('click', () => removeRubrique(b.dataset.id)));
}

function addRubrique() {
    const inp   = document.getElementById('rub-new-input');
    const label = inp.value.trim();
    if (!label) { inp.focus(); return; }
    if (rubriques.some(r => r.label.toLowerCase() === label.toLowerCase())) {
        showToast('Cette rubrique existe déjà', 'error');
        return;
    }
    rubriques.push({ id: uid(), label, ordre: rubriques.length + 1 });
    inp.value = '';
    setDirty(true);
    render();
    inp.focus();
}

function move(id, dir) {
    const i = rubriques.findIndex(r => r.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= rubriques.length) return;
    [rubriques[i], rubriques[j]] = [rubriques[j], rubriques[i]];
    setDirty(true);
    render();
}

function removeRubrique(id) {
    const r = rubriques.find(x => x.id === id);
    if (!r) return;
    rubriques = rubriques.filter(x => x.id !== id);
    setDirty(true);
    render();
}

async function saveRubriques() {
    // Réindexe l'ordre + retire les libellés vides
    const clean = rubriques
        .map(r => ({ ...r, label: r.label.trim() }))
        .filter(r => r.label);
    clean.forEach((r, i) => { r.ordre = i + 1; });

    try {
        const res = await fetch('/api/rubriques', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(clean),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        rubriques = clean;
        setDirty(false);
        render();
        showToast('Rubriques enregistrées', 'success');
        // Notifie l'onglet Règles (via le shell) qu'il doit recharger ses rubriques.
        try { window.top.postMessage({ type: 'rubriques-changed' }, '*'); } catch { /* hors iframe */ }
    } catch {
        showToast("Erreur lors de l'enregistrement", 'error');
    }
}

function setDirty(v) {
    dirty = v;
    document.getElementById('rub-save-btn').disabled = !v;
    document.getElementById('rub-dirty').hidden = !v;
}

let _toastTimer = null;
function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
}
