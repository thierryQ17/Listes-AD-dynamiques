# Contexte de session — Groupes Dynamiques I2N

> Mettre ce fichier à jour en fin de session via la commande :
> `maj C:\DEV POWERSHELL\Liste de distribution\CONTEXTE-SESSION.md`

---

## Résumé du projet

Application web locale (PowerShell + HTML/CSS/JS pur) pour administrer l'AD en **lecture seule** : explorer les utilisateurs par OU, définir des règles de filtrage, et générer des CSV.

- **Backend** : PowerShell, serveur HTTP **Pode** (module `Pode` 2.13.3), **multi-thread**, port **8888**
- **Frontend** : HTML/CSS/JS pur, sans framework
- **Démarrage** : `Start.bat` ou `Start.ps1` → ouvre `http://localhost:8888/`

> **Migration HttpListener → Pode (juillet 2026)** : le serveur maison
> `System.Net.HttpListener` (séquentiel, une requête à la fois — UI gelée pendant
> génération/preview/check-mail) a été remplacé par **Pode multi-thread**. Voir la
> section « Serveur Pode » plus bas. Le frontend et les modules métier sont inchangés.

---

## Architecture : shell iframe

Le point d'entrée est `shell.html` servi à `/`. Il contient **3 iframes** : l'onglet actif est visible, les autres sont `display:none` mais restent chargés en mémoire → **zéro rechargement** quand on permute d'onglet.

```
http://localhost:8888/
  └── shell.html  ← header + 3 iframes + badge date cache
        ├── #frame-explorer  src="/explorer"   (chargé immédiatement)
        ├── #frame-regles    src="/regles"      (lazy — premier clic)
        └── #frame-groupes   src="/groupes"     (lazy — premier clic)
```

Chaque page détecte `window !== window.top` et masque son propre header :
```javascript
if (window !== window.top) {
    document.querySelector('header').style.display = 'none';
    document.querySelector('.xxx-layout').style.height = '100vh';
}
```

### Communication inter-onglets

- `window.top.switchTab('regles')` — depuis un iframe, bascule vers l'onglet Règles
- `postMessage({ type: 'tab-activated' }, '*')` — le shell notifie l'iframe activé
- `postMessage({ type: 'cache-rebuilt' }, '*')` — l'Explorer notifie le shell après ↻ Cache
- `regles.js` écoute `tab-activated` pour charger un draft localStorage en attente

---

## Structure des fichiers clés

```
scripts/
  modules/
    http-server.psm1        ← serveur HTTP + routes API
    csv-generator.psm1      ← génération CSV depuis l'AD
    ad-reader.psm1          ← lecture AD (seul module qui touche l'AD)
    connect.psm1            ← connexion credentials XML
  ressources/
    shell.html              ← POINT D'ENTRÉE — shell 3 iframes
    explorer.html / explorer.js / explorer.css  ← Explorateur AD (/explorer)
    regles.html / regles.js / regles.css        ← Règles (/regles)
    index.html / app.js / style.css             ← Groupes Dynamiques (/groupes)
  settings/
    parametres.json         ← config (searchBase AD, régions avec bases + aliases, excludeDisplayNamePatterns)
    regles.json             ← règles de filtrage (CRUD)
  cache/
    *.json                  ← cache AD par site (OU)
    _index.json             ← index DN → count (EXCLU du scan de champs, write protégé par retry)
    _users_global.json      ← cache global tous utilisateurs actifs (source de vérité pour Règles)
    _ous_global.json        ← cache global des OUs (arbre des sites) — lu par Get-OUTree, jamais l'AD en direct
application/
  output/                   ← CSV générés (sous-dossiers horodatés)
_initGlobalVariables.psm1   ← auto-découverte des chemins ($global:path)
CONTEXTE-SESSION.md         ← ce fichier
```

---

## Routes HTTP

