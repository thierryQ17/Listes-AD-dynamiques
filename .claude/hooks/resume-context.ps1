# Hook SessionStart (matcher "clear") - Groupes Dynamiques I2N
# But : apres un /clear, reinjecter CONTEXTE-SESSION.md (la vue d'ensemble durable du
# projet) comme contexte, pour repartir avec un tres bon apercu du projet en cours.
# La sortie stdout de ce script est ajoutee au contexte de la nouvelle session.

$ErrorActionPreference = 'SilentlyContinue'
# stdout en UTF-8 (sinon les accents sont manglifies a l'injection).
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$root = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (Get-Location).Path }
$ctx  = Join-Path $root 'CONTEXTE-SESSION.md'

if (Test-Path $ctx) {
    "## Contexte du projet repris automatiquement apres /clear"
    "Source : CONTEXTE-SESSION.md (vue d'ensemble durable : archi, routes, fonctionnalites,"
    "conventions, pieges). Elle reflete l'etat au dernier `maj` : verifie l'etat reel des"
    "fichiers / du depot avant d'agir, ne suppose pas que rien n'a bouge depuis."
    ""
    "---"
    ""
    Get-Content -Path $ctx -Raw -Encoding UTF8
}
