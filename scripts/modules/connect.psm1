function Connect-ADSession {
    try {
        Import-Module ActiveDirectory -ErrorAction Stop
    } catch {
        add-msg -msg "Module ActiveDirectory non disponible. Installez RSAT." -foregroundColor Red
        return $false
    }

    $admLogin = Get-AdminLogin
    $credPath = $global:path."f_mdp__AD_$admLogin-credential.xml"

    if ($credPath -and (Test-Path $credPath)) {
        $global:AD_credential = Import-CliXml -Path $credPath -ErrorAction Stop
    } else {
        $result = New-ADCredentialXml -path $global:path."r_xmlConnect_AD" -login $admLogin
        if (-not $result) { return $false }
        $global:AD_credential = $result.adCredential
        $credPath             = $result.adCredentialPath
    }

    try {
        $adServer = $global:parametresJson.ad.server
        $domainParams = @{ Credential = $global:AD_credential; ErrorAction = 'Stop' }
        if ($adServer) { $domainParams['Server'] = $adServer }
        $null = Get-ADDomain @domainParams
        add-msg -msg "Connexion AD réussie pour '$admLogin'." -foregroundColor Green
        return $true
    } catch {
        add-msg -msg "Échec connexion AD : $($_.Exception.Message)" -foregroundColor Red
        add-msg -msg "Vérifier ou supprimer : $credPath" -foregroundColor Yellow
        return $false
    }
}

function Get-AdminLogin {
    switch ($env:UserName) {
        "thgadre" { return "$env:UserName.adm" }
        "clegros"  { return "$env:UserName.adm" }
        default    { return "thgadre.adm" }
    }
}

function New-ADCredentialXml {
    param (
        [Parameter(Mandatory)][string]$path,
        [Parameter(Mandatory)][string]$login
    )

    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }

    $fichierXML     = "$login-credential.xml"
    $credentialPath = Join-Path $path $fichierXML
    $username       = "AFT-IFTIM\$login"

    add-msg -msg "" -foregroundColor White
    add-msg -msg "Fichier XML de credentials absent pour '$login'." -foregroundColor Yellow
    add-msg -msg "Saisir le mot de passe administrateur pour créer le fichier sécurisé." -foregroundColor Yellow

    $securePassword = Read-Host "Mot de passe pour '$login'" -AsSecureString
    $credential     = New-Object System.Management.Automation.PSCredential($username, $securePassword)

    try {
        $credential | Export-CliXml -Path $credentialPath
        add-msg -msg "Fichier XML créé : $fichierXML" -foregroundColor Green
    } catch {
        add-msg -msg "Erreur export XML : $($_.Exception.Message)" -foregroundColor Red
        return $null
    }

    return @{
        adCredential     = Import-CliXml -Path $credentialPath -ErrorAction Stop
        adCredentialPath = $credentialPath
    }
}