| Route | Action |
|-------|--------|
| `/` ou `/shell.html` | Sert `shell.html` (point d'entrée) |
| `/explorer` | Sert `explorer.html` |
| `/regles` | Sert `regles.html` |
| `/groupes` | Sert `index.html` (Groupes Dynamiques) |
| `/index.html` | Redirect 302 → `/groupes` |
| `/api/regles` | GET liste / POST upsert |
| `/api/regles/:id` | DELETE |
| `/api/regles/:id/generate` | POST → génération CSV |
| `/api/csv/read` | POST `{ path }` → contenu d'un fichier CSV (4 colonnes : nom, sam, mail, fonction) |
| `/api/regles/preview-groups` | POST règle → groupes AD simulés (type global/do/centre + membres + baseLabel + multiBase) |
| `/api/regles/check-mail` | POST `{ address }` → `{ available: bool }` — vérifie `mail` ET `proxyAddresses` dans l'AD |
| `/api/ad/values?field=xxx` | Valeurs AD distinctes depuis le cache |
| `/api/tree` | Arbre AD (régions + sites) |
| `/api/ou/users?dn=xxx[&fresh=1]` | Utilisateurs d'un site (cache ou AD) |
| `/api/cache/counts` | Index des compteurs de cache |
| `/api/cache/info` | `{ builtAt: "2026-05-18T16:33:39" }` — date de MAJ de `_users_global.json` |
| `/api/cache/refresh-all` | Vide tout le cache + relance le warmup |
| `/api/users/preload` (`↻ Cache`) | Reconstruit **TOUS** les caches : `Build-OUsCache` + `Build-GlobalUsersCache` + purge des `*.json` par site + warmup |

> Méthodes HTTP (désormais explicites sous Pode) : **POST** pour `refresh-all`,
> `users/preload`, `regles` (upsert), `regles/:id/generate`, `regles/preview-groups`,
> `regles/generate-pair`, `regles/check-mail` ; **DELETE** pour `regles/:id` ; **GET**
> pour tout le reste.

---

## Serveur Pode (`http-server.psm1`)

Depuis juillet 2026, le serveur repose sur **Pode** (multi-thread) au lieu de
`System.Net.HttpListener`. Point d'entrée : **`Start-AppServer -Port`** (appelée par
`Start.ps1`). Frontend et modules métier (`ad-reader`, `csv-generator`, cache) inchangés.

### Fonctionnement (validé par POC + tests end-to-end)
- **Multi-thread** : `Start-PodeServer -Threads 3`. Une requête lente (génération,
  preview-groups, check-mail) **ne gèle plus l'UI** (mesuré : `/api/tree` en 57 ms
  pendant un `preview-groups` de 1922 ms en parallèle).
- **État partagé entre runspaces** : les `$global:*` (`parametresJson`, `AD_credential`,
  `path`, `fileLog`) sont snapshotés au démarrage via `Set-PodeState`, puis **réhydratés
  avant chaque requête** par un **middleware** (`Get-PodeState`). Le port est passé via
  `$global:__AppPort` (une variable locale n'est pas garantie d'être capturée par le
  scriptblock de `Start-PodeServer`).
- **Disponibilité des fonctions** : l'**auto-import Pode** réimporte tous les modules de
  session dans les runspaces → `Get-OUTree`, `Get-AllUsersFromCache`, `add-msg`, etc. sont
  dispo dans les routes **sans `Import-PodeModule`**.
- **Garde `_initGlobalVariables`** : son init top-level est enveloppé dans
  `if ($null -eq $PodeContext)` — sinon l'auto-import rejouerait ses effets de bord
  (réécriture de `variablesGlobales.json`, nouveaux logs) à chaque runspace.
- **Corps POST** : parsé en PSCustomObject via `ConvertFrom-Json $WebEvent.Request.Body`
  (car `$WebEvent.Data` est un `OrderedHashtable`, incompatible avec `.PSObject.Properties`
  — nécessaire pour préserver `invertOf`).
- **Concurrence sûre** : les lecture-modification-écriture de `regles.json`
  (POST/DELETE `/api/regles`) sont protégées par **`Lock-PodeObject`** (verrou global).
- **Réponses** : helpers `Send-Json` (→ `Write-PodeTextResponse -ContentType 'application/json'`,
  JSON déjà sérialisé, pas de re-sérialisation) et `Serve-File` (bytes + `Cache-Control:
  no-cache`). ⚠️ `Write-PodeTextResponse` ajoute lui-même `; charset=utf-8` → passer un
  ContentType **nu**. Statuts via `Set-PodeResponseStatus` implicite (param `-StatusCode`) ;
  redirection 302 via `Move-PodeResponseUrl`.

### ⚠️ Piège opérationnel
Pode se lie via une **socket directe**. Si une ancienne instance HttpListener occupe
encore le port 8888 (`Get-NetTCPConnection -LocalPort 8888` → pid 4/System = http.sys),
Pode **échoue à démarrer** (« socket interdit ») tout en affichant « Serveur actif ».
→ **Fermer l'ancien serveur avant de lancer le nouveau.** Vérifier qu'on parle bien au
nouveau serveur via l'en-tête **`Server: Pode`**.

---

## Fonctionnalités implémentées

