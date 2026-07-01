# Lecons

## Regles

- Apres chaque correction de l'utilisateur, ecrire ici une regle pour ne pas repeter l'erreur.

## Tests / verification

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

