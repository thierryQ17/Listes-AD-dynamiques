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

function Build-OUsCache {
    # SEULE fonction autorisée à interroger l'AD pour les OUs (lecture seule).
    # Construit l'arborescence régions/sites et l'enregistre dans le cache JSON.
    $regions = $global:parametresJson.ad.regions
    $result  = [System.Collections.Generic.List[object]]::new()
    $hadError = $false   # une requête de base a échoué → arbre PARTIEL, à ne pas persister

    if ($regions) {
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
                    $hadError = $true
                    add-msg -msg "Erreur lecture OU '$base' : $($_.Exception.Message)" -foregroundColor Red
                }
            }

            # Sites INDIVIDUELS (extraSites) : OU sites A##### hors conteneur de région
            # (ex. directement sous OU=administratif). Ajoutés tels quels (pas de scan AD :
            # le DN est la feuille elle-même). Sert aux entités autonomes mono-site.
            foreach ($extra in @($region.extraSites)) {
                if (-not $extra) { continue }
                $exDn = if ($extra -is [string]) { $extra } else { "$($extra.dn)" }
                if ([string]::IsNullOrWhiteSpace($exDn)) { continue }
                $exLbl  = if ($extra -is [string]) { '' } else { "$($extra.baseLabel)" }
                $exName = if ($exDn -match '^OU=([^,]+)') { $Matches[1] } else { $exDn }
                if ($exName -notmatch '^A\d{5}') { continue }
                $allSites.Add([PSCustomObject]@{
                    name      = $exName
                    dn        = $exDn
                    type      = 'site'
                    baseLabel = $exLbl
                })
            }

            $result.Add([PSCustomObject]@{
                name      = $region.label
                type      = 'region'
                multiBase = (@($region.bases).Count -gt 1)
                children  = @($allSites | Sort-Object baseLabel, name)
            })
        }
    }

    $siteCount = @($result | ForEach-Object { $_.children } | Where-Object { $_ }).Count

    # GARDE-FOU : ne JAMAIS persister un arbre PARTIEL/DÉGÉNÉRÉ. Sous la charge AD
    # concurrente d'un ↻ Cache, les requêtes OU peuvent échouer → 0 site (ou une base
    # manquante). L'écrire écraserait un bon cache par un arbre cassé (régions vides).
    # → on lève une erreur ; le cache OUs existant reste INTACT et sera réessayé.
    if ($hadError -or $siteCount -eq 0) {
        throw "Réponse AD incomplète pour les OUs ($siteCount site(s)$(if($hadError){' ; erreur de lecture'})). Cache OUs inchangé — réessayez."
    }

    $json = ConvertTo-Json -InputObject @($result) -Depth 6 -Compress
    $path = Get-OUsCachePath
    [System.IO.File]::WriteAllText($path, $json, [System.Text.Encoding]::UTF8)
    add-msg -msg "  [OUsCache] $siteCount site(s) mis en cache -> $path" -foregroundColor Green -quelType writeHost
    return $siteCount
}

function Get-OUTree {
    # Lit l'arborescence des OUs DEPUIS LE CACHE (jamais l'AD en direct).
    # Reconstruit le cache s'il est absent OU dégénéré (régions présentes mais AUCUN site),
    # sinon un cache `children:[]` figé provoquerait « warmup - 0 sites » sans jamais se réparer.
    $tree      = Get-OUsFromCache
    $siteCount = @($tree | ForEach-Object { $_.children } | Where-Object { $_ }).Count
    if (-not $tree -or @($tree).Count -eq 0 -or $siteCount -eq 0) {
        # Rebuild guardé : s'il échoue (réponse AD incomplète), on NE crashe PAS /api/tree,
        # on renvoie l'arbre courant (au pire dégénéré) ; il se réparera au prochain appel
        # quand l'AD répondra complètement.
        try {
            [void](Build-OUsCache)
            $tree = Get-OUsFromCache
        } catch {
            add-msg -msg "  [OUsCache] reconstruction refusée (arbre incomplet) : $($_.Exception.Message)" -foregroundColor Yellow -quelType writeHost
        }
    }
    return @($tree)
}

