'use strict';
// ============================================================================
//  groups-doc.js — Module PARTAGÉ (chargé par regles.html ET allgroupes.html)
//  Génération de la page HTML d'un groupe (buildGroupsHtmlDoc) + ses dépendances
//  (esc, FIELDS/FIELD_LABELS, OPS, NO_VALUE_OPS). La page « GROUPES » rend ainsi
//  EXACTEMENT la même chose que l'aperçu d'une règle. Ne pas redéclarer ailleurs.
// ============================================================================

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

function esc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function buildGroupsHtmlDoc(data, rule) {
    const groups   = data.groups || [];
    // Cle d'identite UNIQUE (base hierarchique du backend) ; repli sur le nom pour compat.
    // La liaison DO<->centre et l'indexation des modales se font par cle, jamais par nom
    // (des DO homonymes — gabarit sans {{region}} — dupliqueraient sinon les centres).
    const gk = g => (g && g.key != null) ? g.key : (g && g.name);
    const global   = groups.find(g => g.type === 'global');
    const doGroups = groups.filter(g => g.type === 'do').sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    const centres  = groups.filter(g => g.type === 'centre');
    for (const dg of doGroups) {
        dg._centres = centres.filter(c => (c.parent != null ? c.parent === gk(dg) : c.name.startsWith(dg.name + '-'))).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
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
                ? '<div class="grp-mail grp-mail-link grp-mail-cta" data-key="' + esc(gk(g) || '') + '" title="Voir les groupes et leurs membres">' + esc(g.mail) + '</div>'
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
        return '<div class="branch" data-do="' + esc(dg.name) + '" data-dokey="' + esc(gk(dg)) + '">' +
                   card(dg, 2, 'Niveau 2 · DO', 'do-head', hasC) +
                   '<div class="do-children">' +
                       (dg._centres || []).map(c => card(c, 3, '', '', false)).join('') +
                   '</div>' +
               '</div>';
    }).join('');

    // Niveau 3 : en-têtes DO (figés dans la topbar) séparés des colonnes de centres (défilantes)
    const doHeaderCards = doGroups.map(dg =>
        '<div class="do-head-cell" data-do="' + esc(dg.name) + '" data-dokey="' + esc(gk(dg)) + '">' + card(dg, 2, 'Niveau 2 · DO', '', false) + '</div>'
    ).join('');
    const centreColumns = doGroups.map(dg =>
        '<div class="do-centres" data-do="' + esc(dg.name) + '" data-dokey="' + esc(gk(dg)) + '">' +
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
    const mailNode = g => ({ key: gk(g), name: g.name, mail: g.mail || '', count: g.count ?? 0 });
    const mailTree = {};
    doGroups.forEach(dg => { mailTree[gk(dg)] = Object.assign(mailNode(dg), { children: (dg._centres || []).map(mailNode) }); });
    if (global) mailTree[gk(global)] = Object.assign(mailNode(global), {
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
            '<button id="toggleCategories" type="button">Catégoriser</button>' +
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
        .doc-hd h1{margin:0 0 6px;font-size:1.35rem;display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
        .doc-hd-count{background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.4);color:#fff;border-radius:999px;padding:2px 13px;font-size:.82rem;font-weight:700;letter-spacing:.02em;white-space:nowrap;}
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
        .members .mem-fn-hdr{display:flex;align-items:center;gap:8px;column-span:all;break-inside:avoid;margin:10px 0 5px;padding:3px 10px;border-radius:6px;border-left:3px solid #6366f1;background:#eef2ff;color:#3730a3;font-size:.72rem;font-weight:500;text-transform:uppercase;letter-spacing:.03em;}
        .members .mem-fn-hdr:first-child{margin-top:0;}
        .members .mem-fn-hdr .fn-lbl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .members .mem-fn-hdr .fn-c{margin-left:auto;color:#fff;background:#6366f1;border-radius:999px;padding:0 8px;font-size:.68rem;font-weight:700;flex:none;}
        .members .mem-fn-hdr.hide{display:none;}
        #tree.categorized .members .mem{grid-template-columns:1fr;padding-left:15px;}
        #tree.categorized .members .mem .m-title{display:none;}
        .empty{color:#6b7280;font-style:italic;}
        @media print{.toolbar{display:none;}body{background:#fff;}.doc-hd,.grp{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}
    `;
    const meta =
        `Règle <b>${esc((rule && rule.label) || '')}</b> · Domaine <b>@${esc(data.mailDomain || '')}</b> · ` +
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
  var catBtn=document.getElementById('toggleCategories');
  var memLists=[].slice.call(document.querySelectorAll('.members'));
  memLists.forEach(function(ul){ ul._orig=[].slice.call(ul.children); });
  var categorized=false;
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
      var doKey=b.getAttribute('data-dokey')||doName;
      var catOk=!catVal||doName===catVal;
      var doMatch=!term||doName.toLowerCase().indexOf(term)!==-1;
      var hasVisChild=b.querySelectorAll('.grp.lvl3:not(.hide)').length>0;
      var termOk=!term||doMatch||hasVisChild;
      var show=catOk&&termOk;
      b.classList.toggle('hide',!show);
      var hc=document.querySelector('.do-head-cell[data-dokey="'+doKey.replace(/"/g,'\\"')+'"]');
      if(hc)hc.classList.toggle('hide',!show);
    });
    if(g1){
      var hideG=!!catVal||(term&&(g1.getAttribute('data-name')||'').indexOf(term)===-1&&g1.querySelectorAll('.mem:not(.hide)').length===0);
      g1.classList.toggle('hide',hideG);
    }
    memLists.forEach(function(ul){
      var hs=ul.querySelectorAll('.mem-fn-hdr');
      for(var k=0;k<hs.length;k++){
        var h=hs[k],vis=false,sib=h.nextElementSibling;
        while(sib&&!sib.classList.contains('mem-fn-hdr')){
          if(sib.classList.contains('mem')&&!sib.classList.contains('hide')){vis=true;break;}
          sib=sib.nextElementSibling;
        }
        h.classList.toggle('hide',!vis);
      }
    });
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
  var recalcBtn=document.getElementById('recalcBtn');
  if(recalcBtn)recalcBtn.addEventListener('click',function(){
    if(window.opener&&!window.opener.closed&&typeof window.opener.recalcGroupsHtmlPage==='function'){
      recalcBtn.disabled=true;
      window.opener.recalcGroupsHtmlPage(window,window.RULE);
    } else {
      alert('Fenetre principale fermee — rouvrez la page depuis l\\'application pour recalculer.');
    }
  });
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
  var CATPAL=[['#1d4ed8','#eef4ff'],['#7c3aed','#f5f0ff'],['#be185d','#fdeff6'],['#047857','#e9faf2'],['#b45309','#fdf4e6'],['#0e7490','#e8f7fb'],['#b91c1c','#fdefef'],['#4338ca','#eff0fe'],['#4d7c0f','#f2f8e7'],['#a21caf','#fbeffc'],['#0f766e','#e7f7f5'],['#c2410c','#fdf1ea']];
  function catColor(t){ var h=0; for(var i=0;i<t.length;i++){h=(h*31+t.charCodeAt(i))>>>0;} return CATPAL[h%CATPAL.length]; }
  function categorize(on){
    if(treeEl)treeEl.classList.toggle('categorized',on);
    memLists.forEach(function(ul){
      [].slice.call(ul.querySelectorAll('.mem-fn-hdr')).forEach(function(h){ ul.removeChild(h); });
      var frag=document.createDocumentFragment();
      if(on){
        var byFn={},order=[];
        ul._orig.forEach(function(li){
          var te=li.querySelector('.m-title');
          var t=(te&&te.textContent.trim())||'SANS FONCTION';
          if(!byFn[t]){byFn[t]=[];order.push(t);}
          byFn[t].push(li);
        });
        order.sort(function(a,b){return a.localeCompare(b,'fr');});
        order.forEach(function(t){
          var pc=catColor(t);
          var hdr=document.createElement('li');
          hdr.className='mem-fn-hdr';
          hdr.style.color=pc[0]; hdr.style.background=pc[1]; hdr.style.borderLeftColor=pc[0];
          var lbl=document.createElement('span'); lbl.className='fn-lbl'; lbl.textContent=t;
          var cnt=document.createElement('span'); cnt.className='fn-c'; cnt.textContent=byFn[t].length; cnt.style.background=pc[0];
          hdr.appendChild(lbl); hdr.appendChild(cnt);
          frag.appendChild(hdr);
          byFn[t].forEach(function(li){ frag.appendChild(li); });
        });
      } else {
        ul._orig.forEach(function(li){ frag.appendChild(li); });
      }
      ul.appendChild(frag);
    });
  }
  if(catBtn)catBtn.addEventListener('click',function(){ categorized=!categorized; categorize(categorized); catBtn.textContent=categorized?'Décatégoriser':'Catégoriser'; apply(); });
  apply();
})();`;

    return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">' +
        '<title>Groupes — ' + esc((rule && rule.label) || 'Groupe') + '</title><style>' + css + '</style></head><body>' +
        '<div class="topbar">' +
            '<header class="doc-hd">' +
                '<div class="doc-hd-txt"><div class="doc-eyebrow">Prévisualisation des groupes AD</div><h1>' + esc((rule && rule.label) || 'Groupe') +
                    '<span class="doc-hd-count" title="Nombre total de groupes AD (global + DO + centres)">' + groups.length + ' groupe' + (groups.length > 1 ? 's' : '') + '</span>' +
                '</h1></div>' +
                '<div class="doc-hd-actions">' +
                    '<button id="recalcBtn" class="info-btn" type="button" title="Recalculer la page">' +
                        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>' +
                    '</button>' +
                    '<button id="infoBtn" class="info-btn" type="button" title="Détails et filtre du groupe">' +
                        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>' +
                    '</button>' +
                    '<button id="fsBtn" class="info-btn" type="button" title="Plein écran (F11)">' +
                        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>' +
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
        '<script>window.MAILTREE=' + JSON.stringify(mailTree).replace(/</g, '\\u003c') + ';window.GROUPMEMBERS=' + JSON.stringify(groupMembers).replace(/</g, '\\u003c') + ';window.RULE=' + JSON.stringify(rule || {}).replace(/</g, '\\u003c') + ';</script>' +
        '<script>' + pageScript + '</script>' +
        '</body></html>';
}
