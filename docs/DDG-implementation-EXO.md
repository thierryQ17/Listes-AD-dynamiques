# DDG — Implémentation Exchange Online : scoping, cache, contrôle de population

> Note technique — Groupes Dynamiques I2N. Synthèse des décisions et découvertes
> autour de la génération de scripts `New-DynamicDistributionGroup` (DDG).
> **Rappel : l'application ne fait qu'un TEXTE de scripts — aucune action AD/Exchange.**

---

## 1. Vue d'ensemble

Le module **Règles** comporte un sous-onglet **DDG** qui génère, pour chaque groupe
d'une règle (global ▸ DO ▸ centre), le **texte** d'un script `New-DynamicDistributionGroup`,
plus la commande `Get-Recipient` de contrôle du contenu (un DDG n'expose pas ses membres),
et `Connect-ExchangeOnline` en tête. Coloration PowerShell, bouton Copier.

En parallèle, la **page HTML des groupes** affiche un **contrôle de population** :
colonne « mon mécanisme » vs colonne « DDG estimé » (simulation locale du filtre OPATH),
avec diff (perdu par DDG / DDG seul).

---

## 2. Découverte clé — Exchange Online ne connaît pas les OU on-prem

**Preuve (test réel `Get-Recipient` dans EXO) :**

```
Get-Recipient : Couldn't find organizational unit
"aft-iftim.france/administratif/EST/A25000 - Jarville-la-Malgrange".
Make sure you have typed the name correctly.
```

En hybride, **AAD Connect synchronise les utilisateurs/groupes, pas les conteneurs OU**.
Donc dans Exchange Online :

- `-OrganizationalUnit "OU=…"` (Get-Recipient) **échoue** ;
- très probablement `-RecipientContainer "OU=…"` (New-DynamicDistributionGroup) **échoue aussi**.

➡️ **Le découpage par OU (centre/DO) — choisi initialement pour éviter le champ `Office`
peu fiable — ne fonctionne pas dans EXO.** C'était la réserve « on-prem vs EXO » signalée
dès l'analyse initiale, désormais **confirmée par un test terrain**.

---

## 3. Décision — niveau 3 (centre) scopé par le champ `Office` (Bureau)

Pour un DDG **centre** dans EXO, on abandonne l'OU et on met la contrainte **dans le filtre** :

```powershell
# À la place de -RecipientContainer / -OrganizationalUnit :
... -RecipientFilter "(RecipientTypeDetails -eq 'UserMailbox') -and (Title -like '*FORMATEUR*') -and (Office -eq 'BISCHHEIM')"
```

- **New-DynamicDistributionGroup** : retirer `-RecipientContainer`, ajouter `(Office -eq '<Bureau>')` au filtre.
- **Get-Recipient** : retirer `-OrganizationalUnit`, ajouter `(Office -eq '<Bureau>')` au `RecipientPreviewFilter`.

Le **Bureau** utilisé est le **Bureau dominant** des membres du centre (backend
`preview-groups` expose `office` + `officeMismatch`).

---

## 4. ⚠️ Piège majeur — le champ `Office` est incohérent

Mesure sur les centres **formateurs** (cache réel) :

| Centres | Nombre |
|---|---|
| Mono-Bureau (propres) | **113** |
| **Multi-Bureau (incohérents)** | **44** (~28 %) |
| Tous vides | 0 |

**Exemples réels :**

| Centre | Distribution du champ Office |
|---|---|
| Achères (8) | `ACHERES`×6 · `CAEN`×1 · `ROSNY SUR SEINE`×1 |
| Artigues (25) | `ARTIGUES PRES BORDEAUX`×22 · **`ARTIGUES PRES B`×2 (tronqué)** · `BRIVE LA GAILLARDE`×1 |
| Aubagne (8) | `AUBAGNE`×6 · `MARSEILLE`×1 · `OLLIOULES`×1 |

**Conséquence concrète** d'un `Office -eq '<dominant>'` :

- il **manque** les membres du centre dont le Bureau diffère (ex. les 2 formateurs
  d'Achères en CAEN/ROSNY) ;
- le `-eq` **exact coupe** les valeurs tronquées (Artigues).

➡️ Le script généré **signale par centre** le nombre d'écarts
(`/!\ Office incoherent : N membre(s) ont un Bureau != '…'`).
**Prérequis pour fiabiliser cette approche : harmonisation/nettoyage du champ `Office`
dans l'AD** (déjà identifié comme prérequis de la piste DDG).

---

## 5. Cache — comptes avec BAL uniquement

Le cache (global **et** par site) ne conserve que les comptes ayant :

- une **`primarySmtpAddress`** = proxyAddress `SMTP:` en **majuscules**
  (proxyAddresses peuplé = condition absolue de synchronisation Azure) ;
- un **`samAccountName`** renseigné.

Sur ~4400 comptes actifs, **~4009 conservés** (les ~400 écartés sont des comptes
admin/service sans BAL — sans intérêt pour des listes de distribution).
Le cache global a aussi été **allégé aux 10 champs réellement utilisés**.

---

## 6. Contrôle de population « mon mécanisme vs DDG »

- **Mon mécanisme** : utilisateurs du cache filtrés par la règle, groupés par **OU** (centre).
- **DDG estimé** : simulation **locale** du filtre OPATH (conditions mappables +
  contrainte BAL), — c'est une **estimation**, pas le vrai `Get-Recipient`.
- **Vérité terrain** = la commande `Get-Recipient` de l'onglet DDG (à lancer dans EXO).

> Tant que la simulation DDG reste scopée par **OU** et que la règle est 100 % mappable
> sur un cache BAL-only, les 2 colonnes sont **identiques par construction**.
> Aligner la simulation sur le scoping **Office** ferait apparaître les écarts réels
> dus à l'incohérence du champ Office (voir §4). **→ évolution à faire.**

---

## 7. État / à faire

- [x] Onglet DDG (scripts texte) + `Get-Recipient` de contrôle + `Connect-ExchangeOnline`.
- [x] Cache filtré BAL (primarySmtpAddress + samAccountName), global + par site.
- [x] Backend : `office` / `officeMismatch` par centre exposés dans `preview-groups`.
- [ ] **Frontend : brancher le scoping `Office` niveau 3** dans le texte des scripts
      (retirer `-RecipientContainer` / `-OrganizationalUnit`, injecter `(Office -eq '…')`,
      avertissement par centre incohérent).
- [ ] Décider du scoping **DO / global** (l'OU y échoue aussi dans EXO).
- [ ] (Optionnel) Aligner la simulation « DDG estimé » sur le scoping Office.

---

*Rappel permanent : Active Directory en LECTURE SEULE. Les scripts DDG sont du TEXTE
à exécuter manuellement le moment venu — l'application n'écrit jamais dans l'AD ni Exchange.*
