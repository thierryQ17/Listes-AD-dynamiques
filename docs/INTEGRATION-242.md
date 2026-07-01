# Intégration de l'appli « Groupes Dynamiques I2N » sur le serveur 242

> **But** : déployer cette application (désormais **Pode**) sur le serveur **242**
> (`a20000a00s242.aft-iftim.france`) en réutilisant le patron éprouvé de l'appli
> **`web_GESTION SIGNATURE 2026`** : Pode en tâche planifiée + IIS reverse-proxy.
>
> **Statut** : document de préparation. Les adaptations décrites ci-dessous ne sont
> **pas encore faites** — c'est la feuille de route. Rédigé le 2026-07-01.
>
> Légende de certitude : ✅ vérifié · 🔎 à confirmer · ⚠️ point d'attention.

---

## 1. Architecture cible (identique à Signatures)

```
Navigateur d'un poste
   └─▶ IIS  (port réseau dédié, ex. 8081) — Windows Auth ON / Anonyme OFF
         └─ reverse-proxy ARR / URL-Rewrite ──▶ Pode 127.0.0.1:<port> (jamais exposé)
               lancé par une TÂCHE PLANIFIÉE (au démarrage, RestartCount 3)
               sous un COMPTE DE SERVICE peu privilégié (lecture AD seule)
```

Deux briques, deux outils : le **site IIS** (inetmgr) et la **tâche planifiée** Pode
(taskschd.msc). ✅ Le 242 héberge déjà d'autres sites (AFTRAL, WebTool, Signatures) →
**ne jamais** faire `iisreset` / `Stop-Service W3SVC` : n'agir que sur NOTRE site.

---

## 2. Ce qui est déjà acquis ✅

- L'application est **déjà Pode** (`Start-AppServer` → `Start-PodeServer`), multi-thread.
- **AD en lecture seule** → compatible avec le compte de service mutualisé « lecture AD ».
- Le 242 a déjà **IIS + ARR + le compte de service** (`svc.pode.apps.99999`) opérationnels.
- **Pas de dépendance Graph / Exchange** ici → **pas de certificat** à gérer (plus simple
  que Signatures).
- Les 3 scripts de déploiement de Signatures sont **paramétrés** et réutilisables :
  `install-242-pode.ps1`, `setup-iis-242.ps1`, `arretRelance242__IIS-tachePlanifierPode.ps1`.

---

## 3. Différences avec l'appli de référence

| Aspect | Signatures (référence) | Notre appli | Impact |
|---|---|---|---|
| Point d'entrée | `server.ps1` (racine) | `Start.ps1` (racine) → `Start-AppServer` | mineur (paramètre `-File`) |
| Clé port config | `pode.port` | `server.port` (= 8888) | adapter les scripts |
| Threads / address | `pode.threads` / `pode.address` (config) | **en dur** (`-Threads 3`, `localhost`) | externaliser (§6) |
| Auth AD (runtime) | **LDAP `DirectoryEntry` + identité du process**, DC épinglé, **sans cred** ✅ | `Get-AD* -Credential` (CliXml **per-user**) ×11 | 🔴 **à changer** (§5) |
| Dépôt | Azure DevOps (interne) | **GitHub** `thierryQ17/Listes-AD-dynamiques` ✅ | livraison au 242 (§7) |
| Auth utilisateur | IIS Windows Auth + `authz.psm1` | **aucune** | IIS Windows Auth suffit (§9) |
| Cert Graph/Exchange | requis | **non requis** | plus simple |

---

## 4. 🔴 Point bloquant n°1 — les credentials AD

**Preuve** : notre `scripts/modules/connect.psm1` charge un credential via
`Import-CliXml` d'un fichier **par utilisateur** (`thgadre.adm-credential.xml`), et
`ad-reader.psm1` passe `-Credential $global:AD_credential` **11 fois**.
`Export-CliXml` chiffre le mot de passe en **DPAPI lié au compte créateur** : ce fichier
**ne se déchiffre pas** sous le compte de service. De plus `Get-AdminLogin` renvoie
`thgadre.adm` en dur → fichier illisible, et la re-création via `Read-Host` **bloquerait**
dans une tâche planifiée non interactive.

**Modèle prouvé côté référence** (`connect.psm1` de Signatures, vérifié) : la lecture AD
se fait en **LDAP brut** (`System.DirectoryServices.DirectoryEntry` sur un DC épinglé
`auth.adServer`) **avec l'identité du process** (le compte de service), **sans credential
stocké** ; `Connect-ADSession` y tente d'abord `Get-ADDomain` **sans -Credential** et
réussit sous le compte de service.

