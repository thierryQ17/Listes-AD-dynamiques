# =============================================================================
#  exo.psm1 — Exchange Online, LECTURE SEULE (voir CLAUDE.md — regle absolue EXO).
#
#  - Connexion APP-ONLY par CERTIFICAT (non interactif) : AppId + Thumbprint + Organization
#    (config dans parametres.json -> exchangeOnline). Certificat dans Cert:\CurrentUser\My
#    du compte qui execute le serveur.
#  - RUNSPACE DEDIE : la session EXO est liee a UN runspace, isole des threads Pode
#    (le serveur tourne en -Threads 3). Le runspace est stocke dans l'etat Pode et
#    partage ; les acces sont SERIALISES par Lock-PodeObject (affinite de session).
#  - LECTURE SEULE STRICTE : -CommandName limite l'import aux cmdlets Get-* ci-dessous.
#    AUCUNE cmdlet d'ecriture (New-/Set-/Add-/Remove-...) n'est importee ni appelee.
# =============================================================================

# Cmdlets AUTORISEES (lecture seule) importees dans la session EXO.
$script:EXO_READONLY_CMDS = @('Get-Recipient', 'Get-ConnectionInformation')

function New-ExoRunspace {
    # Cree un runspace dedie et y ouvre la session EXO app-only (certificat), LECTURE SEULE.
    param(
        [Parameter(Mandatory)][string]$AppId,
        [Parameter(Mandatory)][string]$CertificateThumbprint,
        [Parameter(Mandatory)][string]$Organization
    )
    $rs = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
    $rs.Open()
    $ps = [System.Management.Automation.PowerShell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript({
        param($appId, $thumb, $org, $cmds)
        Import-Module ExchangeOnlineManagement -ErrorAction Stop
        # LECTURE SEULE : -CommandName limite l'import aux Get-* (aucune cmdlet d'ecriture disponible).
        Connect-ExchangeOnline -AppId $appId -CertificateThumbprint $thumb -Organization $org `
            -ShowBanner:$false -CommandName $cmds -ErrorAction Stop
    }).AddArgument($AppId).AddArgument($CertificateThumbprint).AddArgument($Organization).AddArgument($script:EXO_READONLY_CMDS)
    $null = $ps.Invoke()
    $hadErr = ($ps.Streams.Error.Count -gt 0)
    $firstErr = if ($hadErr) { "$($ps.Streams.Error[0])" } else { '' }
    $ps.Dispose()
    if ($hadErr) { try { $rs.Close() } catch {}; throw "Connexion EXO echouee : $firstErr" }
    return $rs
}

function Get-ExoRunspace {
    # Runspace EXO dedie, partage (etat Pode) et reutilise. Reconnecte si absent/ferme.
    # A appeler UNIQUEMENT sous verrou (voir Invoke-ExoScript).
    $cfg = $global:parametresJson.exchangeOnline
    if (-not $cfg -or -not $cfg.appId) { throw "Config 'exchangeOnline' absente de parametres.json." }

    $usePodeState = ($null -ne $PodeContext)   # etat/verrou Pode valides UNIQUEMENT dans un serveur Pode actif
    $existing = if ($usePodeState) { Get-PodeState -Name 'exo_runspace' } else { $script:ExoRs }
    if ($existing -and $existing.RunspaceStateInfo.State -eq 'Opened') { return $existing }

    $rs = New-ExoRunspace -AppId $cfg.appId -CertificateThumbprint $cfg.certificateThumbprint -Organization $cfg.organization
    if ($usePodeState) { $null = Set-PodeState -Name 'exo_runspace' -Value $rs } else { $script:ExoRs = $rs }
    return $rs
}

function Invoke-ExoScript {
    # Execute un scriptblock DANS le runspace EXO dedie, acces SERIALISE (Lock-PodeObject).
    # Le scriptblock ne doit contenir que des lectures (Get-*).
    param(
        [Parameter(Mandatory)][scriptblock]$Script,
        [object[]]$Arguments = @()
    )
    $script:__exoRes = @()
    $script:__exoErr = $null
    $work = {
        try {
            $rs = Get-ExoRunspace
            $ps = [System.Management.Automation.PowerShell]::Create()
            $ps.Runspace = $rs
            [void]$ps.AddScript($Script)
            foreach ($a in $Arguments) { [void]$ps.AddArgument($a) }
            $out = $ps.Invoke()
            $script:__exoErr = if ($ps.Streams.Error.Count) { "$($ps.Streams.Error[0])" } else { $null }
            $script:__exoRes = @($out)
            $ps.Dispose()
        } catch {
            $script:__exoErr = "$($_.Exception.Message)"
        }
    }
    if ($null -ne $PodeContext) {
        Lock-PodeObject -ScriptBlock $work   # serialise l'acces au runspace EXO dans le serveur Pode
    } else {
        & $work                              # hors Pode (test/CLI) : appel direct
    }
    if ($script:__exoErr) { throw $script:__exoErr }
    return $script:__exoRes
}

function Invoke-ExoRecipientPreview {
    # LECTURE SEULE : previsualise les destinataires d'un RecipientFilter (comme un DDG),
    # SANS rien creer. Retourne [{ name; title; sam }].
    param(
        [Parameter(Mandatory)][string]$Filter,
        [string]$OrganizationalUnit
    )
    Invoke-ExoScript -Script {
        param($f, $ou)
        $p = @{ RecipientPreviewFilter = $f; ResultSize = 'Unlimited' }
        if ($ou) { $p['OrganizationalUnit'] = $ou }
        Get-Recipient @p | ForEach-Object {
            [ordered]@{
                name = "$($_.DisplayName)"
                title = "$($_.Title)"
                sam = "$($_.SamAccountName)"
                office = "$($_.Office)"
            }
        }
    } -Arguments @($Filter, $OrganizationalUnit)
}

function ConvertTo-OpathCondition {
    # Une condition de regle -> clause OPATH (ou $null si champ non mappable : description/ou).
    param($Cond)
    $map = @{ title = 'Title'; department = 'Department'; office = 'Office'; extensionAttribute1 = 'CustomAttribute1'; extensionAttribute15 = 'CustomAttribute15' }
    $prop = $map["$($Cond.field)"]
    if (-not $prop) { return $null }
    $v = "$($Cond.value)".Replace("'", "''")
    switch ("$($Cond.op)") {
        'eq'       { "($prop -eq '$v')" }
        'ne'       { "($prop -ne '$v')" }
        'like'     { "($prop -like '*$v*')" }
        'notlike'  { "($prop -notlike '*$v*')" }
        'notempty' { "($prop -ne `$null)" }
        'empty'    { "($prop -eq `$null)" }
        default    { "($prop -eq '$v')" }
    }
}

function Build-OpathBaseFilter {
    # Filtre OPATH de BASE d'une regle (RecipientTypeDetails=UserMailbox + conditions mappables),
    # SANS le scope Office/OU (partition faite ensuite par Office). Miroir de buildOpathFilter (regles.js).
    param($Rule, $AllRules)
    $noVal = @('empty', 'notempty')
    $core  = $null
    if ($Rule.invertOf) {
        $src = @($AllRules | Where-Object { $_.id -eq $Rule.invertOf } | Select-Object -First 1)
        $inc = @(@($src.conditions.include) | Where-Object { $_.value -or ($_.op -in $noVal) })
        $parts = @($inc | ForEach-Object { ConvertTo-OpathCondition $_ } | Where-Object { $_ })
        if ($parts.Count) { $core = '-not (' + (($parts -join ' -or ')) + ')' }
    } else {
        $inc = @(@($Rule.conditions.include) | Where-Object { $_.value -or ($_.op -in $noVal) })
        $exc = @(@($Rule.conditions.exclude) | Where-Object { $_.value -or ($_.op -in $noVal) })
        $pos = @($inc | Where-Object { $_.op -in @('eq','like') } | ForEach-Object { ConvertTo-OpathCondition $_ } | Where-Object { $_ })
        $neg = @($inc | Where-Object { $_.op -notin @('eq','like') } | ForEach-Object { ConvertTo-OpathCondition $_ } | Where-Object { $_ })
        $ex  = @($exc | ForEach-Object { $c = ConvertTo-OpathCondition $_; if ($c) { "-not $c" } } | Where-Object { $_ })
        $posPart = if ($pos.Count -eq 0) { $null } elseif ($pos.Count -eq 1) { $pos[0] } else { '(' + ($pos -join ' -or ') + ')' }
        $andParts = @(@($posPart) + $neg + $ex | Where-Object { $_ })
        if ($andParts.Count) { $core = if ($andParts.Count -eq 1) { $andParts[0] } else { $andParts -join ' -and ' } }
    }
    $base = "(RecipientTypeDetails -eq 'UserMailbox')"
    if ($core) { return "$base -and ($core)" } else { return $base }
}

function Test-ExoConnection {
    # Ping lecture seule : renvoie l'etat de connexion EXO.
    try {
        $st = Invoke-ExoScript -Script {
            $c = Get-ConnectionInformation | Select-Object -First 1
            if ($c) { "$($c.State)" } else { 'None' }
        }
        $state = "$(@($st)[0])"
        return @{ connected = ($state -match 'Connected'); state = $state }
    } catch {
        return @{ connected = $false; error = "$($_.Exception.Message)" }
    }
}
