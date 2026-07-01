# Lecture seule — aucune commande d'écriture AD dans ce module

function Get-ADParams {
    param([hashtable]$Extra = @{})
    $p = @{ Credential = $global:AD_credential }
    $s = $global:parametresJson.ad.server
    if ($s) { $p['Server'] = $s }
    foreach ($k in $Extra.Keys) { $p[$k] = $Extra[$k] }
    return $p
}

function Get-I2NGroups {
    $searchBase = $global:parametresJson.ad.groupsOU

    try {
        Get-ADGroup -Filter * `
                    -SearchBase $searchBase `
                    -Credential $global:AD_credential `
                    -Properties DisplayName, Description, GroupScope `
                    -ErrorAction Stop |
        Select-Object @{N='name';        E={ $_.Name }},
                      @{N='displayName'; E={ if ($_.DisplayName) { $_.DisplayName } else { $_.Name } }},
                      @{N='description'; E={ $_.Description }},
                      @{N='groupScope';  E={ $_.GroupScope.ToString() }},
                      @{N='dn';          E={ $_.DistinguishedName }},
                      @{N='type';        E={ 'group' }} |
        Sort-Object displayName
    } catch {
        add-msg -msg "Erreur lecture groupes I2N ($searchBase) : $($_.Exception.Message)" -foregroundColor Red
        return @()
    }
}

function Get-I2NGroupMembers {
    param(
        [Parameter(Mandatory)][string]$GroupDN
    )

    try {
        $members = Get-ADGroupMember -Identity $GroupDN `
                                     -Credential $global:AD_credential `
                                     -ErrorAction Stop

        $results = foreach ($m in $members) {
            if ($m.objectClass -eq 'user') {
                $u = Get-ADUser -Identity $m.distinguishedName `
                                -Credential $global:AD_credential `
                                -Properties DisplayName, Mail, Department, Title `
                                -ErrorAction SilentlyContinue
                if ($u) {
                    [PSCustomObject]@{
                        samAccountName = $u.SamAccountName
                        displayName    = if ($u.DisplayName) { $u.DisplayName } else { $u.SamAccountName }
                        mail           = $u.Mail
                        department     = $u.Department
                        title          = $u.Title
                        type           = 'user'
                        dn             = $u.DistinguishedName
                    }
                }
            } elseif ($m.objectClass -eq 'group') {
                $g = Get-ADGroup -Identity $m.distinguishedName `
                                 -Credential $global:AD_credential `
                                 -Properties DisplayName `
                                 -ErrorAction SilentlyContinue
                if ($g) {
                    [PSCustomObject]@{
                        samAccountName = $g.SamAccountName
                        displayName    = if ($g.DisplayName) { $g.DisplayName } else { $g.Name }
                        mail           = ''
                        department     = 'Groupe AD'
                        title          = ''
                        type           = 'group'
                        dn             = $g.DistinguishedName
                    }
                }
            }
        }
        return @($results)
    } catch {
        add-msg -msg "Erreur lecture membres '$GroupDN' : $($_.Exception.Message)" -foregroundColor Red
        return @()
    }
}

function Search-ADObjects {
    param(
        [string]$Query = '',
        [ValidateSet('user', 'group', 'both')]
        [string]$Type = 'both',
        [int]$MaxResults = 50
    )

    $searchBase = $global:parametresJson.ad.searchBase
    $results    = [System.Collections.Generic.List[object]]::new()

    if ($Type -in @('user', 'both')) {
        $filter = if ($Query) {
            "Enabled -eq `$true -and (Name -like '*$Query*' -or DisplayName -like '*$Query*' -or SamAccountName -like '*$Query*')"
        } else {
            "Enabled -eq `$true"
        }
        try {
            $users = Get-ADUser -Filter $filter `
                                -SearchBase $searchBase `
                                -Credential $global:AD_credential `
                                -Properties DisplayName, Mail, Department, Title `
                                -ResultSetSize $MaxResults `
                                -ErrorAction Stop
            foreach ($u in $users) {
                $results.Add([PSCustomObject]@{
                    samAccountName = $u.SamAccountName
                    displayName    = if ($u.DisplayName) { $u.DisplayName } else { $u.SamAccountName }
                    mail           = $u.Mail
                    department     = $u.Department
                    title          = $u.Title
                    type           = 'user'
                    dn             = $u.DistinguishedName
                })
            }
        } catch {
            add-msg -msg "Erreur recherche utilisateurs : $($_.Exception.Message)" -foregroundColor Yellow
        }
    }

    if ($Type -in @('group', 'both')) {
        $filter = if ($Query) { "Name -like '*$Query*' -or DisplayName -like '*$Query*'" } else { '*' }
        try {
            $groups = Get-ADGroup -Filter $filter `
                                  -SearchBase $searchBase `
                                  -Credential $global:AD_credential `
                                  -Properties DisplayName, Description `
                                  -ResultSetSize $MaxResults `
                                  -ErrorAction Stop
            foreach ($g in $groups) {
                $results.Add([PSCustomObject]@{
                    samAccountName = $g.SamAccountName
                    displayName    = if ($g.DisplayName) { $g.DisplayName } else { $g.Name }
                    mail           = ''
                    department     = 'Groupe AD'
                    title          = $g.Description
                    type           = 'group'
                    dn             = $g.DistinguishedName
                })
            }
        } catch {
            add-msg -msg "Erreur recherche groupes : $($_.Exception.Message)" -foregroundColor Yellow
        }
    }

    return @($results | Sort-Object displayName | Select-Object -First $MaxResults)
}

