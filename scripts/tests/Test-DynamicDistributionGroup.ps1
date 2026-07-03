#Requires -Modules ExchangeOnlineManagement
<#
.SYNOPSIS
    Script de TEST — Groupe de distribution dynamique Exchange Online (DDG).

.DESCRIPTION
    Banc d'essai pour valider l'approche « dynamic distribution group » evoquee
    dans le post Teams (Equipe-Infra S.I.).

    Il s'appuie sur les 2 commandes cibles :
      1. Get-Recipient -RecipientPreviewFilter  -> PREVISUALISE les membres qui
         correspondraient au filtre, SANS rien creer (100 % lecture seule).
      2. New-DynamicDistributionGroup           -> cree reellement le DDG
         (uniquement si -Create est fourni).

    Philosophie : PREVIEW D'ABORD. On construit le RecipientFilter a partir des
    parametres, on affiche qui matche, et on ne cree le groupe QUE sur demande
    explicite. Apres creation, on re-previsualise a partir du RecipientFilter
    reellement enregistre par Exchange (comme dans l'exemple d'origine :
    Get-Recipient -RecipientPreviewFilter $ddg.RecipientFilter ...).

.PARAMETER Name
    Nom du groupe de distribution dynamique de test.

.PARAMETER RecipientTypeDetails
    Type de destinataire cible (par defaut UserMailbox).

.PARAMETER CustomAttribute1
    Valeur attendue de CustomAttribute1 (ex. "DOMAINE INFRA").
    Ignore si vide.

.PARAMETER Office
    Valeur attendue de l'attribut Office / physicalDeliveryOfficeName
    (ex. "MONCHY SAINT ELOI"). Ignore si vide.

.PARAMETER OrganizationalUnit
    OU racine de recherche (facultatif). Restreint le perimetre du preview
    et sert de RecipientContainer a la creation.

.PARAMETER Create
    Cree reellement le DDG (appelle New-DynamicDistributionGroup).
    Sans ce switch, le script se limite au preview (lecture seule).

.PARAMETER Cleanup
    Supprime le DDG de test s'il existe (Remove-DynamicDistributionGroup),
    puis sort. Utile pour rejouer le test proprement.

.EXAMPLE
    # Preview seul (lecture seule) — reproduit l'exemple du post Teams
    .\Test-DynamicDistributionGroup.ps1 `
        -Name "TEST-DSI INFRA MONCHY" `
        -CustomAttribute1 "DOMAINE INFRA" `
        -Office "MONCHY SAINT ELOI"

.EXAMPLE
    # Preview PUIS creation reelle du groupe
    .\Test-DynamicDistributionGroup.ps1 -Create -CustomAttribute1 "DOMAINE INFRA" -Office "MONCHY SAINT ELOI"

.EXAMPLE
    # Nettoyage du groupe de test
    .\Test-DynamicDistributionGroup.ps1 -Cleanup

.NOTES
    Prerequis : Install-Module ExchangeOnlineManagement ; Connect-ExchangeOnline.
    Rappel : la creation d'un DDG N'inclut PAS visualisation des membres stockee,
    exceptions, ni imbrication (limites connues, cf. post Teams).
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]   $Name = "TEST-DSI INFRA MONCHY",
    [string]   $RecipientTypeDetails = "UserMailbox",
    [string]   $CustomAttribute1 = "DOMAINE INFRA",
    [string]   $Office = "MONCHY SAINT ELOI",
    [string]   $OrganizationalUnit,
    [switch]   $Create,
    [switch]   $Cleanup
)

$ErrorActionPreference = 'Stop'

# --- Champs de sortie communs pour tous les previews ---------------------------
$selectFields = 'Name', 'PrimarySmtpAddress', 'RecipientTypeDetails', 'Office', 'CustomAttribute1'

# --- 1. Verifier la connexion Exchange Online ----------------------------------
function Assert-ExchangeOnlineConnected {
    try {
        $null = Get-ConnectionInformation -ErrorAction Stop
    }
    catch {
        Write-Host "Aucune session Exchange Online active. Connexion..." -ForegroundColor Yellow
        Connect-ExchangeOnline -ShowBanner:$false
    }
}

# --- 2. Construire le RecipientFilter a partir des parametres ------------------
function Build-RecipientFilter {
    $clauses = @()
    if ($RecipientTypeDetails) { $clauses += "(RecipientTypeDetails -eq '$RecipientTypeDetails')" }
    if ($CustomAttribute1)     { $clauses += "(CustomAttribute1 -eq '$CustomAttribute1')" }
    if ($Office)               { $clauses += "(Office -eq '$Office')" }

    if (-not $clauses) {
        throw "Aucun critere fourni : precisez au moins RecipientTypeDetails, CustomAttribute1 ou Office."
    }
    return ($clauses -join ' -and ')
}

# --- 3. Previsualiser les membres (LECTURE SEULE) ------------------------------
function Show-Preview {
    param(
        [Parameter(Mandatory)] [string] $Filter,
        [string] $Ou,
        [string] $Titre = "Previsualisation des membres"
    )

    Write-Host "`n=== $Titre ===" -ForegroundColor Cyan
    Write-Host "RecipientFilter : $Filter" -ForegroundColor DarkGray
    if ($Ou) { Write-Host "OrganizationalUnit : $Ou" -ForegroundColor DarkGray }

    $params = @{
        RecipientPreviewFilter = $Filter
        ResultSize             = 'Unlimited'
    }
    if ($Ou) { $params.OrganizationalUnit = $Ou }

    $membres = Get-Recipient @params | Select-Object $selectFields

    $nb = @($membres).Count
    Write-Host "-> $nb destinataire(s) correspondant(s)." -ForegroundColor Green
    if ($nb -gt 0) { $membres | Format-List }
    return $membres
}

