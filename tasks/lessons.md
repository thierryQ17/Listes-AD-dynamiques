# Lecons

## Regles

- Apres chaque correction de l'utilisateur, ecrire ici une regle pour ne pas repeter l'erreur.
- **Ne JAMAIS lier parent<->enfant par le NOM affiche.** L'apercu des groupes reliait
  `centre.parent === dg.name`. Un gabarit sans `{{region}}` (ex. "Centre AFTRAL",
  "isteli") produit des DO homonymes -> chaque centre matchait TOUS les DO -> redondance
  (chaque centre affiche 4x, une par colonne DO). Correction : le backend emet une `key`
  unique (base hierarchique `$lbl` / `$doBase` / `$cBase`) et `parent` = clef du parent ;
  le frontend lie par `gk(g)=g.key??g.name`. `data-dokey` (unique) pour la liaison
  colonne<->en-tete, `data-do` (nom) conserve pour recherche/categorisation.
- **Une adresse mail ne contient pas d'espace.** Centre multi-mots (ex. "Le Havre") :
  dans `Resolve-GroupIdentity`, remplacer `\s+` par `-` sur le MAIL uniquement
  (le nom du groupe garde ses espaces).

## Listing base sur les fichiers = dossiers VIDES invisibles

- Un delta SANS difference cree un dossier `__DELTA CSVs -- <date>` VIDE (aucun .csv).
  `/api/output/list` n'enumerait que les `*.csv` (`Get-ChildItem -Filter *.csv -Recurse`)
  -> dossier vide absent de `run.files` -> ni badge Δ ni groupe dans l'arbre. L'utilisateur
  croit que "le dossier ne se cree pas" alors qu'il existe sur le disque.
  Correction : la route remonte aussi `deltaDirs` (sous-dossiers `__DELTA CSVs*`, meme vides)
  et le frontend injecte un groupe vide marque « 0 ». Regle : quand on liste par fichiers,
  penser aux dossiers vides qui doivent rester visibles.
- **Preuve/contre-preuve** : avant de conclure "pas cree", verifie sur le disque
  (`find application/output -type d -name '__DELTA*'`) -> le dossier existait bien, vide.

## Cache dans un etat DEGENERE (present mais vide) — garde-fou insuffisant

- `_ous_global.json` peut contenir les 5 regions avec `children:[]` (0 site). `Get-OUTree`
  ne se reconstruisait que si l'arbre etait vide AU NIVEAU REGIONS (`Count -eq 0`) -> un
  cache a 5 regions sans site n'etait JAMAIS repare -> warmup « 0 sites » a chaque demarrage.
  Correction : tester aussi le nombre total de SITES (`$siteCount -eq 0`) avant de renoncer
  a reconstruire. Regle generale : un garde-fou « cache absent » doit aussi couvrir « cache
  present mais vide/degenerate », sinon un mauvais etat se fige.

## Cache global = comptes avec BAL uniquement

- `Build-GlobalUsersCache` ne conserve QUE les comptes avec `primarySmtpAddress`
  (= proxyAddress `SMTP:` en MAJUSCULES ; proxyAddresses peuple = condition absolue de
  synchro Azure) ET `samAccountName`. Extraction : `-cmatch '^SMTP:(.+)$'` (sensible casse).
  ~4007/4412 conserves. Le cache reflete ainsi la population « boites aux lettres » (celle
  qu'un DDG verrait), ce qui aligne mecanisme et DDG.

## Rechargement des modules (piege)

- Le serveur Pode charge `csv-generator.psm1` / `http-server.psm1` UNE fois au demarrage
  (`Start.ps1`). Editer un `.psm1` ne se voit PAS tant que le serveur n'est pas relance.
  Toujours rappeler a l'utilisateur de redemarrer avant de conclure "corrige".

## Tests / verification

- **Valider une fonction PS hors-ligne : `Import-Module`, jamais dot-source (`.`).** Un
  `.psm1` dot-source (`. .\module.psm1`) ne definit AUCUNE fonction dans le scope courant
  (verifie : `Get-Command` -> False pour toutes). Utiliser
  `Import-Module .\module.psm1 -Force` puis appeler la fonction. Tres pratique pour prouver
  une logique (ex. `Resolve-GroupIdentity`, `Get-RuleGroupCount`) sur le cache reel sans
  demarrer Pode ni toucher l'AD (charger le cache via `[IO.File]::ReadAllText` + `ConvertFrom-Json`).
- **Toujours confirmer QUE le serveur teste est bien le sien avant de conclure.** Lors de
  la migration Pode, un ancien serveur HttpListener tournait encore sur le port 8888
  (visible : `Get-NetTCPConnection -LocalPort 8888` -> pid 4 / System = http.sys). Mon
  nouveau serveur Pode a echoue silencieusement a se lier (`$listener.Start()` -> "socket
  interdit" = port occupe) tout en affichant "Serveur actif". Mes requetes de test ont
  frappe l'ANCIEN serveur -> faux positif "ca marche". Regle : verifier un marqueur propre
  au nouveau code (ici l'entete `Server: Pode`), et tester sur un port LIBRE en cas de doute.
- Preuve/contre-preuve : le log du serveur ($listener.Start() en erreur) etait la
  contre-preuve du "ca marche" apparent. Toujours lire le log du process teste.

## Migration Pode (references utiles)

- Pode execute le scriptblock de `Start-PodeServer` sur le thread principal AVANT
  d'importer les modules dans les runspaces -> les `$global:*` y sont accessibles
  (`Set-PodeState` fonctionne). Mais une variable LOCALE (param de fonction) n'est pas
  garantie d'etre capturee -> passer par un `$global:`.
- L'auto-import Pode reimporte TOUS les modules de session dans les runspaces (donc
  effets de bord au chargement rejoues). `$PodeContext` existe dans le runspace avant
  ces imports -> garder l'init derriere `if ($null -eq $PodeContext)`.
- `$WebEvent.Data` = OrderedHashtable ; corps brut PSCustomObject = `$WebEvent.Request.Body`.
- `Write-PodeTextResponse` ajoute lui-meme `; charset=utf-8` -> passer un ContentType nu.

