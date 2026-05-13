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
    parametres.json         ← config (searchBase AD, etc.)
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
- ✅ Génération CSV (bouton dans formulaire + icône dans carte)
- ✅ Boutons icônes uniquement sur les cartes (crayon, pause/play, poubelle, CSV)
- ✅ Modal JSON (visualiseur brut avec coloration syntaxique)
- ✅ Modal Aide (8 étapes expliquées)
- ✅ Tooltips JS `position:fixed` au survol (badges niveau + boutons cartes)
- ✅ Confirmation avant suppression et avant toggle

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

**Champs** : `title`, `department`, `office`, `extensionAttribute1`, `description`  
**Opérateurs** : `eq`, `ne`, `like`, `notlike`

### Niveaux de groupement CSV
| Niveau | Fichiers produits |
|--------|-------------------|
| 1 | 1 CSV global |
| 2 | 1 CSV par DO (Department) + 1 global |
| 3 | 1 CSV par centre (Office) par DO + 1 par DO + 1 global |

`monoNiveau: true` (niveau 3 uniquement) = centre par DO seulement, pas de CSV DO ni global.

---

## Conventions et pièges connus

### PowerShell
- `switch` est une **instruction**, pas une expression → ne pas l'utiliser dans `[string](switch {...})`, toujours assigner à `$var` d'abord
- `Get-ChildItem -Filter "*.json" -Exclude "_index.json"` **ne fonctionne pas en PS5.1** → utiliser `| Where-Object { $_.Name -ne '_index.json' }`
- `$global:path."f_xxx"` → chemin fichier ; `$global:path."r_xxx"` → chemin dossier
- `_initGlobalVariables.psm1` auto-découvre TOUS les fichiers de l'arborescence → pas besoin d'enregistrer manuellement de nouveaux fichiers

### CSS / JS
- `display: flex` sur une overlay écrase `[hidden]` → toujours ajouter `.overlay[hidden] { display: none; }`
- Tooltips dans des conteneurs `overflow: hidden` : utiliser `position: fixed` côté JS (système `data-tooltip` + `setupTooltip()`)
- Dans les iframes, `100vh` = hauteur de l'iframe (pas de la fenêtre parente) → header masqué = layout doit passer à `height: 100vh`

### Variables globales
- `$global:parametresJson` → config depuis `parametres.json`
- `$global:AD_credential` → credentials AD actifs
- `$global:path` → dictionnaire de tous les chemins auto-découverts

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
