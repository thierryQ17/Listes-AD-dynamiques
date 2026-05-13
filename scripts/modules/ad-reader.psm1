# Lecture seule — aucune commande d'écriture AD dans ce module

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
                        extensionAttribute1, dateDeFin, PostalCode, StreetAddress `
            -ErrorAction Stop

        return @(
            $users |
            Select-Object @{N='displayName';         E={ if ($_.DisplayName) { $_.DisplayName } else { $_.SamAccountName } }},
                          @{N='description';         E={ $_.Description }},
                          @{N='mail';                E={ $_.Mail }},
                          @{N='title';               E={ $_.Title }},
                          @{N='department';          E={ $_.Department }},
                          @{N='samAccountName';      E={ $_.SamAccountName }},
                          @{N='enabled';             E={ [bool]$_.Enabled }},
                          @{N='proxyAddresses';      E={
                              $list = [System.Collections.Generic.List[string]]::new()
                              foreach ($p in $_.ProxyAddresses) { if ($p) { $list.Add([string]$p) } }
                              $list
                          }},
                          @{N='userPrincipalName';   E={ $_.UserPrincipalName }},
                          @{N='type';                E={ $_.Type }},
                          @{N='company';             E={ $_.Company }},
                          @{N='employeeNumber';      E={ $_.EmployeeNumber }},
                          @{N='manager';             E={ if ($_.Manager -match '^CN=([^,]+)') { $Matches[1] } else { $_.Manager } }},
                          @{N='office';              E={ $_.Office }},
                          @{N='extensionAttribute1'; E={ $_.extensionAttribute1 }},
                          @{N='dateDeFin';           E={ $_.dateDeFin }},
                          @{N='postalCode';          E={ $_.PostalCode }},
                          @{N='streetAddress';       E={ $_.StreetAddress }} |
            Sort-Object displayName
        )
    } catch {
        add-msg -msg "Erreur lecture utilisateurs '$SiteDN' : $($_.Exception.Message)" -foregroundColor Yellow
        return @()
    }
}
