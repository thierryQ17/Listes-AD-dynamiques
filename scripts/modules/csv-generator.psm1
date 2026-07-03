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
    # Génération RÉCURSIVE (nommage par gabarit) — chemin unique partagé avec generate-pair.
    $files = Write-RuleCsvSet -Rule $Rule -Users $filtered -OutDir $outDir

    add-msg -msg "  [CSV] Terminé : $(@($files).Count) fichiers dans '$outDir'." -foregroundColor Green -quelType writeHost

    Invoke-GroupProvisioning -Files @($files) -OutDir $outDir -Rule $Rule

    # Calcul des groupes (mêmes noms/mails que la prévisualisation) pour le contrôle des adresses mail
    $lbl        = if ($Rule.prefix) { Clean-ForFileName $Rule.prefix } else { Clean-ForFileName $Rule.label }
    $naming     = $Rule.naming
    $mailDomain = $global:parametresJson.ad.mailDomain
    $gpGroups   = [System.Collections.Generic.List[hashtable]]::new()

    if ($Rule.niveau -eq 3) {
        $byDO = $filtered | Group-Object { Get-RegionFromDN $_.dn } | Where-Object { $_.Name -and $_.Name -ne 'MONCHY' }
        foreach ($doGrp in $byDO) {
            $doName  = if ($doGrp.Name) { $doGrp.Name } else { 'SANS-DO' }
            $doClean = Clean-ForFileName $doName
            $doId    = Resolve-GroupIdentity -Naming $naming -DefaultBase "$lbl-$doClean" -MailDomain $mailDomain -Prefix $lbl -DoName $doName -Centre '' -Level 'do'
            foreach ($cGrp in ($doGrp.Group | Group-Object { Get-CentreFromDN $_.dn })) {
                $cName  = if ($cGrp.Name) { $cGrp.Name } else { 'SANS-CENTRE' }
                $cId    = Resolve-GroupIdentity -Naming $naming -DefaultBase "$lbl-$doClean-$(Clean-ForFileName $cName)" -MailDomain $mailDomain -Prefix $lbl -DoName $doName -Centre $cName -Level 'centre'
                $gpGroups.Add(@{ name = $cId.name; mail = $cId.mail; type = 'centre'; count = $cGrp.Group.Count })
            }
            $gpGroups.Add(@{ name = $doId.name; mail = $doId.mail; type = 'do'; count = $doGrp.Group.Count })
        }
        $glId = Resolve-GroupIdentity -Naming $naming -DefaultBase $lbl -MailDomain $mailDomain -Prefix $lbl -DoName '' -Centre '' -Level 'global'
        $gpGroups.Add(@{ name = $glId.name; mail = $glId.mail; type = 'global'; count = $filtered.Count })
    } elseif ($Rule.niveau -eq 2) {
        $byDO = $filtered | Group-Object { Get-RegionFromDN $_.dn } | Where-Object { $_.Name -and $_.Name -ne 'MONCHY' }
        foreach ($doGrp in $byDO) {
            $doName  = if ($doGrp.Name) { $doGrp.Name } else { 'SANS-DO' }
            $doId    = Resolve-GroupIdentity -Naming $naming -DefaultBase "$lbl-$(Clean-ForFileName $doName)" -MailDomain $mailDomain -Prefix $lbl -DoName $doName -Centre '' -Level 'do'
            $gpGroups.Add(@{ name = $doId.name; mail = $doId.mail; type = 'do'; count = $doGrp.Group.Count })
        }
        $glId = Resolve-GroupIdentity -Naming $naming -DefaultBase $lbl -MailDomain $mailDomain -Prefix $lbl -DoName '' -Centre '' -Level 'global'
        $gpGroups.Add(@{ name = $glId.name; mail = $glId.mail; type = 'global'; count = $filtered.Count })
    } else {
        $glId = Resolve-GroupIdentity -Naming $naming -DefaultBase $lbl -MailDomain $mailDomain -Prefix $lbl -DoName '' -Centre '' -Level 'global'
        $gpGroups.Add(@{ name = $glId.name; mail = $glId.mail; type = 'global'; count = $filtered.Count })
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

# ── Nommage par gabarit (patterns opt-in par règle) ─────────────────────

function Get-RegionToken {
    # {{region}} = libellé DO SANS le préfixe "DO " (ex. "DO SUD" -> "SUD")
    param([string]$DoName)
    if (-not $DoName) { return '' }
    return ($DoName -replace '^\s*DO\s+', '').Trim()
}

function Resolve-Pattern {
    # Substitue les tokens {{...}} puis nettoie les artefacts laissés par un token vide
    # (séparateurs -, ., espaces répétés ou en bord, y compris autour d'un @).
    param([string]$Pattern, [hashtable]$Tokens)
    $out = "$Pattern"
    foreach ($k in $Tokens.Keys) {
        $out = $out -replace [regex]::Escape("{{$k}}"), [string]$Tokens[$k]
    }
    $out = $out -replace '-{2,}', '-'
    $out = $out -replace '\.{2,}', '.'
    $out = $out -replace '[-.\s]+@', '@'
    $out = $out -replace '@[-.\s]+', '@'
    $out = $out -replace '^[-.\s]+', ''
    $out = $out -replace '[-.\s]+$', ''
    return $out.Trim()
}

function Resolve-GroupIdentity {
    # Retourne @{ name; mail } pour un groupe donné, selon que la règle utilise
    # un nommage par gabarit ou le nommage par défaut.
    #   - $Naming      : $Rule.naming (ou $null)
    #   - $DefaultBase : nom par défaut ("$lbl-$doClean-$cClean" selon le niveau)
    #   - $Prefix / $DoName / $Centre : sources des tokens ({{prefix}}/{{region}}/{{nomCentre}})
    #   - $Level       : 'global' | 'do' | 'centre' — sélectionne le gabarit MAIL dédié au niveau
    param(
        $Naming,
        [string]$DefaultBase,
        [string]$MailDomain,
        [string]$Prefix,
        [string]$DoName,
        [string]$Centre,
        [string]$Level = 'centre'
    )
    if ($Naming -and $Naming.namePattern) {
        $tokens = @{
            prefix    = "$Prefix"
            region    = (Get-RegionToken $DoName)
            nomCentre = "$Centre"
        }
        $name    = Resolve-Pattern -Pattern $Naming.namePattern -Tokens $tokens
        # Mail : chaque niveau utilise SON gabarit dédié s'il est renseigné
        # (mailPatternGlobal / mailPatternDo / mailPattern=Centre) ; sinon il HÉRITE du
        # gabarit « Nom groupe » (namePattern). Un champ vide = hérite du nom du groupe.
        $mailPat =
            if     ("$Level" -eq 'global' -and $Naming.mailPatternGlobal) { $Naming.mailPatternGlobal }
            elseif ("$Level" -eq 'do'     -and $Naming.mailPatternDo)     { $Naming.mailPatternDo }
            elseif ("$Level" -eq 'centre' -and $Naming.mailPattern)       { $Naming.mailPattern }
            else                                                           { $Naming.namePattern }
        $mail    = (Resolve-Pattern -Pattern $mailPat -Tokens $tokens).ToLower()
        # Une adresse mail ne peut pas contenir d'espace : un centre multi-mots
        # (ex. "Le Havre" -> "le-havre", "Lyon 6" -> "lyon-6") voit ses espaces
        # transformes en tiret. Le nom du groupe, lui, conserve ses espaces.
        $mail    = ($mail -replace '\s+', '-') -replace '-{2,}', '-'
        if ($mail -notmatch '@') { $mail = "$mail@$MailDomain" }
        return @{ name = $name; mail = $mail }
    }
    return @{ name = $DefaultBase; mail = "$($DefaultBase.ToLower())@$MailDomain" }
}

function Get-SafeFileName {
    # Nom de fichier LISIBLE : conserve le nom du groupe issu du gabarit (espaces, casse,
    # accents) et ne retire que les caractères interdits par le système de fichiers Windows.
    # Différent de Clean-ForFileName (qui MAJUSCULE et remplace tout par des tirets).
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return 'SANS-NOM' }
    $out = $Name -replace '[<>:"/\\|?*]', ' '
    $out = ($out -replace '\s{2,}', ' ').Trim().Trim('.')
    if ([string]::IsNullOrWhiteSpace($out)) { return 'SANS-NOM' }
    return $out
}

