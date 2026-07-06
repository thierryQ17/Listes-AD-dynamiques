# TODO

## Terminé — 2026-07-06 (suite)

### DDG : Office dans Get-Recipient + copie ligne-à-ligne
- `Select-Object … , Office` ajouté aux 2 générations `Get-Recipient` (`buildDdgScriptText`
  ligne aperçu + `ddgScriptForGroup` modale).
- Icône « copier » dans la gouttière gauche de CHAQUE ligne de commande (aperçu DDG
  `#ddg-code` ET modale détail de la page groupes). Commentaires/lignes vides = gouttière
  invisible (alignement). `ddgLineGutter()`, `ddgScriptToLinesHtml()`.
- Pas d'icône de copie sur `New-DynamicDistributionGroup` (commande de création) —
  géré dans `ddgLineGutter()`.
- **Icône « ouvrir PowerShell 7 »** : dans l'en-tête de la modale détail (page groupes)
  ET dans l'onglet DDG (à gauche du bouton « Copier »). Route backend
  `POST /api/open-pwsh` → `Start-Process pwsh.exe` (fenêtre interactive vierge, aucune
  commande passée). ⚠ nécessite un REDÉMARRAGE du serveur (route Pode chargée au démarrage).
  Piège template literal ÉVITÉ : pas de `\'` dans le handler injecté dans `pageScript`
  (le `\'` deviendrait `'` et casserait la string générée) → formulation sans apostrophe.
- **BUG corrigé** : le handler de copie inséré dans `pageScript` (template literal de
  `groups-doc.js`) contenait `/\n+$/` → le `\n` devenait un vrai saut de ligne DANS le
  littéral regex → SyntaxError → tout le script de la page générée mort → clic `<>`
  sans effet. Remplacé par `.trim()`. Vérifié : le pageScript généré parse, la modale
  s'ouvre (VISIBLE), 5 icônes de copie présentes.

## Terminé — 2026-07-06

### Mode AD / Écarts DANS l'Explorateur (bascule 2 boutons)
- Conception finale (après pivot) : PAS d'onglet/page séparés — un sélecteur segmenté
  **AD / Écarts** en haut de la sidebar de l'Explorateur bascule l'affichage.
- **Défaut du mode Écarts = TOUTES les OU, aucun filtre** : à l'activation, on affiche
  d'emblée les 640 écarts (source `state.ecartUsers`, `state.ecartsAll=true`, titre
  « Écarts — toutes les OU »). Cliquer un site = filtre optionnel (`ecartsAll=false`) ;
  re-cliquer l'onglet Écarts réinitialise à tout. `activeBaseUsers()` choisit la source.
- Même arbre, même tableau, même Détail, mêmes fonctionnalités (tri, regroupement,
  recherche, filtre). Seules les **colonnes** + les **données** changent :
  - AD : Nom · Description · Fonction · Mail · Service · Ville · Bureau (7 col.)
  - Écarts : Nom · Ville (OU) · Bureau (surbrillance rouge/ambre) ; lignes filtrées
    aux comptes en écart ; menu Colonnes masqué. (Colonne « Statut » retirée : la
    surbrillance du Bureau suffit à signaler l'écart.)
- Source unique = backend : `ensureEcartsLoaded()` indexe `status` par `samAccountName`
  depuis `/api/ecarts/office-ou` (aucune logique d'écart dupliquée en JS). Invalidé au
  rebuild de cache. `modeList()` filtre, `ecartStatusOf()` lit le statut.
- Colonne `col-status` (8e, `colspan` passés à 8) masquée hors mode Écarts via CSS.
- **Arbre en mode Écarts : ne montre QUE les sites ayant des écarts** (`ecartSiteCounts()`
  rattache chaque compte à son site via le suffixe de l'ouDn ; `applyEcartTreeFilter()` /
  `clearEcartTreeFilter()`). Sites/DO à 0 écart masqués (`.ecart-empty`) ; badges = nb
  d'écarts (ambre). Les écarts « hors région » (sans site dans l'arbre) restent visibles
  dans la vue globale « toutes les OU ».
- Bouton « ⚠ Écarts OU/Bureau » (`#ecarts-btn`) **retiré** de la sidebar.
- Revert de l'essai précédent : onglet `Écarts` retiré du shell. Page `/ecarts`
  conservée (accessible en direct) mais plus liée depuis l'Explorateur.
- Fix CSS partagé conservé : `.tree-search-clear[hidden]`/`.user-filter-clear[hidden]`.
- Vérifié CDP + capture : AD (105 util., 7 col.) ↔ Écarts (2 écarts, 4 col., badges,
  surbrillance Bureau, Détail, tri Statut) ↔ retour AD OK.

## En cours

### Modale « détail DDG » par centre (page Aperçu groupes)
- Icône `</>` sur chaque carte CENTRE (à gauche du pill compteur) → ouvre une modale large.
- Modale : (A) code PowerShell du groupe (`New-DynamicDistributionGroup` + `Get-Recipient`)
  dans un div noir colorié comme l'onglet DDG ; (B) explication **par personne** des écarts.
- Décisions : explication détaillée par membre · icône centres seulement (niveau 3).
- Étapes : 1) backend enrichir membres (`office`) ; 2) `regles.js` pré-calcule la map
  scripts par groupe + l'embarque dans le doc ; 3) `groups-doc.js` icône + modale +
  colorateur PS inline + explication (raison : Office ≠ groupe / EXO seul / non-OPATH).


