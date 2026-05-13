#Requires -Version 7.0
[CmdletBinding()]
param()

try {
    Import-Module -Name $(Join-Path $PSScriptRoot "_initGlobalVariables.psm1") -Force -ErrorAction Stop
    Import-Module -Name $global:path."f_connect.psm1"     -Force -ErrorAction Stop
    Import-Module -Name $global:path."f_ad-reader.psm1"      -Force -ErrorAction Stop
    Import-Module -Name $global:path."f_csv-generator.psm1" -Force -ErrorAction Stop
    Import-Module -Name $global:path."f_http-server.psm1"   -Force -ErrorAction Stop
} catch {
    Write-Host "ERREUR chargement des modules : $($_.Exception.Message)" -ForegroundColor Red
    Read-Host "`nAppuyez sur Entrée pour fermer"
    exit 1
}

$port = [int]$global:parametresJson.server.port
if (-not $port) { $port = 8080 }

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "     Groupes Dynamiques I2N" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Connect-ADSession)) {
    add-msg -msg "Connexion AD échouée. Arrêt." -foregroundColor Red
    Read-Host "`nAppuyez sur Entrée pour fermer"
    exit 1
}

add-msg -msg "" -foregroundColor White
add-msg -msg "Interface disponible sur : http://localhost:$port" -foregroundColor Cyan
add-msg -msg "Appuyez sur Ctrl+C dans ce terminal pour arrêter le serveur." -foregroundColor DarkGray
add-msg -msg "" -foregroundColor White

Start-CacheWarmup
Start-Process "http://localhost:$port"
Start-HttpServer -Port $port
