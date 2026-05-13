# Lecture AD seule — génère des fichiers CSV sans aucune modification de l'AD

function Invoke-RuleGeneration {
    param([Parameter(Mandatory)][PSCustomObject]$Rule)

    if (-not $Rule.conditions -or -not $Rule.conditions.include -or $Rule.conditions.include.Count -eq 0) {
        throw "La règle n'a pas de conditions 'include'."
    }

    if ($global:AD_usersCache -and $global:AD_usersCache.Count -gt 0) {
        $allUsers = $global:AD_usersCache
        add-msg -msg "  [CSV] Cache utilisateurs utilisé ($($allUsers.Count) utilisateurs)." -foregroundColor DarkGray -quelType writeHost
    } else {
        $searchBase = $global:parametresJson.ad.searchBase
        add-msg -msg "  [CSV] Chargement des utilisateurs (searchBase: $searchBase)…" -foregroundColor Cyan -quelType writeHost
        $adParams = @{
            Filter      = { Enabled -eq $true }
            SearchBase  = $searchBase
            Credential  = $global:AD_credential
            Properties  = @('SamAccountName','Mail','Title','Department','Office','extensionAttribute1','Description')
            ErrorAction = 'Stop'
        }
        $allUsers = @(Get-ADUser @adParams)
        add-msg -msg "  [CSV] $($allUsers.Count) utilisateurs actifs chargés." -foregroundColor Cyan -quelType writeHost
    }

    $filtered = @($allUsers | Where-Object { Test-UserMatchesRule -User $_ -Conditions $Rule.conditions })
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

    return [PSCustomObject]@{
        ok     = $true
        outDir = $outDir
        files  = @($files)
        total  = $filtered.Count
    }
}

# ── Filtrage ────────────────────────────────────────────────────────────

function Test-UserMatchesRule {
    param($User, $Conditions)

    # Au moins une condition include doit correspondre (OR)
    $inc = @($Conditions.include)
    $matchInc = ($inc.Count -eq 0) -or ($null -ne ($inc | Where-Object { Test-Condition -User $User -Cond $_ } | Select-Object -First 1))
    if (-not $matchInc) { return $false }

    # Aucune condition exclude ne doit correspondre (OR)
    $exc = @($Conditions.exclude)
    if ($exc.Count -gt 0) {
        $matchExc = $null -ne ($exc | Where-Object { Test-Condition -User $User -Cond $_ } | Select-Object -First 1)
        if ($matchExc) { return $false }
    }

    return $true
}

function Test-Condition {
    param($User, $Cond)
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
        'like'    { return $val -like    $Cond.value }
        'notlike' { return $val -notlike $Cond.value }
        default   { return $false }
    }
}

# ── Écriture CSV ────────────────────────────────────────────────────────

function Write-CsvNiveau3 {
    param($Users, [string]$Label, [string]$OutDir)

    $files     = [System.Collections.Generic.List[string]]::new()
    $lbl       = Clean-ForFileName $Label
    $userArray = @($Users)

    $byDO = $userArray | Group-Object Department
    foreach ($doGrp in $byDO) {
        $doName  = if ($doGrp.Name) { $doGrp.Name } else { 'SANS-DO' }
        $doClean = Clean-ForFileName $doName

        $byCentre = $doGrp.Group | Group-Object Office
        foreach ($cGrp in $byCentre) {
            $cName  = if ($cGrp.Name) { $cGrp.Name } else { 'SANS-CENTRE' }
            $cClean = Clean-ForFileName $cName
            $fname  = "$lbl-$doClean-$cClean.csv"
            Write-UsersCsv -Users $cGrp.Group -Path (Join-Path $OutDir $fname)
            $files.Add($fname)
            add-msg -msg "  [CSV]   $fname ($($cGrp.Count))" -foregroundColor DarkGray -quelType writeHost
        }

        $fname = "$lbl-$doClean.csv"
        Write-UsersCsv -Users $doGrp.Group -Path (Join-Path $OutDir $fname)
        $files.Add($fname)
        add-msg -msg "  [CSV]   $fname ($($doGrp.Count), récursif DO)" -foregroundColor DarkGray -quelType writeHost
    }

    $fname = "$lbl.csv"
    Write-UsersCsv -Users $userArray -Path (Join-Path $OutDir $fname)
    $files.Add($fname)
    add-msg -msg "  [CSV]   $fname ($($userArray.Count), global)" -foregroundColor DarkGray -quelType writeHost

    return @($files)
}

function Write-CsvNiveau3Mono {
    param($Users, [string]$Label, [string]$OutDir)

    $files     = [System.Collections.Generic.List[string]]::new()
    $lbl       = Clean-ForFileName $Label
    $userArray = @($Users)

    $byDO = $userArray | Group-Object Department
    foreach ($doGrp in $byDO) {
        $doName   = if ($doGrp.Name) { $doGrp.Name } else { 'SANS-DO' }
        $doClean  = Clean-ForFileName $doName
        $byCentre = $doGrp.Group | Group-Object Office
        foreach ($cGrp in $byCentre) {
            $cName  = if ($cGrp.Name) { $cGrp.Name } else { 'SANS-CENTRE' }
            $cClean = Clean-ForFileName $cName
            $fname  = "$lbl-$doClean-$cClean.csv"
            Write-UsersCsv -Users $cGrp.Group -Path (Join-Path $OutDir $fname)
            $files.Add($fname)
            add-msg -msg "  [CSV]   $fname ($($cGrp.Count))" -foregroundColor DarkGray -quelType writeHost
        }
    }

    return @($files)
}

function Write-CsvNiveau2 {
    param($Users, [string]$Label, [string]$OutDir)

    $files     = [System.Collections.Generic.List[string]]::new()
    $lbl       = Clean-ForFileName $Label
    $userArray = @($Users)

    $byDO = $userArray | Group-Object Department
    foreach ($doGrp in $byDO) {
        $doName  = if ($doGrp.Name) { $doGrp.Name } else { 'SANS-DO' }
        $doClean = Clean-ForFileName $doName
        $fname   = "$lbl-$doClean.csv"
        Write-UsersCsv -Users $doGrp.Group -Path (Join-Path $OutDir $fname)
        $files.Add($fname)
        add-msg -msg "  [CSV]   $fname ($($doGrp.Count))" -foregroundColor DarkGray -quelType writeHost
    }

    $fname = "$lbl.csv"
    Write-UsersCsv -Users $userArray -Path (Join-Path $OutDir $fname)
    $files.Add($fname)
    add-msg -msg "  [CSV]   $fname ($($userArray.Count), global)" -foregroundColor DarkGray -quelType writeHost

    return @($files)
}

function Write-CsvNiveau1 {
    param($Users, [string]$Label, [string]$OutDir)

    $lbl   = Clean-ForFileName $Label
    $fname = "$lbl.csv"
    Write-UsersCsv -Users @($Users) -Path (Join-Path $OutDir $fname)
    add-msg -msg "  [CSV]   $fname ($(@($Users).Count), global)" -foregroundColor DarkGray -quelType writeHost
    return @($fname)
}

function Write-UsersCsv {
    param($Users, [string]$Path)
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('"samaccountname";"mail"')
    foreach ($u in @($Users)) {
        $sam  = if ($u.SamAccountName) { $u.SamAccountName } else { '' }
        $mail = if ($u.Mail)           { $u.Mail }           else { '' }
        $lines.Add("`"$sam`";`"$mail`"")
    }
    [System.IO.File]::WriteAllLines($Path, $lines, [System.Text.Encoding]::UTF8)
}

# ── Helpers ─────────────────────────────────────────────────────────────

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