## A faire

### Patterns de nommage pour les groupes FORMATEURS et ADMIN (demain)
- Mécanisme de **patterns (gabarits)** pour construire **nom + mail** des groupes.
- **Opt-in par règle** via une **case à cocher** ; défaut = mécanisme actuel
  (`{prefix}-{do}-{centre}`, mail = nom.ToLower()@mailDomain).
- Case cochée → **DEUX gabarits texte libre indépendants** (par règle), tokens en `{{ }}` :
  - **Pattern du NOM** du groupe — ex. `Formateurs-{{region}}-{{nomCentre}}`
    (ADMIN : `Personnes Adm -{{region}}-{{nomCentre}}`).
  - **Pattern du MAIL** du groupe — ex. `formateurs.{{region}}.{{nomCentre}}@aftral.com`
    (indépendant du nom, pas dérivé de lui).
  Tokens : `{{region}}` = libellé DO **SANS le préfixe « DO »** (ex. « DO I2N » → `I2N`,
  « DO SUD » → `SUD`), `{{nomCentre}}` (= centre) ; prévoir `{{prefix}}`, `{{domain}}`.
- Un centre peut n'avoir qu'un seul sous-groupe (FORM sans ADMIN, ou l'inverse).
- **Question à trancher en 1er** : le pattern crée-t-il un **groupe CENTRE agrégé**
  (FORM+ADMIN réunis) ou **renomme**-t-il les groupes de la règle ? (+ liste des patterns).
- **Centraliser** la construction nom/mail (dupliquée ~8×) dans un résolveur backend
  (`http-server.psm1` preview-groups / generate-pair ; `csv-generator.psm1`
  Invoke-RuleGeneration + Write-CsvNiveau*). Réutiliser `Clean-ForFileName`,
  `Get-RegionFromDN`, `Get-CentreFromDN`. Rappel : **AD lecture seule**.
- Détails complets dans le fichier de plan : `~/.claude/plans/clever-dancing-ritchie.md`.

## Termine
- **Sous-onglet DDG (Règles)** — génère le TEXTE des scripts `New-DynamicDistributionGroup`
  par groupe (arbo global ▸ DO ▸ centre), zone sombre + coloration PowerShell. Aucune action
  AD/Exchange. Backend : `preview-groups` expose `containerDN` (OU, dérivée du DN cache).
  Frontend : `buildOpathFilter` (jumeau OPATH de `buildLdapHtml`), `highlightPowerShell`,
  `loadDdg`. Ligne `Get-Recipient -RecipientPreviewFilter … | Select DisplayName,Fonction`
  sous chaque `New-DDG` (le DDG n'expose pas ses membres) + `Connect-ExchangeOnline` en tête.
- **Contrôle de population (mon mécanisme vs DDG)** — dans la page HTML des groupes
  (Aperçu / Afficher page HTML). Chaque carte affiche 2 colonnes : gauche = mon mécanisme,
  droite (zone rouge) = **DDG estimé localement** (mêmes conditions mappables + BAL=mail
  renseigné, sans exclusion Ricoh). Diff : `mem-drop` (perdu par DDG, rouge barré),
  `mem-add` (DDG seul, ambre) + ligne delta « ≈N communs · −N hors DDG · +N DDG seul ».
  Backend `preview-groups` : `ddgMembers`/`ddgCount`/`sam` par groupe. Validé sur cache réel :
  FORMATEURS 0 écart ; ADMINISTRATIF 211 perdus (tous sans BAL). Estimation locale —
  vérité terrain = `Get-Recipient` (onglet DDG).
- Migration du serveur HTTP vers **Pode** (multi-thread) — commits `84e813f` / `6125ece`.
- UI : onglets Détail/MAJ AD affichent tous les champs (— si vide).
- Doc `docs/INTEGRATION-242.md` (déploiement sur le 242).

## Revue