function Write-RuleCsvSet {
    # Génère l'arborescence CSV RÉCURSIVE d'une règle, nommage par gabarit :
    #   - feuille (centre en niv.3, DO en niv.2, global en niv.1) = LES PERSONNES (samAccountName;mail)
    #   - parents (DO, global) = leurs GROUPES enfants → sam = partie gauche du mail, mail = mail du groupe
    # Format 2 colonnes "samAccountName;mail", UTF-8 BOM. Retourne les chemins des fichiers écrits.
    # Partagé par /api/regles/generate-pair et Invoke-RuleGeneration (mêmes fichiers).
    param(
        [Parameter(Mandatory)] $Rule,
        [Parameter(Mandatory)] $Users,
        [Parameter(Mandatory)][string] $OutDir
    )
    $lbl        = if ($Rule.prefix) { Clean-ForFileName $Rule.prefix } else { Clean-ForFileName $Rule.label }
    $naming     = $Rule.naming
    $mailDomain = $global:parametresJson.ad.mailDomain
    $niveau     = if ($Rule.niveau) { [int]$Rule.niveau } else { 3 }
    $filtered   = @($Users)
    $utf8Bom    = New-Object System.Text.UTF8Encoding($true)
    $written    = [System.Collections.Generic.List[string]]::new()

    $writeCsv = {
        param([string]$FileBase, $Rows)
        $lines = [System.Collections.Generic.List[string]]::new()
        $lines.Add("samAccountName;mail")
        foreach ($row in @($Rows)) { $lines.Add([string]$row) }
        $path = Join-Path $OutDir "$(Get-SafeFileName $FileBase).csv"
        [System.IO.File]::WriteAllText($path, ($lines -join "`r`n"), $utf8Bom)
        [void]$written.Add($path)
    }
    $usersRows = { param($Grp) $l = [System.Collections.Generic.List[string]]::new(); foreach ($u in ($Grp | Sort-Object samAccountName)) { $l.Add("$($u.samAccountName);$($u.mail)") }; $l }
    $childRow  = { param($Id) $sam = ($Id.mail -split '@')[0]; "$sam;$($Id.mail)" }
    # Nom de fichier CSV = adresse mail COMPLÈTE du groupe (avec le domaine), pour chaque niveau
    $mailBase  = { param($Id) "$($Id.mail)" }
    $glId = Resolve-GroupIdentity -Naming $naming -DefaultBase $lbl -MailDomain $mailDomain -Prefix $lbl -DoName '' -Centre '' -Level 'global'

    if ($niveau -ge 3) {
        $doChildRows = [System.Collections.Generic.List[string]]::new()
        $byDO = $filtered | Group-Object { Get-RegionFromDN $_.dn } | Where-Object { $_.Name -and $_.Name -ne 'MONCHY' }
        foreach ($doGrp in $byDO) {
            $doClean = Clean-ForFileName $doGrp.Name
            $doId    = Resolve-GroupIdentity -Naming $naming -DefaultBase "$lbl-$doClean" -MailDomain $mailDomain -Prefix $lbl -DoName $doGrp.Name -Centre '' -Level 'do'
            $cChildRows = [System.Collections.Generic.List[string]]::new()
            foreach ($cGrp in ($doGrp.Group | Group-Object { Get-CentreFromDN $_.dn })) {
                $cClean = Clean-ForFileName $cGrp.Name
                $cId    = Resolve-GroupIdentity -Naming $naming -DefaultBase "$lbl-$doClean-$cClean" -MailDomain $mailDomain -Prefix $lbl -DoName $doGrp.Name -Centre $cGrp.Name -Level 'centre'
                & $writeCsv (& $mailBase $cId) (& $usersRows $cGrp.Group)
                $cChildRows.Add((& $childRow $cId))
            }
            & $writeCsv (& $mailBase $doId) $cChildRows
            $doChildRows.Add((& $childRow $doId))
        }
        & $writeCsv (& $mailBase $glId) $doChildRows
    } elseif ($niveau -eq 2) {
        $doChildRows = [System.Collections.Generic.List[string]]::new()
        $byDO = $filtered | Group-Object { Get-RegionFromDN $_.dn } | Where-Object { $_.Name -and $_.Name -ne 'MONCHY' }
        foreach ($doGrp in $byDO) {
            $doClean = Clean-ForFileName $doGrp.Name
            $doId    = Resolve-GroupIdentity -Naming $naming -DefaultBase "$lbl-$doClean" -MailDomain $mailDomain -Prefix $lbl -DoName $doGrp.Name -Centre '' -Level 'do'
            & $writeCsv (& $mailBase $doId) (& $usersRows $doGrp.Group)
            $doChildRows.Add((& $childRow $doId))
        }
        & $writeCsv (& $mailBase $glId) $doChildRows
    } else {
        & $writeCsv (& $mailBase $glId) (& $usersRows $filtered)
    }
    return @($written)
}