function Get-OUTree {
    $regions = $global:parametresJson.ad.regions
    if (-not $regions) { return @() }

    $result = [System.Collections.Generic.List[object]]::new()

    foreach ($region in $regions) {
        $allSites = [System.Collections.Generic.List[object]]::new()

        foreach ($base in $region.bases) {
            $baseLabel = if ($base -match '^OU=([^,]+)') { $Matches[1] } else { $base }
            try {
                $sites = Get-ADOrganizationalUnit -Filter * `
                    -SearchBase $base -SearchScope OneLevel `
                    -Credential $global:AD_credential `
                    -Properties Name -ErrorAction Stop

                foreach ($site in $sites) {
                    if ($site.Name -notmatch '^A\d{5}') { continue }
                    $allSites.Add([PSCustomObject]@{
                        name      = $site.Name
                        dn        = $site.DistinguishedName
                        type      = 'site'
                        baseLabel = $baseLabel
                    })
                }
            } catch {
                add-msg -msg "Erreur lecture OU '$base' : $($_.Exception.Message)" -foregroundColor Red
            }
        }

        $result.Add([PSCustomObject]@{
            name      = $region.label
            type      = 'region'
            multiBase = ($region.bases.Count -gt 1)
            children  = @($allSites | Sort-Object baseLabel, name)
        })
    }

    return @($result)
}

function Get-RegionFromDN {
    param([string]$DN)
    if (-not $DN) { return '' }
    foreach ($region in $global:parametresJson.ad.regions) {
        foreach ($base in $region.bases) {
            if ($DN -like "*,$base") { return $region.label }
        }
    }
    return ''
}

function Test-UserExcluded {
    # Retourne $true si l'utilisateur doit être exclu de toutes les listes :
    #   - son DN traverse une OU listée dans ad.excludeOUs (ex. comptes génériques)
    #   - ou son displayName correspond à un motif de ad.excludeDisplayNamePatterns
    param([object]$User)

    $excludeOUs = @($global:parametresJson.ad.excludeOUs | Where-Object { $_ })
    if ($excludeOUs.Count -gt 0) {
        $comps = @(Get-OUComponents -DN "$($User.dn)")
        foreach ($ou in $excludeOUs) {
            if ($comps -contains $ou) { return $true }
        }
    }

    $patterns = @($global:parametresJson.ad.excludeDisplayNamePatterns | Where-Object { $_ })
    if ($patterns.Count -gt 0) {
        $name = "$($User.displayName)"
        foreach ($p in $patterns) {
            if ($name -match [regex]::Escape($p)) { return $true }
        }
    }

    return $false
}

function Get-CentreFromDN {
    # Extrait le nom du centre depuis l'OU du DN (ex: "OU=A22100 - Narbonne" → "Narbonne")
    param([string]$DN)
    if (-not $DN) { return '' }
    foreach ($part in ($DN -split ',')) {
        if ($part -match '^OU=(A\d{5})\s*-\s*(.+)$') { return $Matches[2].Trim() }
        if ($part -match '^OU=(A\d{5})$')             { return $Matches[1] }
    }
    return ''
}

function Get-OUComponents {
    # Retourne la liste des noms d'OU traversés par un DN
    # (ex: "CN=X,OU=Utilisateurs,OU=A22100 - Narbonne,OU=SUD,..." → Utilisateurs, A22100 - Narbonne, SUD)
    param([string]$DN)
    if (-not $DN) { return @() }
    $out = [System.Collections.Generic.List[string]]::new()
    foreach ($part in ($DN -split ',')) {
        if ($part -match '^\s*OU=(.+)$') { [void]$out.Add($Matches[1].Trim()) }
    }
    return @($out)
}

function Get-GlobalUsersCachePath {
    $scriptsDir = Split-Path ($global:path."r_settings" -replace '/', '\') -Parent
    $cacheDir   = Join-Path $scriptsDir "cache"
    if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
    return Join-Path $cacheDir "_users_global.json"
}

function Get-AllUsersFromCache {
    $path = Get-GlobalUsersCachePath
    if (-not (Test-Path $path)) { return @() }
    try {
        return @(ConvertFrom-Json ([System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)))
    } catch { return @() }
}

function Build-GlobalUsersCache {
    $searchBase = $global:parametresJson.ad.searchBase
    add-msg -msg "  [UsersCache] Chargement de tous les utilisateurs AD (searchBase: $searchBase)…" -foregroundColor Cyan -quelType writeHost
    $adParams = @{
        Filter      = { Enabled -eq $true }
        SearchBase  = $searchBase
        Credential  = $global:AD_credential
        Properties  = @('SamAccountName','Mail','DisplayName','Title','Department','Office',
                        'extensionAttribute1','Description','UserPrincipalName',
                        'ProxyAddresses','Manager','Company','EmployeeNumber','PostalCode','StreetAddress')
        ErrorAction = 'Stop'
    }
    $users = @(Get-ADUser @adParams)
    add-msg -msg "  [UsersCache] $($users.Count) utilisateurs actifs chargés." -foregroundColor Cyan -quelType writeHost

    $records = @($users | ForEach-Object {
        $u = $_
        [ordered]@{
            dn                  = "$($u.DistinguishedName)"
            displayName         = if ($u.DisplayName)           { "$($u.DisplayName)"           } else { "$($u.SamAccountName)" }
            samAccountName      = "$($u.SamAccountName)"
            mail                = if ($u.Mail)                   { "$($u.Mail)"                   } else { '' }
            title               = if ($u.Title)                  { "$($u.Title)"                  } else { '' }
            department          = if ($u.Department)             { "$($u.Department)"             } else { '' }
            office              = if ($u.Office)                 { "$($u.Office)"                 } else { '' }
            extensionAttribute1 = if ($u.extensionAttribute1)   { "$($u.extensionAttribute1)"   } else { '' }
            description         = if ($u.Description)           { "$($u.Description)"           } else { '' }
            userPrincipalName   = if ($u.UserPrincipalName)     { "$($u.UserPrincipalName)"     } else { '' }
            proxyAddresses      = [string[]]@($u.ProxyAddresses | Where-Object { $_ } | ForEach-Object { "$_" })
            manager             = if ($u.Manager -match '^CN=([^,]+)') { $Matches[1] } else { if ($u.Manager) { "$($u.Manager)" } else { '' } }
            company             = if ($u.Company)               { "$($u.Company)"               } else { '' }
            employeeNumber      = if ($u.EmployeeNumber)        { "$($u.EmployeeNumber)"        } else { '' }
            postalCode          = if ($u.PostalCode)            { "$($u.PostalCode)"            } else { '' }
            streetAddress       = if ($u.StreetAddress)         { "$($u.StreetAddress)"         } else { '' }
            enabled             = $true
            builtAt             = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')
        }
    })

    $json = ConvertTo-Json -InputObject @($records) -Depth 3 -Compress
    $cachePath = Get-GlobalUsersCachePath
    [System.IO.File]::WriteAllText($cachePath, $json, [System.Text.Encoding]::UTF8)
    add-msg -msg "  [UsersCache] Fichier JSON sauvegardé ($([Math]::Round($json.Length/1kb)) KB) → $cachePath" -foregroundColor Green -quelType writeHost
    return $users.Count
}

function Get-OUSiteUsers {
    param([Parameter(Mandatory)][string]$SiteDN)

    try {
        $usersOU = Get-ADOrganizationalUnit -Filter "Name -eq 'Utilisateurs'" `
            -SearchBase $SiteDN -SearchScope OneLevel `
            -Credential $global:AD_credential -ErrorAction SilentlyContinue

        # Si pas de sous-OU "Utilisateurs", chercher directement dans le site
        $searchBase = if ($usersOU) { $usersOU.DistinguishedName } else { $SiteDN }

        $users = Get-ADUser -Filter * `
            -SearchBase $searchBase -SearchScope OneLevel `
            -Credential $global:AD_credential `
            -Properties DisplayName, Mail, Department, Description, Title, Enabled, ProxyAddresses, `
                        UserPrincipalName, Type, Company, EmployeeNumber, Manager, Office, `
                        extensionAttribute1, PostalCode, StreetAddress `
            -ErrorAction Stop

        return @(
            $users | ForEach-Object {
                $u = $_
                [PSCustomObject]@{
                    displayName       = if ($u.DisplayName) { $u.DisplayName } else { $u.SamAccountName }
                    description       = $u.Description
                    mail              = $u.Mail
                    title             = $u.Title
                    department        = $u.Department
                    samAccountName    = $u.SamAccountName
                    enabled           = [bool]$u.Enabled
                    proxyAddresses    = [string[]]@($u.ProxyAddresses | Where-Object { $_ } | ForEach-Object { [string]$_ })
                    userPrincipalName = $u.UserPrincipalName
                    type              = $u.Type
                    company           = $u.Company
                    employeeNumber    = $u.EmployeeNumber
                    manager           = if ($u.Manager -match '^CN=([^,]+)') { $Matches[1] } else { $u.Manager }
                    office            = $u.Office
                    extensionAttribute1 = $u.extensionAttribute1
                    postalCode        = $u.PostalCode
                    streetAddress     = $u.StreetAddress
                    ouDn              = ($u.DistinguishedName -replace '^CN=[^,]+,', '')
                }
            } | Sort-Object displayName
        )
    } catch {
        add-msg -msg "Erreur lecture utilisateurs '$SiteDN' : $($_.Exception.Message)" -foregroundColor Yellow
        return @()
    }
}