**Options pour nous** (par ordre de préférence) :
1. **Identité intégrée (recommandé)** — sous le compte de service, appeler `Get-AD*`
   **sans** `-Credential` (le token du process suffit, AD en lecture). Le plus propre,
   aligné sur la référence. Nécessite :
   - retirer/rendre optionnel `-Credential` dans les ~11 appels de `ad-reader.psm1` ;
   - rendre `Connect-ADSession` « no-op » quand `Get-ADDomain` réussit déjà (sans cred) ;
   - ⚠️ **ADWS (port 9389)** doit être joignable depuis le 242 (`Get-AD*` en dépend). Sinon
     basculer en LDAP `DirectoryEntry` (port 389) comme la référence.
2. **credential.xml recréé SOUS le compte de service** — une exécution interactive unique
   *en tant que* `svc.pode.apps.99999` pour générer le XML DPAPI à son nom. Fonctionne mais
   fragile (rotation de mot de passe = à refaire) et étape manuelle.
3. **gMSA** — le plus robuste, mais chantier infra (hors périmètre immédiat).

> 🔎 À décider avec l'équipe : option 1 (intégré) vs 2 (XML service). Recommandation :
> **option 1**. Prévoir aussi de pouvoir **épingler un DC** (`ad.server`) + test TCP,
> comme la référence, pour éviter le hang de la découverte « serverless ».

---

## 5. Adaptations de code nécessaires (avant déploiement)

- [ ] **Credentials AD** → identité intégrée (voir §4). *Le vrai gros morceau.*
- [ ] **`-Browse` conditionnel** ⚠️ — `Start-AppServer` fait `Start-PodeServer -Browse`
      (parfait en poste local, **néfaste en tâche planifiée non interactive** sur serveur).
      Le rendre optionnel : paramètre `-Browse` sur `Start-AppServer`, activé seulement en
      lancement interactif (poste), désactivé pour le service 242.
- [ ] **Externaliser la config Pode** — lire `server.port`, et ajouter `server.threads` /
      `server.address` dans `parametres.json` (défauts : 3 / `localhost`). Derrière IIS,
      Pode **reste sur `localhost`** (jamais exposé).
- [ ] **Ne PAS utiliser `Start.bat` sur le 242** ⚠️ — son `taskkill /F /IM pwsh.exe`
      tuerait **toutes** les applis Pode du serveur (dont Signatures). Sur le 242, c'est la
      **tâche planifiée** qui lance `Start.ps1`.
- [ ] **Dossiers runtime + ACL** — le compte de service doit avoir **Modify** sur l'install
      (écritures : `scripts/cache`, `scripts/log`, `application/output`,
      `scripts/settings/variablesGlobales.json`, `scripts/settings/regles.json`). Le script
      d'install pose déjà `icacls ... (OI)(CI)M`.
- [ ] **`get_admLogin` / login figé** — `Get-AdminLogin` (switch sur `thgadre`/`clegros`)
      est inadapté à un service ; s'aligner sur la référence (login AD lu en config, sinon
      identité du process). Sans objet si option 1 (plus de cred).

---

## 6. Ports à allouer (⚠️ éviter les collisions)

Signatures occupe déjà **Pode 6660** et **IIS 8080**. Choisir des ports **libres et
distincts** pour notre appli, par ex. :

| Rôle | Signatures | Proposé pour nous |
|---|---|---|
| Pode (localhost, non exposé) | 6660 | **6661** |
| IIS (face réseau) | 8080 | **8081** |

> ⚠️ Éviter 6665-6669 (bloqués « IRC » par les navigateurs). 8081/8000/8888 sont sûrs.
> Vérifier au préalable sur le 242 : `Get-NetTCPConnection -LocalPort 6661,8081 -State Listen`.

---

## 7. Livraison du code au 242

Notre remote est **GitHub** (`https://github.com/thierryQ17/Listes-AD-dynamiques.git`),
alors que l'install de Signatures clone depuis **Azure DevOps** (interne). 🔎 À trancher :

- **A.** Le 242 atteint GitHub (internet sortant) → `git clone/pull` direct (adapter
  `-RepoUrl`). Souvent bloqué en interne.
- **B.** **Miroiter** le dépôt sur Azure DevOps (comme Signatures) → même flux que la
  référence, recommandé si le 242 n'a pas internet.
- **C.** Déploiement **par copie** (zip / robocopy) → adapter le script d'install (retirer
  le bloc git). Le plus simple pour un premier essai, mais pas de `git pull` pour les MAJ.

---

## 8. Procédure de déploiement (adaptée des scripts Signatures)

> À exécuter **sur le 242**, en **pwsh 7+**, fenêtre **Administrateur**.

1. **Prérequis** : PowerShell 7+, module **Pode 2.13.x**, module **ActiveDirectory**
   (RSAT), et ADWS joignable (ou LDAP 389 si option LDAP).
2. **Code source** : cloner/copier l'appli dans `D:\scripts\groupes_dynamiques_i2n`
   (adapter `-InstallPath`), selon le choix §7.
