# CLAUDE.md — Instructions projet : Groupes Dynamiques I2N

## RÈGLE ABSOLUE — Active Directory en LECTURE SEULE

**Toute interaction avec l'Active Directory est STRICTEMENT en lecture seule.**

- Utiliser UNIQUEMENT : `Get-ADGroup`, `Get-ADUser`, `Get-ADGroupMember`, `Get-ADObject`, `Get-ADDomain`
- **INTERDITS sans exception** : `Set-AD*`, `New-AD*`, `Remove-AD*`, `Add-ADGroupMember`, `Remove-ADGroupMember`, `Rename-AD*`, `Move-ADObject`
- Ne jamais proposer, suggérer ou écrire du code qui modifie l'AD **sauf si l'utilisateur le demande explicitement**
- L'utilisateur introduira les opérations d'écriture (`Set-AD*`, `Add-ADGroupMember`, etc.) en temps voulu — attendre sa demande explicite avant d'en écrire

## Architecture

- **Backend** : PowerShell + `System.Net.HttpListener` (serveur HTTP local)
- **Frontend** : HTML/CSS/JS pur (pas de framework)
- **Port** : 8888 (localhost uniquement)
- **Authentification AD** : credentials XML chiffrés via `Export-CliXml` / `Import-CliXml`

## Modules

| Fichier | Rôle |
|---|---|
| `_initGlobalVariables.psm1` | Auto-découverte des chemins (`$global:path`) |
| `scripts/modules/connect.psm1` | Connexion AD (credentials XML) |
| `scripts/modules/ad-reader.psm1` | Lecture AD — seul module autorisé à toucher l'AD |
| `scripts/modules/http-server.psm1` | Serveur HTTP, routes API |
| `scripts/ressources/index.html` | Interface drag & drop |
| `scripts/ressources/app.js` | Logique JavaScript |
| `scripts/ressources/style.css` | Styles (thème clair, pas de fond noir) |

## Conventions

- `$global:path."f_xxx"` → chemin d'un fichier (préfixe `f_`)
- `$global:path."r_xxx"` → chemin d'un répertoire (préfixe `r_`)
- `$global:parametresJson` → configuration chargée depuis `scripts/settings/parametres.json`
- `$global:AD_credential` → credentials AD actifs
- `add-msg` → fonction de log double (console + fichier), définie dans `_initGlobalVariables.psm1`
