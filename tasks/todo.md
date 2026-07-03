# TODO

## En cours

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

