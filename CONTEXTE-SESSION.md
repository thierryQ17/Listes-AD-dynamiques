# Contexte de session — Groupes Dynamiques I2N

> Mettre ce fichier à jour en fin de session via la commande :
> `maj C:\DEV POWERSHELL\Liste de distribution\CONTEXTE-SESSION.md`

---

## Résumé du projet

Application web locale (PowerShell + HTML/CSS/JS pur) pour administrer l'AD en **lecture seule** : explorer les utilisateurs par OU, définir des règles de filtrage, et générer des CSV.

- **Backend** : PowerShell, serveur HTTP `System.Net.HttpListener` port **8888**
- **Frontend** : HTML/CSS/JS pur, sans framework
- **Démarrage** : `Start.bat` ou `Start.ps1` → ouvre `http://localhost:8888/`

---

## Architecture : shell iframe

Le point d'entrée est `shell.html` servi à `/`. Il contient **3 iframes** : l'onglet actif est visible, les autres sont `display:none` mais restent chargés en mémoire → **zéro rechargement** quand on permute d'onglet.

```
http://localhost:8888/
  └── shell.html  ← header + 3 iframes
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
    parametres.json         ← config (searchBase AD, régions avec aliases)
    regles.json             ← règles de filtrage (CRUD)
  cache/
    *.json                  ← cache AD par site
    _index.json             ← index des sites (EXCLU du scan de champs)
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
| `/api/regles/preview-groups` | POST règle → groupes AD simulés (type global/do/centre + membres) |
| `/api/regles/check-mail` | POST `{ address }` → `{ available: bool }` — vérifie `mail` ET `proxyAddresses` dans l'AD |
| `/api/ad/values?field=xxx` | Valeurs AD distinctes depuis le cache |
| `/api/tree` | Arbre AD (régions + sites) |
| `/api/ou/users?dn=xxx[&fresh=1]` | Utilisateurs d'un site (cache ou AD) |
| `/api/cache/counts` | Index des compteurs de cache |
| `/api/cache/refresh-all` | Vide tout le cache |

---

## Fonctionnalités implémentées

### Shell (`/`)
- ✅ 3 iframes lazy-load (Explorer chargé immédiatement, autres au premier clic)
- ✅ Onglet actif marqué `.active` dans le header
- ✅ Communication postMessage pour le workflow "créer règle depuis Explorer"

### Explorateur AD (`/explorer`)
- ✅ Arbre AD par régions/sites (prefetch de tous les sites en arrière-plan)
- ✅ Sélection d'un site → tableau d'utilisateurs avec tri + regroupement
- ✅ Recherche cross-site (filtre arbre + tableau simultanément)
- ✅ **Recherche étendue** : cherche aussi par **nom de site** (ex. `%rungis%`) en plus des champs utilisateur — sites non cachés affichés avec badge amber "non chargé — cliquer pour ouvrir"
- ✅ **Surlignage des occurrences** : fonction `hlText(text, q)` → `<mark class="hl">` (fond jaune) appliquée sur nom de site (en-têtes groupes) + toutes les cellules du tableau (nom, description, fonction, mail, service)
- ✅ Panneau détail utilisateur (onglets Détail / MAJ AD)
- ✅ Modal Fonction (analyse d'une fonction sur 1 site / région / toute la structure)
- ✅ Actualisation de cache site par site ou par région entière
- ✅ Snapshot `sessionStorage` (TTL 30 min) pour accès direct sans shell

### Règles (`/regles`)
- ✅ CRUD complet des règles
- ✅ Sélecteur de valeurs AD (cache, groupé par premier mot, filtrable)
- ✅ Multi-sélection avec checkboxes + bouton Valider → N lignes créées
- ✅ Exclusion des valeurs déjà utilisées dans la même liste
- ✅ Toggle actif/inactif avec confirmation
- ✅ Règles inactives dans une section séparée en bas de la liste
- ✅ Bouton "Générer le CSV" dans le formulaire (règle en cours uniquement, visible en mode édition)
- ✅ Bouton "Supprimer" dans le footer **gauche** ; Annuler/Générer/Enregistrer dans le footer **droit**
- ✅ Modale CSV — arbre hiérarchique de fichiers (global → DO → centre) avec styles distincts :
  - Fichier global : dégradé gris foncé, texte blanc
  - Fichier DO : dégradé gris clair, texte sombre
  - Fichier centre (feuille) : style item classique
- ✅ Modale CSV — en-tête avec critères de sélection (pills verts = include, rouges = exclude)
- ✅ Sous-modale CSV — tableau Nom + Fonction uniquement (SAM/Mail masqués en prévisualisation)
- ✅ Sous-modale CSV — lignes alternées gris clair/gris moyen + hover accent
- ✅ Message en filigrane dans la zone principale vide (texte grand, gradient gris, opacité 55%)
- ✅ Cartes : une seule ligne `.rule-card-row` (label + badge Inactif si besoin)
- ✅ Modal JSON (visualiseur brut avec coloration syntaxique)
- ✅ Modal Aide (8 étapes expliquées)
- ✅ Tooltips JS `position:fixed` au survol (badges niveau + boutons cartes)
- ✅ Confirmation avant suppression et avant toggle
- ✅ Description auto-calculée : `"Par centre · 3 CSV (centre + DO + global) · 2 conditions"` — lecture seule, mise à jour live quand on change le niveau ou les conditions (`metaLabel` + `autoUpdateDesc`)
- ✅ Description du niveau (bandeau sous le sélecteur 1/2/3, mise à jour au clic)
- ✅ Préchargement utilisateurs AD en arrière-plan au chargement (barre de statut dans le footer sidebar)
- ✅ Barre de progression animée dans le footer pendant la génération CSV
- ✅ **Fix cache** : suppression de la stale-detection (`proxyAddresses`) qui déclenchait 179 re-fetch AD à chaque chargement de page + vidage du cache ancien format
- ✅ **Fix filtre ADMINISTRATIF** : `Test-UserMatchesRule` — conditions positives (`eq`/`like`) en OR, conditions négatives (`ne`/`notlike`) en AND (auparavant tout en OR → les Formateurs passaient le filtre)
- ✅ **Modale "Prévisualiser les groupes"** (`/api/regles/preview-groups`) — layout multi-colonnes :
  - 1/2/3 colonnes selon le niveau (détection par types présents : global/do/centre)
  - Colonne 3 interactive : clic sur un groupe DO → remplace le contenu de la colonne par ses centres
  - Chaque carte centre affiche la liste des membres (nom + fonction, scroll interne max 80px)
  - Badge de type uniquement en colonne 1 (Global) — supprimé pour DO et Centres (redondant avec l'en-tête)
  - En-têtes : "Groupe global" / "Groupes DO [count]" / "Centres" (se met à jour avec le nom DO sélectionné)
  - Avertissement ⚠ dans le bandeau méta si un nom dépasse 64 caractères (limite Exchange)
  - `monoNiveau` n'affecte que la génération CSV, pas la prévisualisation (toujours hiérarchie complète)
  - Compteur utilisateurs en haut à droite de chaque carte (`.gp-row-top` flex)
  - Bouton plein écran : la dernière colonne s'élargit davantage (`.gp-box--wide .gp-col:last-child { flex: 2.5 }`)
  - Cartes avec fond blanc + ombre sur fond gris (`.gp-col-list { background: #efefef }`)
  - Colonne 3 : grille multi-colonnes responsive (`repeat(auto-fill, minmax(220px, 1fr))`)
  - Barre de recherche en colonne 3 (par nom groupe / utilisateur / fonction) + bouton clear + select-all au focus
  - Scroll fix : `.gp-body { display: flex; flex-direction: column }` → `.gp-columns { flex: 1; min-height: 0 }` (**`display:flex` écrase `[hidden]` → toujours ajouter `.gp-body[hidden] { display: none }` pour les flex containers**)
  - **Onglet "Groupes"** (vue existante) + **onglet "Adresses mail"** (arbre hiérarchique global → DO → centre)
  - Contrôle AD des adresses mail : `POST /api/regles/check-mail` → LDAP `(|(mail=$addr)(proxyAddresses=*:$addr))`
  - Barre de progression pendant le contrôle — adresse courante affichée
  - **Bouton Stop** (rouge) pour annuler le contrôle en cours — flag `container._checkAborted`
  - Abort automatique à la fermeture de la modale (×, clic fond)

### Modale CSV (après génération)
- ✅ Onglet **"Fichiers CSV"** (arbre hiérarchique existant) + onglet **"Adresses mail"** (même composant `renderMailTab` / `checkMails` que la modale prévisualisation)
- ✅ `Invoke-RuleGeneration` retourne maintenant `groups` + `mailDomain` en plus de `files`/`total`/`outDir`
- ✅ `renderMailTab(data, container)` et `checkMails(groups, container)` : fonctions génériques réutilisables dans les deux contextes (pas d'IDs codés en dur — tout via `container.querySelector`)

### Modèle de données — Règle
```json
{
  "id": "abc123",
  "label": "Administratif",
  "niveau": 3,
  "monoNiveau": false,
  "active": true,
  "conditions": {
    "include": [{ "field": "title", "op": "like", "value": "*Adjoint*" }],
    "exclude": [{ "field": "department", "op": "eq", "value": "Direction" }]
  },
  "createdAt": "2025-01-01T10:00:00",
  "updatedAt": "2025-01-01T12:00:00"
}
```

> `description` n'est **pas** persisté dans le JSON — il est calculé dynamiquement par `metaLabel(rule)` dans `regles.js` et affiché en lecture seule dans le formulaire et les cartes.

**Champs** : `title`, `department`, `office`, `extensionAttribute1`, `description`  
**Opérateurs** : `eq`, `ne`, `like`, `notlike`

### Niveaux de groupement CSV
| Niveau | Label | Fichiers produits |
|--------|-------|-------------------|
| 1 | Global | 1 CSV global |
| 2 | Par DO | 2 CSV (DO + global) |
| 3 | Par centre | 3 CSV (centre + DO + global) |

`monoNiveau: true` + niveau 3 = centre par DO seulement, sans CSV DO ni global.

### Format CSV généré
```
"nom";"samaccountname";"mail";"fonction"
"Dupont Jean";"jdupont";"jdupont@example.com";"FORMATEUR"
```

Colonnes : `DisplayName`, `SamAccountName`, `Mail`, `Title`.

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

### Get-NormalizedDepartment

Normalise le champ `Department` AD vers les labels canoniques des régions (`parametres.json`).

```powershell
function Get-NormalizedDepartment {
    param([string]$Department)
    # Cherche dans $global:parametresJson.ad.regions : label + aliases (insensible à la casse)
    # Retourne le label canonique (ex. "DO NORD" → "DO I2N") ou la valeur brute si pas de match
}
```

Utilisé dans tous les `Group-Object { Get-NormalizedDepartment $_.Department }`.

### parametres.json — régions avec aliases

Chaque région a un tableau `aliases` pour normaliser les valeurs brutes du champ `Department` :

```json
{ "label": "DO I2N",   "aliases": ["DO NORD", "DO IDF", "NORD", "IDF", "I2N", "DO I2N"] }
{ "label": "DO OUEST", "aliases": ["DO OUEST", "OUEST"] }
{ "label": "DO EST",   "aliases": ["DO EST", "EST"] }
{ "label": "DO SUD",   "aliases": ["DO SUD", "DO SUD-EST", "SUD", "SUD-EST", "DO AURASUD", "AURASUD", "DO AURA", "AURA"] }
{ "label": "MONCHY",   "aliases": ["MONCHY", "DO MONCHY"] }
```

> Si les valeurs de `Department` dans l'AD ne correspondent pas aux aliases, les ajuster directement dans `parametres.json` sans toucher au code PS.

---

## Conventions et pièges connus

### PowerShell
- `switch` est une **instruction**, pas une expression → ne pas l'utiliser dans `[string](switch {...})`, toujours assigner à `$var` d'abord
- `Get-ChildItem -Filter "*.json" -Exclude "_index.json"` **ne fonctionne pas en PS5.1** → utiliser `| Where-Object { $_.Name -ne '_index.json' }`
- `$global:path."f_xxx"` → chemin fichier ; `$global:path."r_xxx"` → chemin dossier
- `_initGlobalVariables.psm1` auto-découvre TOUS les fichiers de l'arborescence → pas besoin d'enregistrer manuellement de nouveaux fichiers
- **Parallel runspaces** : ne jamais passer des objets AD à `ForEach-Object -Parallel` — les propriétés étendues (DisplayName, Title, etc.) seront vides après désérialisation. Toujours pré-calculer le contenu dans le thread principal.
- `Get-ADUser` ne retourne **pas** `DisplayName` par défaut → toujours l'inclure dans `-Properties`

### CSS / JS
- `display: flex` sur n'importe quel élément écrase l'attribut `[hidden]` du navigateur → **toujours** ajouter `.element[hidden] { display: none; }` dès qu'on met `display: flex` ou `display: grid` sur un élément qu'on veut pouvoir cacher via `hidden`
- Fonctions génériques avec `container` : préférer `container.querySelector('.class')` à `document.getElementById('id')` pour les composants réutilisables dans plusieurs contextes
- Tooltips dans des conteneurs `overflow: hidden` : utiliser `position: fixed` côté JS (système `data-tooltip` + `setupTooltip()`)
- Dans les iframes, `100vh` = hauteur de l'iframe (pas de la fenêtre parente) → header masqué = layout doit passer à `height: 100vh`
- Structure d'une carte règle : `.rule-card-row` (label seul, clic = ouvre formulaire)

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

## Idées / potentiel futur

- Filtrage / tri des règles dans la sidebar
- Export/import du fichier `regles.json`
- Prévisualisation du nombre d'utilisateurs avant génération
- Pagination ou recherche si beaucoup de règles
- CSVs récursifs (agréger les mails de groupe DO/global) — à valider avec l'utilisateur