### Shell (`/`)
- ✅ 3 iframes lazy-load (Explorer chargé immédiatement, autres au premier clic)
- ✅ Onglet actif marqué `.active` dans le header
- ✅ Communication postMessage pour le workflow "créer règle depuis Explorer"
- ✅ **Badge date cache** format long : `Cache : lundi 18 mai 2026 17:52` — rafraîchi toutes les 60s + polling 10s après `cache-rebuilt` (s'arrête quand `builtAt` change)

### Explorateur AD (`/explorer`)
- ✅ Arbre AD par régions/sites (prefetch de tous les sites en arrière-plan)
- ✅ **Accordion régions** : ouvrir une région ferme toutes les autres
- ✅ **Badge compteur de sites** par région (nombre de sous-OUs `^A\d{5}`, statique, affiché à la création du nœud)
- ✅ **Filtre OUs** : seules les OUs dont le nom correspond à `^A\d{5}` sont des sites valides (exclut "Groupes", "Partenaires", etc.)
- ✅ Sélection d'un site → tableau d'utilisateurs avec tri + regroupement
- ✅ Recherche cross-site (filtre arbre + tableau simultanément)
- ✅ **Recherche étendue** : cherche aussi par **nom de site** (ex. `%rungis%`) en plus des champs utilisateur — sites non cachés affichés avec badge amber "non chargé — cliquer pour ouvrir"
- ✅ **Surlignage des occurrences** : fonction `hlText(text, q)` → `<mark class="hl">` (fond jaune) appliquée sur nom de site (en-têtes groupes) + toutes les cellules du tableau (nom, description, fonction, mail, service)
- ✅ Panneau détail utilisateur (onglets Détail / MAJ AD)
- ✅ Modal Fonction (analyse d'une fonction sur 1 site / région / toute la structure)
- ✅ Actualisation de cache site par site ou par région entière
- ✅ Snapshot `sessionStorage` (TTL 30 min) pour accès direct sans shell
- ✅ Après `↻ Cache`, envoie `postMessage({ type: 'cache-rebuilt' })` au shell (rafraîchit le badge date)
- ✅ **Bouton toggle panneau Détail** : chevron `‹/›` dans le header du panneau, collapse à 30px avec transition CSS `.detail-collapsed`. État du bouton (icône + title) mis à jour dynamiquement.

### Règles (`/regles`)
- ✅ CRUD complet des règles
- ✅ Sélecteur de valeurs AD (cache, groupé par premier mot, filtrable)
- ✅ Multi-sélection avec checkboxes + bouton Valider → N lignes créées
- ✅ Exclusion des valeurs déjà utilisées dans la même liste
- ✅ Toggle actif/inactif avec confirmation
- ✅ Règles inactives dans une section séparée en bas de la liste
- ✅ Bouton "Générer le CSV" dans le formulaire (règle en cours uniquement, visible en mode édition)
- ✅ Bouton "Supprimer" dans le footer **gauche** ; Annuler/Générer/Enregistrer dans le footer **droit**
- ✅ Modale CSV — arbre hiérarchique de fichiers (global → DO → centre) avec styles distincts
- ✅ Modale CSV — en-tête avec critères de sélection (pills verts = include, rouges = exclude)
- ✅ Sous-modale CSV — tableau Nom + Fonction uniquement (SAM/Mail masqués en prévisualisation)
- ✅ Message en filigrane dans la zone principale vide (texte grand, gradient gris, opacité 55%)
- ✅ Cartes : une seule ligne `.rule-card-row` (label seul, clic = ouvre formulaire)
- ✅ Modal JSON (visualiseur brut avec coloration syntaxique)
- ✅ Modal Aide (8 étapes expliquées)
- ✅ Tooltips JS `position:fixed` au survol (badges niveau + boutons cartes)
- ✅ Confirmation avant suppression et avant toggle
- ✅ Description auto-calculée : `"Par centre · 3 CSV (centre + DO + global) · 2 conditions"` — lecture seule, mise à jour live
- ✅ Description du niveau (bandeau sous le sélecteur 1/2/3, mise à jour au clic)
- ✅ Préchargement utilisateurs AD en arrière-plan au chargement (barre de statut dans le footer sidebar)
- ✅ Barre de progression animée dans le footer pendant la génération CSV
- ✅ **Fix cache** : suppression de la stale-detection (`proxyAddresses`) qui déclenchait 179 re-fetch AD à chaque chargement de page
- ✅ **Fix filtre ADMINISTRATIF** : `Test-UserMatchesRule` — conditions positives (`eq`/`like`) en OR, conditions négatives (`ne`/`notlike`) en AND
- ✅ **Modale "Prévisualiser les groupes"** (`/api/regles/preview-groups`) — layout multi-colonnes :
  - 1/2/3 colonnes selon le niveau (détection par types présents : global/do/centre)
  - Colonne 3 interactive : clic sur un groupe DO → remplace le contenu de la colonne par ses centres
  - Chaque carte centre affiche la liste des membres (nom + fonction, scroll interne max 80px)
  - **Case à cocher "Membres"** dans le header de la modale → masque/affiche toutes les listes de membres
  - Badge type supprimé pour DO et Centres (nombre affiché uniquement, avec tooltip)
  - **Entête colonne Centres dynamique** : `FORMATEURS-DO-I2N — 46 Groupes (excluant 5 avec 0 utilisateur) · 477 pers.`
  - **Sous-catégorisation multiBase** : DO I2N → séparateurs NORD / IDF ; DO SUD → séparateurs SUD / SUD-EST (sticky, masqués si tout filtré)
  - Barre de recherche en colonne 3 (par nom groupe / utilisateur / fonction) — masque aussi les séparateurs de base si aucun item visible
  - Avertissement ⚠ dans le bandeau méta si un nom dépasse 64 caractères (limite Exchange)
  - Bouton plein écran : la dernière colonne s'élargit davantage
  - **Onglet "Groupes"** + **onglet "Adresses mail"** (contrôle AD des adresses)
  - Contrôle AD des adresses mail via `POST /api/regles/check-mail`
  - **Bouton Stop** pour annuler le contrôle en cours — flag `container._checkAborted`
  - **Drag de la modale** : header `grab`, `setPointerCapture` → impossible de rester bloqué si souris quitte l'iframe
- ✅ **Liaison maître/subordonné entre règles (`invertOf`)** :
  - Une règle peut être l'**inverse dynamique** d'une autre (ex. ADMINISTRATIF = tous − FORMATEURS)
  - Champ `invertOf` dans `regles.json` stocke l'`id` de la règle source
  - Backend calcule l'inverse à la volée (preview + génération CSV) : `ALL_USERS − source_rule_users`
  - Formulaire subordonné : **banner verrouillé** (fond bleu) avec les conditions sources en pills lecture seule — préfixe, niveau, nom, actif restent éditables
  - `readForm()` et `POST /api/regles` préservent `invertOf` à chaque sauvegarde
  - **Icônes dans les cartes** : maître = git-fork bleue (`var(--accent)`), subordonné = ↳ ambrée (`#92400e`)
  - `metaLabel()` affiche `"Inverse de FORMATEURS · Par centre · …"` pour les règles subordonnées
  - `FIELD_LABELS = Object.fromEntries(FIELDS)` — mapping clé → libellé pour les pills du banner
  - **Niveau de groupement verrouillé** pour les règles `invertOf` : radios `disabled` + `.niveau-locked` (opacity 0.55 + pointer-events none) + note "Hérité de « FORMATEURS » — non modifiable"
  - **Propagation du niveau** : à la sauvegarde d'une règle maître, toutes les règles enfants (`invertOf === rule.id`) sont mises à jour automatiquement (`niveau` + `monoNiveau`). Toast de confirmation : "Règle enregistrée · niveau propagé à ADMINISTRATIF"
- ✅ **Mini-modale peer (œil sur cartes de groupe)** :
  - Icône œil (`.btn-gp-eye-peer`) sur chaque carte `.gp-row-item` dans la modale preview, visible au survol
  - Clic → ouvre une mini-modale flottante draggable montrant les membres du groupe **inverse** (FORMATEURS → données ADMINISTRATIF et vice-versa)
  - Membres triés + regroupés par fonction (`peer-mini-fn-hdr` avec compteur)
  - **Drag** : `setPointerCapture` — impossible de rester bloqué si souris quitte l'iframe
  - **Fermeture** : bouton ×, **clic extérieur** (`mousedown` capture sur `document`, ajouté via `setTimeout(0)`), ou fermeture de la modale principale
  - **Surbrillance de la carte active** : `.gp-peer-active` (fond ambré `#fef9ec`, bordure `#f59e0b`, shadow `#fde68a`) — transférée au clic sur un nouvel œil, retirée à la fermeture
  - Callback `onClose` passé à `showPeerGroupMini` pour nettoyer la surbrillance
  - **Fix accumulation de listeners** : `modal._peerClickListener` — l'ancien listener est retiré avant d'en ajouter un nouveau ; fermeture de la modale principale nettoie également
  - **Fix drag bloquant l'UI** : remplacement de `document.addEventListener('mousemove/mouseup')` par `setPointerCapture` sur la mini-modale

### Modale CSV (après génération)
- ✅ Onglet **"Fichiers CSV"** + onglet **"Adresses mail"** (même composant réutilisable)
- ✅ `renderMailTab` et `checkMails` : fonctions génériques avec `container` (pas d'IDs codés en dur)

---

## Évolutions récentes — architecture cache + page HTML des groupes (juillet 2026)

### Architecture « tout passe par le cache » (renforcée)
- **Règle projet (CLAUDE.md)** : aucune recherche (utilisateurs, OUs, valeurs de champ…) n'interroge l'AD en direct. Seules les fonctions `Build-*Cache` (dans `ad-reader.psm1`) ont le droit d'appeler `Get-AD*`.
- **Cache OUs** `_ous_global.json` : construit par `Build-OUsCache`, lu par `Get-OUsFromCache`. **`Get-OUTree` lit ce cache** (lazy-build si absent), jamais l'AD.
- Le sélecteur de valeurs du champ **OU** (`Get-ADFieldValues` field `ou`) et l'arbre des sites lisent ce cache.
- **↻ Cache** (`/api/users/preload`) reconstruit **TOUS** les caches (OUs + utilisateurs + sites) et le footer se rafraîchit.

### Règles — champ OU + opérateurs
- Champ condition **« Unité d'organisation (OU) »** avec **sélecteur avancé** listant les OUs depuis le cache (recherche intégrée). Sites au format `A#####`.
- Opérateurs **« est vide » / « n'est pas vide »** (`empty`/`notempty`, sans valeur).
- `Test-Condition` (csv-generator) : `like`/`notlike` utilisent des wildcards `*valeur*` (fix ISTELI niveaux 2/3 qui remontaient 0 utilisateur).
- Exclusion OU-based via `parametres.json` → `ad.excludeOUs` (ex. « Comptes generiques »).

### Verrouillage des règles
- Une règle validée peut être **verrouillée** (`locked: true`) : bloque modification/suppression (garde-fous serveur **403** sur `DELETE /api/regles/:id` et `POST /api/regles`), page grisée, bouton **Déverrouiller**.
- Cadenas 🔒 dans la liste et dans le **mini-menu** (sidebar repliée).

### Sidebar Règles repliable
- Bouton chevron replie/déplie la sidebar (état mémorisé `localStorage`).
- Repliée (~58 px) : règles en **initiales** (2 lettres, nom complet en infobulle), rubriques de niveau en mini-badges **N1/N2/N3**, actions en icônes, cadenas overlay.

### Page HTML autonome des groupes — `buildGroupsHtmlDoc` (regles.js)
- Bouton **« Afficher page HTML »** + onglet **« Aperçu groupes »** (après Paramètres) qui affiche **exactement la même page** via un **`<iframe srcdoc>`** (rendu strictement identique), mis en cache par signature de règle.
- Thème gris, **recherche + auto-complétion** (+ bouton vider), **filtre par DO**, **Tout replier**, **Masquer les membres**, **Plein écran**.
- Niveau 3 : **une colonne par DO** (grille pleine largeur, **centrée si < 4 DO** via `cols-N`). Membres en 2 sous-colonnes alignées (`Prénom NOM | FONCTION`).
- **Zone figée (sticky)** : en-tête (nom du groupe seul) + barre d'outils + **carte globale + rangée des en-têtes DO** intégrés dans `.topbar` sticky ; seuls les centres défilent.
- En-tête épuré : **nom du groupe seul** + icône **ⓘ** ouvrant une modale (méta `préfixe · domaine · niveau · N groupe(s) · N utilisateur(s) · cache` + détail du filtre, badges INCLURE/EXCLURE colorés).
- **Compteurs** : badge « N gr. » (sous-groupes) par en-tête global/DO + badge utilisateurs ; total groupes/utilisateurs dans la méta.

### Modales de la page groupes (embarquées, `window.MAILTREE` / `window.GROUPMEMBERS`)
- **Clic sur un mail de niveau 1/2 (conteneur)** → modale **arbre des adresses/groupes** : colonnes **2/3/4** par DO, en-têtes de colonne + titre **sticky**, bascule d'affichage **Tout / Noms seuls / Mails seuls** (icône œil), compteur « N groupe(s) » par colonne, pastille du nb de membres par entrée.
- **Clic sur un centre DANS cette modale** → modale de ses **membres** (une colonne `Prénom NOM | FONCTION`). La modale membres ne s'ouvre **pas** depuis la page principale (drill-down uniquement). `z-index` membres (1001) > adresses (1000) ; Échap ferme d'abord les membres.

---

## Cache global utilisateurs (`_users_global.json`)

**Source de vérité pour le module Règles.** Contient tous les utilisateurs AD actifs avec les champs :

```
dn, displayName, samAccountName, mail, title, department, office,
extensionAttribute1, description, userPrincipalName, proxyAddresses,
manager, company, employeeNumber, postalCode, streetAddress, enabled, builtAt
```

> **`dn` est indispensable** pour `Get-RegionFromDN` et `Get-CentreFromDN`. Si le champ est absent (cache construit avant son ajout), la prévisualisation Règles ne retourne que le groupe global. → Reconstruire avec **↻ Cache** dans l'Explorateur.

**Reconstruction** : `Build-GlobalUsersCache` dans `ad-reader.psm1` — appelée automatiquement au warmup si le fichier n'existe pas, ou manuellement via `↻ Cache`.

---

## Groupement par région et par centre — fonctions DN

### `Get-RegionFromDN` — niveau DO

```powershell
function Get-RegionFromDN {
    param([string]$DN)
    if (-not $DN) { return '' }
    foreach ($region in $global:parametresJson.ad.regions) {
        foreach ($base in $region.bases) {
            if ($DN -like "*,$base") { return $region.label }
        }
    }
    return ''
}
```

- Utilisé dans : `Group-Object { Get-RegionFromDN $_.dn } | Where-Object { $_.Name -and $_.Name -ne 'MONCHY' }`

### `Get-CentreFromDN` — niveau centre (remplace `Group-Object Office`)

```powershell
function Get-CentreFromDN {
    param([string]$DN)
    if (-not $DN) { return '' }
    foreach ($part in ($DN -split ',')) {
        if ($part -match '^OU=(A\d{5})\s*-\s*(.+)$') { return $Matches[2].Trim() }
        if ($part -match '^OU=(A\d{5})$')             { return $Matches[1] }
    }
    return ''
}
```

- Extrait le nom du centre depuis l'OU du DN : `OU=A22100 - Narbonne` → `Narbonne` → après `Clean-ForFileName` → `NARBONNE`
- **Remplace `Group-Object Office`** dans `http-server.psm1` (1 occurrence) et `csv-generator.psm1` (3 occurrences)
- Raison : le champ `Office` (Bureau) AD peut être incohérent (ex. "CARCASSONNE" pour un utilisateur dans l'OU Narbonne)

### Régions multiBase

DO I2N et DO SUD ont plusieurs bases AD (`bases: [...]`) :

| Région | Bases | baseLabel |
|--------|-------|-----------|
| DO I2N | NORD + IDF | `NORD` / `IDF` |
| DO SUD | SUD + SUD-EST | `SUD` / `SUD-EST` |

---

## Exclusion de comptes techniques (`Test-UserExcluded`)

Comptes techniques (ex. Ricoh, imprimantes) exclus de TOUS les groupes FORMATEURS et ADMINISTRATIF.

**Configuration** dans `parametres.json` :
```json
"excludeDisplayNamePatterns": ["ricoh"]
```

**Fonction** dans `ad-reader.psm1` :
```powershell
function Test-UserExcluded {
    param([object]$User)
    $patterns = @($global:parametresJson.ad.excludeDisplayNamePatterns | Where-Object { $_ })
    if (-not $patterns -or $patterns.Count -eq 0) { return $false }
    $name = "$($User.displayName)"
    foreach ($p in $patterns) {
        if ($name -match [regex]::Escape($p)) { return $true }
    }
    return $false
}
```

Filtre appliqué **après** `$filtered` dans `http-server.psm1` et `csv-generator.psm1` :
```powershell
$filtered = @($filtered | Where-Object { -not (Test-UserExcluded $_) })
```

Pour ajouter d'autres exclusions : `"excludeDisplayNamePatterns": ["ricoh", "scanner", "imprimante"]` — insensible à la casse.

---

## `_index.json` — Écriture concurrente

`Update-CacheIndex` et `Update-LocalIndex` (warmup) protègent l'écriture par une **boucle retry** (5 tentatives × 50 ms) avec `catch [System.IO.IOException]`. L'index est non-critique (les fichiers individuels par site sont la source de vérité).

---

## csv-generator.psm1 — Architecture interne

**Problème clé résolu** : dans `ForEach-Object -Parallel`, les objets AD passés dans la closure sont **désérialisés** → `DisplayName`, `Title` deviennent vides.

**Solution** : séparer accès AD et écriture fichier.

```powershell
# Accès aux propriétés AD dans le thread principal (objets natifs)
function Get-CsvContent { param($Users) ... return $sb.ToString() }

# Écriture parallèle (reçoit du texte, jamais d'objets AD)
function Invoke-WriteJobs { param($Jobs)
    $Jobs | ForEach-Object -Parallel {
        [System.IO.File]::WriteAllText($_.path, $_.content, [System.Text.Encoding]::UTF8)
    } -ThrottleLimit 8
}
```

Chaque job hashtable : `@{ path = '...'; fname = '...'; content = <string pré-calculée> }`.

### parametres.json — régions avec bases et aliases

```json
{ "label": "DO I2N",   "bases": ["OU=NORD,...", "OU=IDF,..."],     "aliases": ["DO NORD", "DO IDF", "NORD", "IDF", "I2N"] }
{ "label": "DO OUEST", "bases": ["OU=OUEST,..."],                   "aliases": ["DO OUEST", "OUEST"] }
{ "label": "DO EST",   "bases": ["OU=EST,..."],                     "aliases": ["DO EST", "EST"] }
{ "label": "DO SUD",   "bases": ["OU=SUD,...", "OU=SUD-EST,..."],   "aliases": ["DO SUD", "SUD", "SUD-EST"] }
{ "label": "MONCHY",   "bases": ["OU=MONCHY,..."],                  "aliases": ["MONCHY"] }
```

---

## Conventions et pièges connus

### PowerShell
- `switch` est une **instruction**, pas une expression → ne pas l'utiliser dans `[string](switch {...})`, toujours assigner à `$var` d'abord
- `Get-ChildItem -Filter "*.json" -Exclude "_index.json"` **ne fonctionne pas en PS5.1** → utiliser `| Where-Object { $_.Name -ne '_index.json' }`
- `$global:path."f_xxx"` → chemin fichier ; `$global:path."r_xxx"` → chemin dossier
- `_initGlobalVariables.psm1` auto-découvre TOUS les fichiers de l'arborescence → pas besoin d'enregistrer manuellement de nouveaux fichiers
- **Parallel runspaces** : ne jamais passer des objets AD à `ForEach-Object -Parallel` — les propriétés étendues (DisplayName, Title, etc.) seront vides après désérialisation. Toujours pré-calculer le contenu dans le thread principal.
- `Get-ADUser` ne retourne **pas** `DisplayName` par défaut → toujours l'inclure dans `-Properties`
- **Écriture fichier concurrente** : utiliser boucle retry avec `catch [System.IO.IOException]` plutôt qu'un mutex (plus simple, acceptable pour un index non-critique)

### CSS / JS
- `display: flex` sur n'importe quel élément écrase l'attribut `[hidden]` du navigateur → **toujours** ajouter `.element[hidden] { display: none; }` dès qu'on met `display: flex` ou `display: grid` sur un élément qu'on veut pouvoir cacher via `hidden`
- **Drag et iframes** : utiliser `setPointerCapture` / `pointermove` / `pointerup` sur l'élément draggable plutôt que `document.addEventListener('mousemove')` — si la souris quitte l'iframe, `mouseup` n'est jamais reçu et le drag se bloque. `setPointerCapture` reçoit tous les events même hors de l'élément et hors de la fenêtre.
- **Clic extérieur sur un popup flottant** : utiliser `document.addEventListener('mousedown', handler, true)` (capture) ajouté via `setTimeout(0)` pour éviter que le clic courant ferme immédiatement. Guard `if (element.hidden) { remove; return; }` pour éviter les doubles appels.
- Fonctions génériques avec `container` : préférer `container.querySelector('.class')` à `document.getElementById('id')` pour les composants réutilisables dans plusieurs contextes
- Tooltips dans des conteneurs `overflow: hidden` : utiliser `position: fixed` côté JS (système `data-tooltip` + `setupTooltip()`)
- Dans les iframes, `100vh` = hauteur de l'iframe (pas de la fenêtre parente) → header masqué = layout doit passer à `height: 100vh`
- Structure d'une carte règle : `.rule-card-row` (label seul, clic = ouvre formulaire)
- **Séparateurs sticky dans une liste scrollable** : `position: sticky; top: 0; z-index: 1` sur le séparateur, à l'intérieur d'un parent `overflow-y: auto`
- **Masquer les séparateurs orphelins** après un filtre de recherche : stocker `data-base-hdr` sur le séparateur et `data-base` sur chaque item → après chaque filtre, vérifier si au moins un item de la même base est visible

### Variables globales
- `$global:parametresJson` → config depuis `parametres.json`
- `$global:AD_credential` → credentials AD actifs
- `$global:path` → dictionnaire de tous les chemins auto-découverts
- `$global:AD_usersCache` → cache utilisateurs pré-chargé en arrière-plan au démarrage

---

## Règle absolue — AD en lecture seule

**Interdits** : `Set-AD*`, `New-AD*`, `Remove-AD*`, `Add-ADGroupMember`, `Remove-ADGroupMember`  
**Autorisés** : `Get-ADUser`, `Get-ADGroup`, `Get-ADGroupMember`, `Get-ADObject`, `Get-ADDomain`

---

## Projet historique : `gestionAutomatiqueGroupesAD`

Appli PowerShell (script interactif, sans interface web) qui servait d'antécédent à ce projet. Elle **écrit** l'AD (création groupes, ajout membres) — tout ce qui est interdit ici. Les informations ci-dessous documentent sa logique pour alimenter la future phase d'écriture.

### Flux général

```
Active Directory
  └→ init_adUsers()         — charge tous les utilisateurs filtrés
       └→ createCSVFiles()  — génère CSV par niveau
            └→ contrôleDistributionGroups_CSV()  — compare CSV ↔ groupes AD existants
                 └→ create_DistributionGroups()  — crée les groupes manquants (New-ADGroup)
                      └→ AddMembersToDistributionGroup()  — alimente depuis le CSV (Set-ADGroup clear + Add-ADGroupMember)
```

Les CSV sont une **étape intermédiaire**, pas la source de vérité. Tout part de l'AD, les CSV servent de liste de travail.

### Format CSV généré

- Séparateur `;`, encodage UTF-8, 2 colonnes :
  ```
  mail;samaccountname
  utilisateur@aftral.com;jdupont
  ```
- CSV feuilles (centres) : contiennent les **utilisateurs**
- CSV parents (DO, global) : contiennent les **mails des groupes enfants** (récursif)

### Calcul du nom et de l'adresse mail d'un groupe

**Étape 1 — `genereNomGroupe()`** construit le nom du groupe (= nom du fichier CSV) :

| Niveau | Composantes | Exemple résultat |
|--------|-------------|-----------------|
| 3 (centre) | type + DO + centre | `Administratif AURASUD CournonDAuvergne` |
| 2 (DO) | type + DO | `Administratif AURASUD` |
| 1 (global) | type seul | `Administratif` |

Transformations appliquées à chaque composante :
- Suppression des accents : encodage Cyrillic → ASCII
- TitleCase + suppression des espaces internes
- Pour le DO : supprime le préfixe `"DO"` (`"DO AURASUD"` → `"AURASUD"`)

**Étape 2 — `create_Mail()`** calcule le mail depuis le nom du groupe :

```powershell
$arg = $arg.ToLower().replace(" ",".")   # espaces → points
$arg = [supprimer les accents via Cyrillic]
return "$arg@$domain"
```

Exemples bout en bout :
```
"Administratif AURASUD CournonDAuvergne" → administratif.aurasud.cournondeauvergne@aftral.com
"Administratif AURASUD"                 → administratif.aurasud@aftral.com
"Administratif"                         → administratif@aftral.com
```

**Étape 3 — `create_samAccountName()`** : prend le mail du groupe, supprime domaine + préfixe + espaces + points + tirets.

### Structure hiérarchique complète (niveau 3)

```
Administratif.csv             ← membres = mails des CSV DO
  Administratif AURASUD.csv   ← membres = mails des CSV centres AURASUD
    Administratif AURASUD CournonDAuvergne.csv  ← membres = utilisateurs AD
    Administratif AURASUD Montlucon.csv
  Administratif EST.csv       ← membres = mails des CSV centres EST
    Administratif EST Appoigny.csv
```

### Écarts avec le projet actuel

| Aspect | Ancienne appli | Projet actuel (`generate-pair`) |
|--------|---------------|--------------------------------|
| Séparateur CSV | `;` | `,` |
| Colonnes CSV | `mail;samaccountname` | `samAccountName,mail` |
| Mail du groupe | calculé et stocké | non implémenté (CSV contiennent uniquement les utilisateurs) |
| Groupes récursifs | oui (parents contiennent mails enfants) | non (chaque groupe = liste d'utilisateurs) |
| Écriture AD | `New-ADGroup` + `Add-ADGroupMember` | interdit (lecture seule) |

> **Point clé** : pour la future phase d'écriture AD, il faudra implémenter les CSVs récursifs (groupes DO et global avec mails des enfants) et le calcul du mail groupe (`nom.tolower().replace(" ",".")@domain`).

---

## Idées / potentiel futur

- Filtrage / tri des règles dans la sidebar
- Export/import du fichier `regles.json`
- Prévisualisation du nombre d'utilisateurs avant génération
- Pagination ou recherche si beaucoup de règles
- CSVs récursifs (agréger les mails de groupe DO/global) — nécessaire pour la phase écriture AD