function Get-RegionFromDN {
    param([string]$DN)
    if (-not $DN) { return '' }
    foreach ($region in $global:parametresJson.ad.regions) {
        foreach ($base in $region.bases) {
            if ($DN -like "*,$base") { return $region.label }
        }
        # Entités autonomes : le compte est sous un site individuel (extraSites).
        foreach ($extra in @($region.extraSites)) {
            $exDn = if ($extra -is [string]) { $extra } else { "$($extra.dn)" }
            if ($exDn -and ($DN -like "*,$exDn" -or $DN -eq $exDn)) { return $region.label }
        }
    }
    return ''
}

function Test-DoIncluded {
    # $true si la DO doit être générée pour cette règle :
    #   - rule.dos renseigné  → la DO doit y figurer (sélection explicite de l'UI) ;
    #   - rule.dos absent     → défaut : incluse SAUF si la région est marquée defaultOff
    #                           (ex. MONCHY, Paris Villiers, Paris Editions Celse).
    param([string]$DoName, $Rule)
    if ([string]::IsNullOrWhiteSpace($DoName)) { return $false }
    $dos = @($Rule.dos | Where-Object { $_ })
    if ($dos.Count -gt 0) { return [bool]($dos -contains $DoName) }
    $reg = $global:parametresJson.ad.regions | Where-Object { "$($_.label)" -eq $DoName } | Select-Object -First 1
    return -not ($reg -and $reg.defaultOff -eq $true)
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

function Get-NormalizedLabel {
    # Normalise un libellé pour comparaison ville/bureau :
    # MAJUSCULES + suppression des accents/diacritiques + on ne garde que A-Z0-9.
    #   "Artigues-pres-Bordeaux" -> "ARTIGUESPRESBORDEAUX"
    #   "ARTIGUES PRES B"        -> "ARTIGUESPRESB"
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    $upper = $Value.ToUpperInvariant()
    $decomposed = $upper.Normalize([System.Text.NormalizationForm]::FormD)
    $sb = [System.Text.StringBuilder]::new()
    foreach ($ch in $decomposed.ToCharArray()) {
        if ([System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($ch) -ne [System.Globalization.UnicodeCategory]::NonSpacingMark) {
            [void]$sb.Append($ch)
        }
    }
    return ($sb.ToString() -replace '[^A-Z0-9]', '')
}

function Get-OfficeOuEcarts {
    # LECTURE CACHE UNIQUEMENT — aucun appel AD.
    # Parcourt _users_global.json et relève les écarts entre la Ville (déduite de l'OU
    # du DN) et le Bureau (champ office). Regroupe en arbre : DO (région, comme le menu)
    # -> Ville (OU) -> lignes { displayName | villeOU | office | status }.
    #
    # Règle de comparaison (labels normalisés, cf. Get-NormalizedLabel) :
    #   - office vide                                   -> 'manquant'
    #   - normOffice == normVille                       -> identique (ignoré)
    #   - l'un préfixe de l'autre (troncature du champ) -> identique (ignoré)
    #   - sinon                                         -> 'ecart'
    $users = @(Get-AllUsersFromCache)
    $rows  = [System.Collections.Generic.List[object]]::new()
    $scanned = 0

    foreach ($u in $users) {
        if (Test-UserExcluded -User $u) { continue }
        $dn = "$($u.dn)"
        if (-not $dn) { $dn = "$($u.ouDn)" }   # tolérance si un cache porte ouDn au lieu de dn
        $villeOU = Get-CentreFromDN -DN $dn
        if ([string]::IsNullOrWhiteSpace($villeOU)) { continue }  # OU sans ville exploitable
        $scanned++

        $office = "$($u.office)"
        $do     = Get-RegionFromDN -DN $dn
        if ([string]::IsNullOrWhiteSpace($do)) { $do = '(hors région)' }

        $normVille  = Get-NormalizedLabel $villeOU
        $normOffice = Get-NormalizedLabel $office

        $status = $null
        if ($normOffice -eq '') {
            $status = 'manquant'
        } elseif ($normOffice -eq $normVille) {
            continue
        } elseif ($normVille.StartsWith($normOffice) -or $normOffice.StartsWith($normVille)) {
            continue
        } else {
            $status = 'ecart'
        }

        # Objet « user » complet pour le panneau Détail (repris à l'identique de l'Explorateur).
        # Fallbacks pour un cache global pas encore reconstruit (champs ajoutés récemment) :
        #   - ouDn : dérivé du dn si absent
        #   - proxyAddresses : synthétisé depuis primarySmtpAddress si absent
        $ouDn = if ($u.ouDn) { "$($u.ouDn)" } else { ($dn -replace '^CN=[^,]+,', '') }
        $proxies = @($u.proxyAddresses | Where-Object { $_ })
        if ($proxies.Count -eq 0 -and $u.primarySmtpAddress) { $proxies = @("SMTP:$($u.primarySmtpAddress)") }
        $detail = [ordered]@{
            displayName         = "$($u.displayName)"
            samAccountName      = "$($u.samAccountName)"
            enabled             = if ($null -ne $u.enabled) { [bool]$u.enabled } else { $true }
            ouDn                = $ouDn
            office              = $office
            title               = "$($u.title)"
            department          = "$($u.department)"
            company             = "$($u.company)"
            employeeNumber      = "$($u.employeeNumber)"
            manager             = "$($u.manager)"
            userPrincipalName   = "$($u.userPrincipalName)"
            type                = "$($u.type)"
            extensionAttribute1 = "$($u.extensionAttribute1)"
            mail                = "$($u.mail)"
            postalCode          = "$($u.postalCode)"
            streetAddress       = "$($u.streetAddress)"
            description         = "$($u.description)"
            proxyAddresses      = [string[]]$proxies
        }

        $rows.Add([PSCustomObject]@{
            do          = $do
            villeOU     = $villeOU
            displayName = "$($u.displayName)"
            office      = $office
            status      = $status
            user        = $detail
        })
    }

    # Construction de l'arbre DO -> Ville -> lignes
    $tree = [System.Collections.Generic.List[object]]::new()
    foreach ($doGroup in ($rows | Group-Object do | Sort-Object Name)) {
        $sites = [System.Collections.Generic.List[object]]::new()
        foreach ($villeGroup in ($doGroup.Group | Group-Object villeOU | Sort-Object Name)) {
            $sites.Add([ordered]@{
                ville = $villeGroup.Name
                count = $villeGroup.Count
                rows  = @($villeGroup.Group | Sort-Object displayName | ForEach-Object {
                    [ordered]@{
                        displayName = $_.displayName
                        villeOU     = $_.villeOU
                        office      = $_.office
                        status      = $_.status
                        user        = $_.user
                    }
                })
            })
        }
        $tree.Add([ordered]@{
            do    = $doGroup.Name
            count = $doGroup.Count
            sites = @($sites)
        })
    }

    return [ordered]@{
        generatedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        scanned     = $scanned
        ecartCount  = $rows.Count
        manquantCount = @($rows | Where-Object { $_.status -eq 'manquant' }).Count
        tree        = @($tree)
    }
}

function Get-GlobalUsersCachePath {
    $scriptsDir = Split-Path ($global:path."r_settings" -replace '/', '\') -Parent
    $cacheDir   = Join-Path $scriptsDir "cache"
    if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
    return Join-Path $cacheDir "_users_global.json"
}

function Get-OUsCachePath {
    $scriptsDir = Split-Path ($global:path."r_settings" -replace '/', '\') -Parent
    $cacheDir   = Join-Path $scriptsDir "cache"
    if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
    return Join-Path $cacheDir "_ous_global.json"
}

function Get-OUsFromCache {
    $path = Get-OUsCachePath
    if (-not (Test-Path $path)) { return @() }
    try {
        return @(ConvertFrom-Json ([System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)))
    } catch { return @() }
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
                        'extensionAttribute1','extensionAttribute15','Description','ProxyAddresses',
                        'Company','EmployeeNumber','Manager','UserPrincipalName','Type',
                        'PostalCode','StreetAddress','Enabled')
        ErrorAction = 'Stop'
    }
    $users = @(Get-ADUser @adParams)
    add-msg -msg "  [UsersCache] $($users.Count) utilisateurs actifs chargés." -foregroundColor Cyan -quelType writeHost

    # Exclusion des comptes génériques (office = valeur configurée, ex. 'compte_generique').
    $excludeOffices = @($global:parametresJson.ad.excludeOfficeValues | Where-Object { $_ })
    if ($excludeOffices.Count) {
        $before = $users.Count
        $users  = @($users | Where-Object { "$($_.Office)" -notin $excludeOffices })
        add-msg -msg "  [UsersCache] comptes génériques exclus (office) : $($before - $users.Count)." -foregroundColor DarkGray -quelType writeHost
    }

    $records = @($users | ForEach-Object {
        $u   = $_
        $sam = "$($u.SamAccountName)"
        # primarySmtpAddress = proxyAddress 'SMTP:' en MAJUSCULES (adresse primaire).
        # proxyAddresses peuplé est la condition ABSOLUE de synchronisation Azure : sans lui,
        # le compte n'a pas de boîte cible (à exclure des listes de distribution).
        $primary = ''
        foreach ($p in @($u.ProxyAddresses)) { if ("$p" -cmatch '^SMTP:(.+)$') { $primary = $Matches[1]; break } }
        # IMPÉRATIF : ne conserver QUE les comptes avec primarySmtpAddress ET samAccountName.
        if ([string]::IsNullOrWhiteSpace($primary) -or [string]::IsNullOrWhiteSpace($sam)) { return }
        [ordered]@{
            dn                  = "$($u.DistinguishedName)"
            ouDn                = ($u.DistinguishedName -replace '^CN=[^,]+,', '')
            displayName         = if ($u.DisplayName)           { "$($u.DisplayName)"           } else { $sam }
            samAccountName      = $sam
            primarySmtpAddress  = $primary
            mail                = if ($u.Mail)                   { "$($u.Mail)"                   } else { '' }
            title               = if ($u.Title)                  { "$($u.Title)"                  } else { '' }
            department          = if ($u.Department)             { "$($u.Department)"             } else { '' }
            office              = if ($u.Office)                 { "$($u.Office)"                 } else { '' }
            extensionAttribute1 = if ($u.extensionAttribute1)   { "$($u.extensionAttribute1)"   } else { '' }
            extensionAttribute15 = if ($u.extensionAttribute15) { "$($u.extensionAttribute15)"  } else { '' }
            description         = if ($u.Description)           { "$($u.Description)"           } else { '' }
            company             = if ($u.Company)               { "$($u.Company)"               } else { '' }
            employeeNumber      = if ($u.EmployeeNumber)         { "$($u.EmployeeNumber)"         } else { '' }
            manager             = if ($u.Manager -match '^CN=([^,]+)') { $Matches[1] } elseif ($u.Manager) { "$($u.Manager)" } else { '' }
            userPrincipalName   = if ($u.UserPrincipalName)     { "$($u.UserPrincipalName)"     } else { '' }
            type                = if ($u.Type)                   { "$($u.Type)"                   } else { '' }
            postalCode          = if ($u.PostalCode)             { "$($u.PostalCode)"             } else { '' }
            streetAddress       = if ($u.StreetAddress)         { "$($u.StreetAddress)"         } else { '' }
            enabled             = [bool]$u.Enabled
            proxyAddresses      = [string[]]@($u.ProxyAddresses | Where-Object { $_ } | ForEach-Object { [string]$_ })
        }
    })

    # Diagnostic : distingue « proxyAddresses non récupéré » de « récupéré mais sans SMTP: primaire ».
    $withAnyProxy = @($users | Where-Object { @($_.ProxyAddresses).Count -gt 0 }).Count
    add-msg -msg "  [UsersCache] diag: $withAnyProxy/$($users.Count) ont des proxyAddresses ; $($records.Count) avec SMTP: primaire (+ samAccountName)." -foregroundColor DarkYellow -quelType writeHost
    add-msg -msg "  [UsersCache] $($records.Count) comptes avec BAL (primarySmtpAddress + samAccountName) conservés sur $($users.Count) actifs." -foregroundColor Cyan -quelType writeHost

    # GARDE-FOU (B) : réponse AD DÉGRADÉE intermittente observée sur ce tenant — l'AD ramène
    # des comptes mais AUCUN avec proxyAddresses (réponse rapide, incomplète) → 0 conservé.
    # Ne JAMAIS écraser le cache par du vide : on lève une erreur, le cache existant reste
    # intact, et le warmup/↻ Cache réessaiera. (Le cache global est la source de vérité
    # Règles/Groupes/Écarts.)
    if ($users.Count -gt 0 -and $withAnyProxy -eq 0) {
        throw "Réponse AD dégradée : $($users.Count) comptes ramenés mais 0 avec proxyAddresses. Cache global inchangé — réessayez (↻ Cache)."
    }

    # Exclusion par OU / motif de nom (ad.excludeOUs incl. REBUT, ad.excludeDisplayNamePatterns) :
    # retire les comptes sous une OU exclue (OU=REBUT, OU=Comptes generiques…) ou 'ricoh'.
    $beforeExcl = $records.Count
    $records = @($records | Where-Object { -not (Test-UserExcluded -User $_) })
    if ($records.Count -ne $beforeExcl) {
        add-msg -msg "  [UsersCache] exclus (OU/motif, ex. REBUT) : $($beforeExcl - $records.Count)." -foregroundColor DarkGray -quelType writeHost
    }

    $json = ConvertTo-Json -InputObject @($records) -Depth 4 -Compress
    $cachePath = Get-GlobalUsersCachePath
    [System.IO.File]::WriteAllText($cachePath, $json, [System.Text.Encoding]::UTF8)
    add-msg -msg "  [UsersCache] Fichier JSON sauvegardé ($([Math]::Round($json.Length/1kb)) KB) → $cachePath" -foregroundColor Green -quelType writeHost
    return $records.Count
}

function Get-OUSiteUsers {
    param([Parameter(Mandatory)][string]$SiteDN)

    # Recherche TOUS les comptes utilisateurs sous le site en Subtree, sans dépendre
    # d'une sous-OU nommée exactement « Utilisateurs » (fragile : nommage/imbrication).
    # Get-ADUser ne renvoie que des objets user → les OU Desktops/Laptops (ordinateurs)
    # sont naturellement exclues ; le filtre SMTP ci-dessous ne garde que les BAL.
    #
    # IMPÉRATIF (anti-régression Gennevilliers & co.) : sur erreur AD, on LAISSE REMONTER
    # l'exception (-ErrorAction Stop, pas de catch avalant). Ne JAMAIS retourner un tableau
    # vide en cas d'échec : un « 0 » silencieux se retrouvait mis en cache et masquait des
    # utilisateurs pourtant bien présents dans l'AD. Un vrai 0 (site sans BAL) reste possible,
    # mais UNIQUEMENT si la requête a réussi. Le warmup gère l'exception (log ERR, pas d'écriture).
    # Comptes ACTIVÉS uniquement (aligné sur Build-GlobalUsersCache) : les comptes
    # désactivés ne doivent pas figurer dans le cache.
    $users = Get-ADUser -Filter 'Enabled -eq $true' `
        -SearchBase $SiteDN -SearchScope Subtree `
        -Credential $global:AD_credential `
        -Properties DisplayName, Mail, Department, Description, Title, Enabled, ProxyAddresses, `
                    UserPrincipalName, Type, Company, EmployeeNumber, Manager, Office, `
                    extensionAttribute1, extensionAttribute15, PostalCode, StreetAddress `
        -ErrorAction Stop

    # Exclusion des comptes génériques (office = valeur configurée, ex. 'compte_generique').
    $excludeOffices = @($global:parametresJson.ad.excludeOfficeValues | Where-Object { $_ })
    if ($excludeOffices.Count) {
        $users = @($users | Where-Object { "$($_.Office)" -notin $excludeOffices })
    }

    return @(
        $users | ForEach-Object {
            $u   = $_
            $sam = "$($u.SamAccountName)"
            # Ne garder QUE les comptes avec BAL : primarySmtpAddress (proxyAddress 'SMTP:'
            # en majuscules) + samAccountName. Les autres n'ont pas d'intérêt dans le cache.
            $primary = ''
            foreach ($p in @($u.ProxyAddresses)) { if ("$p" -cmatch '^SMTP:(.+)$') { $primary = $Matches[1]; break } }
            if ([string]::IsNullOrWhiteSpace($primary) -or [string]::IsNullOrWhiteSpace($sam)) { return }
            [PSCustomObject]@{
                displayName       = if ($u.DisplayName) { $u.DisplayName } else { $u.SamAccountName }
                description       = $u.Description
                mail              = $u.Mail
                primarySmtpAddress = $primary
                title             = $u.Title
                department        = $u.Department
                samAccountName    = $sam
                enabled           = [bool]$u.Enabled
                proxyAddresses    = [string[]]@($u.ProxyAddresses | Where-Object { $_ } | ForEach-Object { [string]$_ })
                userPrincipalName = $u.UserPrincipalName
                type              = $u.Type
                company           = $u.Company
                employeeNumber    = $u.EmployeeNumber
                manager           = if ($u.Manager -match '^CN=([^,]+)') { $Matches[1] } else { $u.Manager }
                office            = $u.Office
                extensionAttribute1 = $u.extensionAttribute1
                extensionAttribute15 = $u.extensionAttribute15
                postalCode        = $u.PostalCode
                streetAddress     = $u.StreetAddress
                ouDn              = ($u.DistinguishedName -replace '^CN=[^,]+,', '')
            }
        } | Sort-Object displayName
    )
}