function Read-CsvMailMap {
    # Lit un CSV "samAccountName;mail" → @{ mail = samAccountName } (clé = ADRESSE MAIL).
    param([string]$Path)
    $map = @{}
    if (-not (Test-Path $Path)) { return $map }
    $lines = [System.IO.File]::ReadAllLines($Path, [System.Text.Encoding]::UTF8)
    for ($i = 1; $i -lt $lines.Count; $i++) {   # saute l'en-tête
        $line = $lines[$i].Trim()
        if (-not $line) { continue }
        $parts = $line -split ';'
        $sam   = if ($parts.Count -ge 1) { $parts[0].Trim().Trim('"') } else { '' }
        $mail  = if ($parts.Count -ge 2) { $parts[1].Trim().Trim('"') } else { '' }
        if ($mail) { $map[$mail] = $sam }
    }
    return $map
}

function Get-DeltaRelCsv {
    # Chemins relatifs des CSV d'un dossier de run, en EXCLUANT le sous-dossier __DELTA CSVs.
    param([string]$Dir)
    if (-not (Test-Path $Dir)) { return @() }
    @(Get-ChildItem -Path $Dir -Filter '*.csv' -Recurse -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName.Substring($Dir.Length).TrimStart('\') } |
        Where-Object { $_ -notlike '__DELTA CSVs*' })   # exclut tous les sous-dossiers delta (avec suffixe date)
}

function Write-CsvDelta {
    # Compare NewDir vs RefDir (clé = adresse mail) → écrit le delta dans DeltaDir (MÊME arborescence
    # GROUPE\<mail>.csv). Chaque fichier delta : en-tête "samAccountName;mail;type" (ajout|suppression).
    # Seuls les fichiers présentant au moins une différence sont écrits.
    param([string]$NewDir, [string]$RefDir, [string]$DeltaDir)
    $utf8Bom = New-Object System.Text.UTF8Encoding($true)
    $rels = @(@(Get-DeltaRelCsv $NewDir) + @(Get-DeltaRelCsv $RefDir)) | Sort-Object -Unique
    $files = 0; $adds = 0; $removes = 0
    foreach ($rel in $rels) {
        $new = Read-CsvMailMap (Join-Path $NewDir $rel)
        $ref = Read-CsvMailMap (Join-Path $RefDir $rel)
        $lines = [System.Collections.Generic.List[string]]::new()
        $lines.Add("samAccountName;mail;type")
        foreach ($mail in $new.Keys) { if (-not $ref.ContainsKey($mail)) { $lines.Add("$($new[$mail]);$mail;ajout");       $adds++ } }
        foreach ($mail in $ref.Keys) { if (-not $new.ContainsKey($mail)) { $lines.Add("$($ref[$mail]);$mail;suppression"); $removes++ } }
        if ($lines.Count -gt 1) {
            $out = Join-Path $DeltaDir $rel
            New-Item -ItemType Directory -Path (Split-Path $out -Parent) -Force | Out-Null
            [System.IO.File]::WriteAllText($out, ($lines -join "`r`n"), $utf8Bom)
            $files++
        }
    }
    return @{ files = $files; adds = $adds; removes = $removes }
}

function Get-RuleGroupCount {
    # Nombre TOTAL de groupes (hiérarchie complète : global + DO + centres) que produit
    # une règle — identique au « N groupe(s) » de la prévisualisation. Indépendant de
    # monoNiveau (qui n'affecte que la génération CSV, pas la structure des groupes).
    # Réutilise exactement la même logique de filtrage que /api/regles/preview-groups.
    param($Rule, $AllUsers, $AllRules)

    if ($Rule.invertOf) {
        $srcRule = @($AllRules | Where-Object { $_.id -eq $Rule.invertOf } | Select-Object -First 1)
        if (-not $srcRule) { return 0 }
        $srcIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        @($AllUsers | Where-Object { Test-UserMatchesRule -User $_ -Conditions $srcRule.conditions }) | ForEach-Object { [void]$srcIds.Add($_.samAccountName) }
        $filtered = @($AllUsers | Where-Object { -not $srcIds.Contains($_.samAccountName) })
    } else {
        $filtered = @($AllUsers | Where-Object { Test-UserMatchesRule -User $_ -Conditions $Rule.conditions })
    }
    $filtered = @($filtered | Where-Object { -not (Test-UserExcluded $_) })

    if ($Rule.niveau -eq 3) {
        $byDO = @($filtered | Group-Object { Get-RegionFromDN $_.dn } | Where-Object { $_.Name -and $_.Name -ne 'MONCHY' })
        $centres = 0
        foreach ($doGrp in $byDO) {
            $centres += @($doGrp.Group | Group-Object { Get-CentreFromDN $_.dn }).Count
        }
        return 1 + $byDO.Count + $centres
    } elseif ($Rule.niveau -eq 2) {
        $byDO = @($filtered | Group-Object { Get-RegionFromDN $_.dn } | Where-Object { $_.Name -and $_.Name -ne 'MONCHY' })
        return 1 + $byDO.Count
    }
    return 1
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
