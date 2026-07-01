# Lecture AD seule — génère des fichiers CSV sans aucune modification de l'AD

function Invoke-RuleGeneration {
    param([Parameter(Mandatory)][PSCustomObject]$Rule)

    if (-not $Rule.invertOf -and (-not $Rule.conditions -or -not $Rule.conditions.include -or $Rule.conditions.include.Count -eq 0)) {
        throw "La règle n'a pas de conditions 'include'."
    }

    $allUsers = @(Get-AllUsersFromCache)
    if ($allUsers.Count -eq 0) {
        throw "Aucun utilisateur en cache — ouvrez l'Explorateur AD pour peupler le cache (bouton ↻)."
    }
    add-msg -msg "  [CSV] $($allUsers.Count) utilisateurs lus depuis le cache JSON." -foregroundColor DarkGray -quelType writeHost

    if ($Rule.invertOf) {
        $rPath      = Join-Path ($global:path."r_settings" -replace '/', '\') "regles.json"
        $srcRule    = @(ConvertFrom-Json ([System.IO.File]::ReadAllText($rPath, [System.Text.Encoding]::UTF8))) | Where-Object { $_.id -eq $Rule.invertOf } | Select-Object -First 1
        if (-not $srcRule) { throw "Règle source '$($Rule.invertOf)' introuvable pour le calcul inverse." }
        $srcIds     = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        @($allUsers | Where-Object { Test-UserMatchesRule -User $_ -Conditions $srcRule.conditions }) | ForEach-Object { [void]$srcIds.Add($_.samAccountName) }
        $filtered   = @($allUsers | Where-Object { -not $srcIds.Contains($_.samAccountName) })
        add-msg -msg "  [CSV] Inverse de '$($srcRule.label)' : $($filtered.Count) utilisateurs (sur $($allUsers.Count))." -foregroundColor Cyan -quelType writeHost
    } else {
        $filtered = @($allUsers | Where-Object { Test-UserMatchesRule -User $_ -Conditions $Rule.conditions })
    }
    $filtered = @($filtered | Where-Object { -not (Test-UserExcluded $_) })
    add-msg -msg "  [CSV] $($filtered.Count) utilisateurs correspondent aux conditions." -foregroundColor Cyan -quelType writeHost

    $outDir = Get-RunOutputDir -Label $Rule.label
    if ($Rule.niveau -eq 3) {
        if ($Rule.monoNiveau) {
            $files = Write-CsvNiveau3Mono -Users $filtered -Label $Rule.label -OutDir $outDir
        } else {
            $files = Write-CsvNiveau3 -Users $filtered -Label $Rule.label -OutDir $outDir
        }
    } elseif ($Rule.niveau -eq 2) {
        $files = Write-CsvNiveau2 -Users $filtered -Label $Rule.label -OutDir $outDir
    } else {
        $files = Write-CsvNiveau1 -Users $filtered -Label $Rule.label -OutDir $outDir
    }

    add-msg -msg "  [CSV] Terminé : $(@($files).Count) fichiers dans '$outDir'." -foregroundColor Green -quelType writeHost

    Invoke-GroupProvisioning -Files @($files) -OutDir $outDir -Rule $Rule

    # Calcul des groupes (même logique que preview-groups) pour le contrôle des adresses mail
    $lbl        = if ($Rule.prefix) { Clean-ForFileName $Rule.prefix } else { Clean-ForFileName $Rule.label }
    $mailDomain = $global:parametresJson.ad.mailDomain
    $gpGroups   = [System.Collections.Generic.List[hashtable]]::new()

    if ($Rule.niveau -eq 3) {
        $byDO = $filtered | Group-Object { Get-RegionFromDN $_.dn } | Where-Object { $_.Name -and $_.Name -ne 'MONCHY' }
        foreach ($doGrp in $byDO) {
            $doName  = if ($doGrp.Name) { $doGrp.Name } else { 'SANS-DO' }
            $doClean = Clean-ForFileName $doName
            $doBase  = "$lbl-$doClean"
            foreach ($cGrp in ($doGrp.Group | Group-Object { Get-CentreFromDN $_.dn })) {
                $cName  = if ($cGrp.Name) { $cGrp.Name } else { 'SANS-CENTRE' }
                $cBase  = "$lbl-$doClean-$(Clean-ForFileName $cName)"
                $gpGroups.Add(@{ name = $cBase; mail = "$($cBase.ToLower())@$mailDomain"; type = 'centre'; count = $cGrp.Group.Count })
            }
            $gpGroups.Add(@{ name = $doBase; mail = "$($doBase.ToLower())@$mailDomain"; type = 'do'; count = $doGrp.Group.Count })
        }
        $gpGroups.Add(@{ name = $lbl; mail = "$($lbl.ToLower())@$mailDomain"; type = 'global'; count = $filtered.Count })
    } elseif ($Rule.niveau -eq 2) {
        $byDO = $filtered | Group-Object { Get-RegionFromDN $_.dn } | Where-Object { $_.Name -and $_.Name -ne 'MONCHY' }
        foreach ($doGrp in $byDO) {
            $doName  = if ($doGrp.Name) { $doGrp.Name } else { 'SANS-DO' }
            $doBase  = "$lbl-$(Clean-ForFileName $doName)"
            $gpGroups.Add(@{ name = $doBase; mail = "$($doBase.ToLower())@$mailDomain"; type = 'do'; count = $doGrp.Group.Count })
        }
        $gpGroups.Add(@{ name = $lbl; mail = "$($lbl.ToLower())@$mailDomain"; type = 'global'; count = $filtered.Count })
    } else {
        $gpGroups.Add(@{ name = $lbl; mail = "$($lbl.ToLower())@$mailDomain"; type = 'global'; count = $filtered.Count })
    }

    return [PSCustomObject]@{
        ok         = $true
        outDir     = $outDir
        files      = @($files)
        total      = $filtered.Count
        groups     = @($gpGroups)
        mailDomain = $mailDomain
    }
}

# ── Filtrage ────────────────────────────────────────────────────────────

function Test-UserMatchesRule {
    param($User, $Conditions)

    $inc = @($Conditions.include)
    if ($inc.Count -gt 0) {
        $positive = @($inc | Where-Object { $_.op -in @('eq','like') })
        $negative = @($inc | Where-Object { $_.op -in @('ne','notlike','empty','notempty') })
        # Conditions positives : OR (au moins une doit correspondre)
        $matchPos = ($positive.Count -eq 0) -or ($null -ne ($positive | Where-Object { Test-Condition -User $User -Cond $_ } | Select-Object -First 1))
        # Conditions négatives : AND (toutes doivent correspondre)
        $matchNeg = ($negative.Count -eq 0) -or ($null -eq ($negative | Where-Object { -not (Test-Condition -User $User -Cond $_) } | Select-Object -First 1))
        if (-not ($matchPos -and $matchNeg)) { return $false }
    }

    $exc = @($Conditions.exclude)
    if ($exc.Count -gt 0) {
        $matchExc = $null -ne ($exc | Where-Object { Test-Condition -User $User -Cond $_ } | Select-Object -First 1)
        if ($matchExc) { return $false }
    }

    return $true
}

function Test-Condition {
    param($User, $Cond)

    # Champ "OU" : match sur les noms d'OU traversés par le DN de l'utilisateur
    if ($Cond.field -eq 'ou') {
        $components = @(Get-OUComponents -DN "$($User.dn)")
        switch ($Cond.op) {
            'eq'      { return [bool]@($components | Where-Object { $_ -eq   $Cond.value }).Count }
            'ne'      { return -not [bool]@($components | Where-Object { $_ -eq   $Cond.value }).Count }
            'like'    { return [bool]@($components | Where-Object { $_ -like "*$($Cond.value)*" }).Count }
            'notlike' { return -not [bool]@($components | Where-Object { $_ -like "*$($Cond.value)*" }).Count }
            'empty'    { return -not [bool]@($components).Count }
            'notempty' { return [bool]@($components).Count }
            default   { return $false }
        }
    }

    $raw = switch ($Cond.field) {
        'title'               { $User.Title }
        'department'          { $User.Department }
        'office'              { $User.Office }
        'extensionAttribute1' { $User.extensionAttribute1 }
        'description'         { $User.Description }
        default               { '' }
    }
    $val = if ($null -ne $raw) { [string]$raw } else { '' }
    switch ($Cond.op) {
        'eq'      { return $val -eq      $Cond.value }
        'ne'      { return $val -ne      $Cond.value }
        'like'    { return $val -like    "*$($Cond.value)*" }
        'notlike' { return $val -notlike "*$($Cond.value)*" }
        'empty'    { return [string]::IsNullOrWhiteSpace($val) }
        'notempty' { return -not [string]::IsNullOrWhiteSpace($val) }
        default   { return $false }
    }
}

# ── Conversion en contenu CSV (thread principal — objets AD natifs) ──────────

function Get-CsvContent {
    param($Users)
    # Accès aux propriétés AD dans le thread principal (non sérialisées)
    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.AppendLine('"nom";"samaccountname";"mail";"fonction"')
    foreach ($u in @($Users)) {
        $n = [string]$u.DisplayName
        $s = [string]$u.SamAccountName
        $m = [string]$u.Mail
        $f = [string]$u.Title
        [void]$sb.AppendLine("`"$n`";`"$s`";`"$m`";`"$f`"")
    }
    return $sb.ToString()
}

# ── Écriture parallèle (reçoit du texte pré-calculé, pas d'objets AD) ────────

function Invoke-WriteJobs {
    param([System.Collections.Generic.List[hashtable]]$Jobs)
    $Jobs | ForEach-Object -Parallel {
        [System.IO.File]::WriteAllText($_.path, $_.content, [System.Text.Encoding]::UTF8)
    } -ThrottleLimit 8
}

function Write-CsvNiveau3 {
    param($Users, [string]$Label, [string]$OutDir)

    $lbl       = Clean-ForFileName $Label
    $userArray = @($Users)
    $jobs      = [System.Collections.Generic.List[hashtable]]::new()

    add-msg -msg "  [CSV] Génération niveau 3 (centre + DO + global) — '$Label'" -foregroundColor DarkCyan -quelType writeHost
    $byDO = $userArray | Group-Object { Get-RegionFromDN $_.dn } | Where-Object { $_.Name -and $_.Name -ne 'MONCHY' }
    foreach ($doGrp in $byDO) {
        $doName  = if ($doGrp.Name) { $doGrp.Name } else { 'SANS-DO' }
        $doClean = Clean-ForFileName $doName
        foreach ($cGrp in ($doGrp.Group | Group-Object { Get-CentreFromDN $_.dn })) {
            $cName  = if ($cGrp.Name) { $cGrp.Name } else { 'SANS-CENTRE' }
            $cClean = Clean-ForFileName $cName
            $fname  = "$lbl-$doClean-$cClean.csv"
            add-msg -msg "  [CSV]   + '$fname' ($($cGrp.Group.Count) utilisateur(s)) [centre]" -foregroundColor DarkGray -quelType writeHost
            $jobs.Add(@{ path = Join-Path $OutDir $fname; fname = $fname; content = Get-CsvContent $cGrp.Group })
        }
        $fname = "$lbl-$doClean.csv"
        add-msg -msg "  [CSV]   + '$fname' ($($doGrp.Group.Count) utilisateur(s)) [DO]" -foregroundColor DarkGray -quelType writeHost
        $jobs.Add(@{ path = Join-Path $OutDir $fname; fname = $fname; content = Get-CsvContent $doGrp.Group })
    }
    $fname = "$lbl.csv"
    add-msg -msg "  [CSV]   + '$fname' ($($userArray.Count) utilisateur(s)) [global]" -foregroundColor DarkGray -quelType writeHost
    $jobs.Add(@{ path = Join-Path $OutDir $fname; fname = $fname; content = Get-CsvContent $userArray })

    add-msg -msg "  [CSV] Écriture de $($jobs.Count) fichier(s) en parallèle…" -foregroundColor DarkCyan -quelType writeHost
    Invoke-WriteJobs -Jobs $jobs
    return @($jobs | ForEach-Object { $_.fname })
}

function Write-CsvNiveau3Mono {
    param($Users, [string]$Label, [string]$OutDir)

    $lbl       = Clean-ForFileName $Label
    $userArray = @($Users)
    $jobs      = [System.Collections.Generic.List[hashtable]]::new()

    add-msg -msg "  [CSV] Génération niveau 3 mono (centre uniquement) — '$Label'" -foregroundColor DarkCyan -quelType writeHost
    $byDO = $userArray | Group-Object { Get-RegionFromDN $_.dn } | Where-Object { $_.Name -and $_.Name -ne 'MONCHY' }
    foreach ($doGrp in $byDO) {
        $doName  = if ($doGrp.Name) { $doGrp.Name } else { 'SANS-DO' }
        $doClean = Clean-ForFileName $doName
        foreach ($cGrp in ($doGrp.Group | Group-Object { Get-CentreFromDN $_.dn })) {
            $cName  = if ($cGrp.Name) { $cGrp.Name } else { 'SANS-CENTRE' }
            $cClean = Clean-ForFileName $cName
            $fname  = "$lbl-$doClean-$cClean.csv"
            add-msg -msg "  [CSV]   + '$fname' ($($cGrp.Group.Count) utilisateur(s)) [centre]" -foregroundColor DarkGray -quelType writeHost
            $jobs.Add(@{ path = Join-Path $OutDir $fname; fname = $fname; content = Get-CsvContent $cGrp.Group })
        }
    }

    add-msg -msg "  [CSV] Écriture de $($jobs.Count) fichier(s) en parallèle…" -foregroundColor DarkCyan -quelType writeHost
    Invoke-WriteJobs -Jobs $jobs
    return @($jobs | ForEach-Object { $_.fname })
}

function Write-CsvNiveau2 {
    param($Users, [string]$Label, [string]$OutDir)

    $lbl       = Clean-ForFileName $Label
    $userArray = @($Users)
    $jobs      = [System.Collections.Generic.List[hashtable]]::new()

    add-msg -msg "  [CSV] Génération niveau 2 (DO + global) — '$Label'" -foregroundColor DarkCyan -quelType writeHost
    $byDO = $userArray | Group-Object { Get-RegionFromDN $_.dn } | Where-Object { $_.Name -and $_.Name -ne 'MONCHY' }
    foreach ($doGrp in $byDO) {
        $doName = if ($doGrp.Name) { $doGrp.Name } else { 'SANS-DO' }
        $fname  = "$lbl-$(Clean-ForFileName $doName).csv"
        add-msg -msg "  [CSV]   + '$fname' ($($doGrp.Group.Count) utilisateur(s)) [DO]" -foregroundColor DarkGray -quelType writeHost
        $jobs.Add(@{ path = Join-Path $OutDir $fname; fname = $fname; content = Get-CsvContent $doGrp.Group })
    }
    $fname = "$lbl.csv"
    add-msg -msg "  [CSV]   + '$fname' ($($userArray.Count) utilisateur(s)) [global]" -foregroundColor DarkGray -quelType writeHost
    $jobs.Add(@{ path = Join-Path $OutDir $fname; fname = $fname; content = Get-CsvContent $userArray })

    add-msg -msg "  [CSV] Écriture de $($jobs.Count) fichier(s) en parallèle…" -foregroundColor DarkCyan -quelType writeHost
    Invoke-WriteJobs -Jobs $jobs
    return @($jobs | ForEach-Object { $_.fname })
}

function Write-CsvNiveau1 {
    param($Users, [string]$Label, [string]$OutDir)

    $lbl   = Clean-ForFileName $Label
    $fname = "$lbl.csv"
    $path  = Join-Path $OutDir $fname
    add-msg -msg "  [CSV] Génération niveau 1 (global uniquement) — '$Label'" -foregroundColor DarkCyan -quelType writeHost
    add-msg -msg "  [CSV]   + '$fname' ($(@($Users).Count) utilisateur(s)) [global]" -foregroundColor DarkGray -quelType writeHost
    [System.IO.File]::WriteAllText($path, (Get-CsvContent $Users), [System.Text.Encoding]::UTF8)
    add-msg -msg "  [CSV] Écriture de 1 fichier terminée." -foregroundColor DarkCyan -quelType writeHost
    return @($fname)
}

# ── Helpers ─────────────────────────────────────────────────────────────

function Get-NormalizedDepartment {
    param([string]$Department)
    if (-not $Department) { return '' }
    $dept = $Department.Trim().ToUpper()
    foreach ($region in $global:parametresJson.ad.regions) {
        if ($dept -eq $region.label.ToUpper()) { return $region.label }
        foreach ($alias in @($region.aliases)) {
            if ($dept -eq $alias.ToUpper()) { return $region.label }
        }
    }
    return $Department
}

function Find-FileParent {
    param([string]$Base, [string[]]$AllBases)
    $best = $null
    foreach ($b in $AllBases) {
        if ($b -ne $Base -and $Base.StartsWith($b + '-')) {
            if (-not $best -or $b.Length -gt $best.Length) { $best = $b }
        }
    }
    return $best
}

function Invoke-GroupProvisioning {
    param(
        [string[]]$Files,
        [string]$OutDir,
        [PSCustomObject]$Rule
    )

    $groupsOU    = $global:parametresJson.ad.groupsOU
    $searchBase  = $global:parametresJson.ad.searchBase
    $domainParts = @($searchBase -split ',' | Where-Object { $_ -match '^DC=' } | ForEach-Object { $_ -replace '^DC=', '' })
    $domain      = $domainParts -join '.'

    add-msg -msg "  [AD-PROV] ═══════════════════════════════════════════════════" -foregroundColor Magenta -quelType writeHost
    add-msg -msg "  [AD-PROV] SIMULATION — Provisionnement groupes de distribution" -foregroundColor Magenta -quelType writeHost
    add-msg -msg "  [AD-PROV] Règle    : $($Rule.label)" -foregroundColor Magenta -quelType writeHost
    add-msg -msg "  [AD-PROV] Niveau   : $($Rule.niveau) | monoNiveau : $($Rule.monoNiveau)" -foregroundColor Magenta -quelType writeHost
    add-msg -msg "  [AD-PROV] OU cible : $groupsOU" -foregroundColor Magenta -quelType writeHost
    add-msg -msg "  [AD-PROV] Domaine  : $domain" -foregroundColor Magenta -quelType writeHost
    add-msg -msg "  [AD-PROV] ═══════════════════════════════════════════════════" -foregroundColor Magenta -quelType writeHost

    if (-not $Files -or $Files.Count -eq 0) {
        add-msg -msg "  [AD-PROV] Aucun fichier CSV — provisionnement ignoré." -foregroundColor DarkGray -quelType writeHost
        return
    }

    $sorted = @($Files | Sort-Object { $_.Length })
    $bases  = @($sorted | ForEach-Object { $_ -replace '(?i)\.csv$', '' })

    # Identifier les groupes parents (ont au moins un enfant direct)
    $parentSet = @{}
    foreach ($base in $bases) {
        $parent = Find-FileParent -Base $base -AllBases $bases
        if ($parent) { $parentSet[$parent] = $true }
    }

    # ── Étape 1 : Création des groupes ──────────────────────────────────
    add-msg -msg "  [AD-PROV] --- Étape 1 : Création des groupes ($($bases.Count)) ---" -foregroundColor Cyan -quelType writeHost
    foreach ($base in $bases) {
        $isParent  = $parentSet.ContainsKey($base)
        $typeLabel = if ($isParent) { 'parent (contiendra des sous-groupes)' } else { 'feuille (contiendra des utilisateurs)' }
        $groupMail = "$base@$domain"
        add-msg -msg "  [AD-PROV] Groupe : '$base' [$typeLabel]" -foregroundColor White -quelType writeHost
        add-msg -msg "  [AD-PROV]   Mail  : $groupMail" -foregroundColor DarkGray -quelType writeHost
        # DÉSACTIVÉ — écriture AD non autorisée pour l'instant :
        # New-ADGroup_tge `
        #     -Name            $base `
        #     -SamAccountName  $base `
        #     -GroupCategory   Distribution `
        #     -GroupScope      Universal `
        #     -Path            $groupsOU `
        #     -OtherAttributes @{ mail = $groupMail; proxyAddresses = "SMTP:$groupMail" } `
        #     -Credential      $global:AD_credential
    }

    # ── Étape 2 : Alimentation des groupes ──────────────────────────────
    add-msg -msg "  [AD-PROV] --- Étape 2 : Alimentation des groupes ---" -foregroundColor Cyan -quelType writeHost
    for ($i = 0; $i -lt $sorted.Count; $i++) {
        $fname = $sorted[$i]
        $base  = $bases[$i]

        if ($parentSet.ContainsKey($base)) {
            # Groupe parent → membres = sous-groupes directs
            $children = @($bases | Where-Object { (Find-FileParent -Base $_ -AllBases $bases) -eq $base })
            add-msg -msg "  [AD-PROV] '$base' ← $($children.Count) sous-groupe(s) :" -foregroundColor White -quelType writeHost
            foreach ($child in $children) {
                add-msg -msg "  [AD-PROV]   + '$child'" -foregroundColor DarkGray -quelType writeHost
                # DÉSACTIVÉ — écriture AD non autorisée pour l'instant :
                # Add-ADGroupMember_tge `
                #     -Identity   $base `
                #     -Members    $child `
                #     -Credential $global:AD_credential
            }
        } else {
            # Groupe feuille → membres = utilisateurs du CSV
            $csvPath = Join-Path $OutDir $fname
            try {
                $allLines  = [System.IO.File]::ReadAllLines($csvPath, [System.Text.Encoding]::UTF8)
                $userCount = [math]::Max(0, $allLines.Count - 1)
            } catch { $userCount = '(erreur lecture)' }
            add-msg -msg "  [AD-PROV] '$base' ← $userCount utilisateur(s) depuis '$fname'" -foregroundColor White -quelType writeHost
            # DÉSACTIVÉ — écriture AD non autorisée pour l'instant :
            # $members = Import-Csv -Path $csvPath -Delimiter ';' |
            #            Where-Object { $_.samaccountname } |
            #            Select-Object -ExpandProperty samaccountname
            # if ($members.Count -gt 0) {
            #     Add-ADGroupMember_tge `
            #         -Identity   $base `
            #         -Members    $members `
            #         -Credential $global:AD_credential
            # }
        }
    }

    add-msg -msg "  [AD-PROV] ═══ Fin simulation : $($Files.Count) groupe(s) à provisionner ═══" -foregroundColor Magenta -quelType writeHost
}

function Get-RunOutputDir {
    param([string]$Label)
    $settingsDir = $global:path."r_settings" -replace '/', '\'
    $scriptsDir  = Split-Path $settingsDir -Parent
    $projectDir  = Split-Path $scriptsDir  -Parent
    $baseDir     = Join-Path $projectDir "application\output"
    $timestamp   = (Get-Date).ToString("yyyyMMdd-HHmm")
    $clean       = Clean-ForFileName $Label
    $runDir      = Join-Path $baseDir "${timestamp}_${clean}"
    New-Item -ItemType Directory -Path $runDir -Force | Out-Null
    return $runDir
}

function Clean-ForFileName {
    param([string]$Name)
    if (-not $Name) { return 'SANS-NOM' }
    $normalized = $Name.Normalize([System.Text.NormalizationForm]::FormD)
    $sb = [System.Text.StringBuilder]::new()
    foreach ($c in $normalized.ToCharArray()) {
        $cat = [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($c)
        if ($cat -ne [System.Globalization.UnicodeCategory]::NonSpacingMark) {
            [void]$sb.Append($c)
        }
    }
    return ($sb.ToString() -replace '[^\w\s-]', '' -replace '\s+', '-').ToUpper().Trim('-')
}