# ===============================================================================
#  DEROULEMENT
# ===============================================================================
Assert-ExchangeOnlineConnected

# --- Mode nettoyage : supprime le groupe de test et sort -----------------------
if ($Cleanup) {
    $existant = Get-DynamicDistributionGroup -Identity $Name -ErrorAction SilentlyContinue
    if ($existant) {
        if ($PSCmdlet.ShouldProcess($Name, "Remove-DynamicDistributionGroup")) {
            Remove-DynamicDistributionGroup -Identity $Name -Confirm:$false
            Write-Host "Groupe de test '$Name' supprime." -ForegroundColor Green
        }
    }
    else {
        Write-Host "Aucun groupe '$Name' a supprimer." -ForegroundColor Yellow
    }
    return
}

# --- Etape A : preview AVANT toute creation (safe) -----------------------------
$filter = Build-RecipientFilter
Show-Preview -Filter $filter -Ou $OrganizationalUnit -Titre "Preview AVANT creation (lecture seule)" | Out-Null

# --- Etape B : creation reelle du DDG (uniquement si -Create) -------------------
if (-not $Create) {
    Write-Host "`n[INFO] Mode preview uniquement. Ajoutez -Create pour creer reellement le groupe." -ForegroundColor Yellow
    return
}

if (Get-DynamicDistributionGroup -Identity $Name -ErrorAction SilentlyContinue) {
    throw "Le groupe '$Name' existe deja. Relancez avec -Cleanup pour le supprimer d'abord."
}

if ($PSCmdlet.ShouldProcess($Name, "New-DynamicDistributionGroup")) {
    $newParams = @{
        Name           = $Name
        RecipientFilter = $filter
    }
    if ($OrganizationalUnit) { $newParams.RecipientContainer = $OrganizationalUnit }

    $ddg = New-DynamicDistributionGroup @newParams
    Write-Host "`nGroupe '$($ddg.Name)' cree." -ForegroundColor Green

    # --- Etape C : re-preview a partir du filtre REELLEMENT enregistre ----------
    #     (reproduit fidelement l'exemple d'origine)
    Show-Preview -Filter $ddg.RecipientFilter -Ou $ddg.RecipientContainer `
                 -Titre "Preview APRES creation (filtre stocke par Exchange)" | Out-Null
}