3. **Config** : compléter `scripts/settings/parametres.json`
   (`server.port=6661`, `server.address=localhost`, `ad.server=<DC épinglé>`,
   `ad.searchBase`, `ad.mailDomain`, `ad.regions`…). Pas de secrets Graph/Exchange ici.
4. **Dossiers runtime + ACL** : créer `scripts/cache`, `scripts/log`,
   `application/output` et donner **Modify** au compte de service (`icacls ... (OI)(CI)M`).
5. **Tâche planifiee Pode** (adapter d'`install-242-pode.ps1`) :
   `New-ScheduledTaskAction pwsh -File Start.ps1` (au lieu de `server.ps1`), trigger
   `AtStartup`, `RestartCount 3`, sous le **compte de service**. Nom p.ex.
   `Pode-GroupesI2N`.
6. **Site IIS reverse-proxy** (adapter `setup-iis-242.ps1`) : `SiteName=GroupesI2N242`,
   `Port=8081`, `PodePort=6661`. Windows Auth ON / Anonyme OFF, règle pare-feu sur 8081.
   Pode reste sur `localhost:6661`.
7. **Démarrage** : démarrer la tâche, **attendre l'écoute** du port Pode (cold start +
   warmup cache ~ dizaines de s), **puis** démarrer le site IIS (Pode prêt avant IIS →
   pas de 502). Tester : `http://a20000a00s242.aft-iftim.france:8081/`.
8. **Vérifier** que c'est bien Pode : en-tête HTTP **`Server: Pode`**.

---

## 9. Exploitation (arrêt / relance)

Réutiliser le patron d'`arretRelance242__IIS-tachePlanifierPode.ps1` (adapter `-SiteName`,
`-TaskName`, `-PodePort`) :

- `-Action status` : état site + pool (partagé ?) + tâche + écoute Pode.
- `-Action stop` : désactive la tâche (pas de relance au reboot), arrête l'instance, arrête
  le **site** seulement.
- `-Action start` : réactive la tâche, attend l'écoute Pode, puis démarre le site.

⚠️ Ne jamais toucher au **pool partagé** (`DefaultAppPool`) : arrêter le **site** suffit.

---

## 10. Sécurité & accès

- Pode **jamais exposé** au réseau (127.0.0.1) ; seule face réseau = **IIS**.
- **Windows Auth** sur le site IIS → accès réservé aux utilisateurs du domaine (suffisant
  pour un outil admin **lecture seule**).
- Notre appli n'utilise **aucune identité par personne** — c'est acceptable ici. Si un
  contrôle d'accès **par utilisateur/groupe** devient nécessaire, prévoir une couche type
  `authz.psm1` (chantier séparé) exploitant l'en-tête `X-Iisnode-Logon-User` injecté par le
  `Global.asax` (cf. `setup-iis-242.ps1`).
- Rappel projet : **AD strictement en lecture** — aucun `Set-AD*` / `Add-ADGroupMember`.

---

## 11. Points ouverts à décider

1. 🔎 **Modèle credentials** : identité intégrée (recommandé) vs XML sous compte de service.
2. 🔎 **Livraison code** : GitHub direct / miroir Azure DevOps / copie (§7).
3. 🔎 **ADWS (9389) joignable** depuis le 242 ? Sinon bascule LDAP `DirectoryEntry` (389).
4. 🔎 **Ports définitifs** (proposé 6661 / 8081) — valider libres sur le 242.
5. 🔎 **Nom de domaine / URL** d'accès + périmètre des utilisateurs autorisés.

---

## 12. Checklist de mise en service

- [ ] Décisions §11 tranchées
- [ ] Code adapté (§5) : credentials, `-Browse` conditionnel, config port/threads/address
- [ ] Ports libres validés sur le 242
- [ ] Code livré sur le 242 (`D:\scripts\...`)
- [ ] `parametres.json` complété (DC épinglé, port, searchBase, regions)
- [ ] Dossiers runtime + ACL compte de service
- [ ] Tâche planifiée `Pode-GroupesI2N` (Start.ps1, au boot, compte de service)
- [ ] Site IIS `GroupesI2N242` (8081 → localhost:6661), Windows Auth, pare-feu
- [ ] Démarrage ordonné (Pode prêt → IIS), test `Server: Pode`
- [ ] Script d'arrêt/relance adapté et testé (`status`/`stop`/`start`)

---

### Fichiers de référence (à recopier/adapter depuis `web_GESTION SIGNATURE 2026`)
- `install-242-pode.ps1` — tâche planifiée + ACL + dossiers runtime
- `setup-iis-242.ps1` — site IIS reverse-proxy + Windows Auth
- `arretRelance242__IIS-tachePlanifierPode.ps1` — exploitation (start/stop/status)
- `lancer-242.bat` — lancement manuel sous compte de service (`runas /savecred`)
