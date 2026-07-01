# TODO

## En cours

## A faire

### Patterns de nommage pour les groupes FORMATEURS et ADMIN (demain)
- Mécanisme de **patterns (gabarits)** pour construire **nom + mail** des groupes.
- **Opt-in par règle** via une **case à cocher** ; défaut = mécanisme actuel
  (`{prefix}-{do}-{centre}`, mail = nom.ToLower()@mailDomain).
- Case cochée → **choix d'un pattern** ; défaut proposé `{centre}` (→ `centre@aftral.com`).
- Un centre peut n'avoir qu'un seul sous-groupe (FORM sans ADMIN, ou l'inverse).
- **Question à trancher en 1er** : le pattern crée-t-il un **groupe CENTRE agrégé**
  (FORM+ADMIN réunis) ou **renomme**-t-il les groupes de la règle ? (+ liste des patterns).
- **Centraliser** la construction nom/mail (dupliquée ~8×) dans un résolveur backend
  (`http-server.psm1` preview-groups / generate-pair ; `csv-generator.psm1`
  Invoke-RuleGeneration + Write-CsvNiveau*). Réutiliser `Clean-ForFileName`,
  `Get-RegionFromDN`, `Get-CentreFromDN`. Rappel : **AD lecture seule**.
- Détails complets dans le fichier de plan : `~/.claude/plans/clever-dancing-ritchie.md`.

## Termine
- Migration du serveur HTTP vers **Pode** (multi-thread) — commits `84e813f` / `6125ece`.
- UI : onglets Détail/MAJ AD affichent tous les champs (— si vide).
- Doc `docs/INTEGRATION-242.md` (déploiement sur le 242).

## Revue

