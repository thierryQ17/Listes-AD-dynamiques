# Hook SessionStart (matcher "clear") - Groupes Dynamiques I2N
# But : apres un /clear, reinjecter le DERNIER docs/RECAP-*.md comme contexte,
# pour reprendre directement le fil de la session precedente.
# La sortie stdout de ce script est ajoutee au contexte de la nouvelle session.

$ErrorActionPreference = 'SilentlyContinue'
# stdout en UTF-8 (sinon les accents du recap sont manglifies a l'injection).
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$root  = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (Get-Location).Path }
# Le PLUS RECENT par date d'ecriture (le tri par Nom est culture-aware -> peu fiable ici).
$recap = Get-ChildItem -Path (Join-Path $root 'docs') -Filter 'RECAP-*.md' |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1

if ($recap) {
    "## Contexte repris de la session precedente"
    "Source : docs/$($recap.Name) (reinjecte automatiquement apres /clear)."
    "Ce recap reflete l'etat AU MOMENT ou il a ete ecrit : verifie l'etat reel des"
    "fichiers / du depot avant d'agir, ne suppose pas que rien n'a bouge depuis."
    ""
    "---"
    ""
    Get-Content -Path $recap.FullName -Raw -Encoding UTF8
}
