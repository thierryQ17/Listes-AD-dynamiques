# =============================================================================
#  http-server.psm1 — Serveur HTTP basé sur Pode (remplace System.Net.HttpListener)
#
#  Points clés (validés au POC) :
#   - Pode traite chaque requête dans un pool de runspaces (multi-thread).
#   - L'auto-import Pode réimporte les modules de session dans les runspaces →
#     Get-OUTree / Get-AllUsersFromCache / Test-UserMatchesRule / add-msg y sont
#     disponibles sans Import-PodeModule.
#   - Les $global:* (parametresJson, AD_credential, path, fileLog) sont snapshotés
#     dans l'état Pode (Set-PodeState) et réhydratés par le middleware avant chaque
#     route. Le garde de _initGlobalVariables empêche son init de se rejouer.
#   - Corps POST en PSCustomObject : $WebEvent.Request.Body (car $WebEvent.Data est
#     un OrderedHashtable, incompatible avec .PSObject.Properties).
#   - Écritures concurrentes de regles.json protégées par Lock-PodeObject (verrou global).
# =============================================================================

function Start-AppServer {
    param([int]$Port = 8080)

    # Pont via global : le scriptblock de Start-PodeServer n'a pas de garantie de capturer
    # $Port (variable locale), mais les $global:* y sont accessibles (validé au POC).
    $global:__AppPort = $Port

    # -Browse : Pode ouvre lui-même le navigateur UNE FOIS le serveur à l'écoute
    # (évite le "connexion échouée" quand le navigateur était ouvert trop tôt).
    Start-PodeServer -Threads 3 -Browse {
        Add-PodeEndpoint -Address localhost -Port $global:__AppPort -Protocol Http

        # --- Snapshot des globals du thread principal vers l'état Pode ---
        Set-PodeState -Name 'parametresJson' -Value $global:parametresJson | Out-Null
        Set-PodeState -Name 'AD_credential'  -Value $global:AD_credential  | Out-Null
        Set-PodeState -Name 'path'           -Value $global:path           | Out-Null
        Set-PodeState -Name 'fileLog'        -Value $global:fileLog        | Out-Null

        # --- Middleware global : réhydratation des globals + CORS + log ---
        Add-PodeMiddleware -Name 'Bootstrap' -ScriptBlock {
            $global:parametresJson = Get-PodeState -Name 'parametresJson'
            $global:AD_credential  = Get-PodeState -Name 'AD_credential'
            $global:path           = Get-PodeState -Name 'path'
            $global:fileLog        = Get-PodeState -Name 'fileLog'
            Add-PodeHeader -Name 'Access-Control-Allow-Origin' -Value '*'
            add-msg -msg "$($WebEvent.Method) $($WebEvent.Path)" -foregroundColor DarkGray -quelType writeHost
            return $true
        }

        add-msg -msg "Serveur Pode actif : http://localhost:$Port" -foregroundColor Green

        # ==================== PAGES / STATIQUE ====================
        Add-PodeRoute -Method Get -Path '/'            -ScriptBlock { Serve-File -Key 'f_shell.html' -ContentType 'text/html' }
        Add-PodeRoute -Method Get -Path '/shell'       -ScriptBlock { Serve-File -Key 'f_shell.html' -ContentType 'text/html' }
        Add-PodeRoute -Method Get -Path '/shell.html'  -ScriptBlock { Serve-File -Key 'f_shell.html' -ContentType 'text/html' }
        Add-PodeRoute -Method Get -Path '/groupes'      -ScriptBlock { Serve-File -Key 'f_index.html' -ContentType 'text/html' }
        Add-PodeRoute -Method Get -Path '/groupes.html' -ScriptBlock { Serve-File -Key 'f_index.html' -ContentType 'text/html' }
        Add-PodeRoute -Method Get -Path '/index.html'  -ScriptBlock { Move-PodeResponseUrl -Url '/groupes' }
        Add-PodeRoute -Method Get -Path '/app.js'      -ScriptBlock { Serve-File -Key 'f_app.js'   -ContentType 'application/javascript' }
        Add-PodeRoute -Method Get -Path '/style.css'   -ScriptBlock { Serve-File -Key 'f_style.css' -ContentType 'text/css' }
        Add-PodeRoute -Method Get -Path '/explorer'      -ScriptBlock { Serve-File -Key 'f_explorer.html' -ContentType 'text/html' }
        Add-PodeRoute -Method Get -Path '/explorer.html' -ScriptBlock { Serve-File -Key 'f_explorer.html' -ContentType 'text/html' }
        Add-PodeRoute -Method Get -Path '/explorer.js'   -ScriptBlock { Serve-File -Key 'f_explorer.js'   -ContentType 'application/javascript' }
        Add-PodeRoute -Method Get -Path '/explorer.css'  -ScriptBlock { Serve-File -Key 'f_explorer.css'  -ContentType 'text/css' }
        Add-PodeRoute -Method Get -Path '/regles'      -ScriptBlock { Serve-File -Key 'f_regles.html' -ContentType 'text/html' }
        Add-PodeRoute -Method Get -Path '/regles.html' -ScriptBlock { Serve-File -Key 'f_regles.html' -ContentType 'text/html' }
        Add-PodeRoute -Method Get -Path '/regles.js'   -ScriptBlock { Serve-File -Key 'f_regles.js'  -ContentType 'application/javascript' }
        Add-PodeRoute -Method Get -Path '/regles.css'  -ScriptBlock { Serve-File -Key 'f_regles.css' -ContentType 'text/css' }

        # ==================== API — Groupes Dynamiques (index.html) ====================
        Add-PodeRoute -Method Get -Path '/api/groups' -ScriptBlock {
            Send-Json -Body (Get-I2NGroups | ConvertTo-Json -Depth 3 -Compress)
        }
        Add-PodeRoute -Method Get -Path '/api/group/members' -ScriptBlock {
            $dn = $WebEvent.Query['dn']
            Send-Json -Body (Get-I2NGroupMembers -GroupDN $dn | ConvertTo-Json -Depth 3 -Compress)
        }
        Add-PodeRoute -Method Get -Path '/api/search' -ScriptBlock {
            $q    = if ($WebEvent.Query['q'])    { $WebEvent.Query['q'] }    else { '' }
            $type = if ($WebEvent.Query['type']) { $WebEvent.Query['type'] } else { 'both' }
            Send-Json -Body (Search-ADObjects -Query $q -Type $type | ConvertTo-Json -Depth 3 -Compress)
        }

        # ==================== API — Cache ====================
        Add-PodeRoute -Method Get -Path '/api/cache/counts' -ScriptBlock {
            $idx  = Get-CacheIndexPath
            $data = if (Test-Path $idx) { [System.IO.File]::ReadAllText($idx, [System.Text.Encoding]::UTF8) } else { '{}' }
            Send-Json -Body $data
        }
        Add-PodeRoute -Method Get -Path '/api/cache/info' -ScriptBlock {
            $gPath   = Get-GlobalUsersCachePath
            $builtAt = if (Test-Path $gPath) { (Get-Item $gPath).LastWriteTime.ToString('yyyy-MM-ddTHH:mm:ss') } else { $null }
            $body    = if ($builtAt) { "{`"builtAt`":`"$builtAt`"}" } else { '{"builtAt":null}' }
            Send-Json -Body $body
        }
        Add-PodeRoute -Method Post -Path '/api/cache/refresh-all' -ScriptBlock {
            $scriptsDir = Split-Path $global:path."r_settings" -Parent
            $cacheDir   = Join-Path $scriptsDir "cache"
            $deleted    = 0
            if (Test-Path $cacheDir) {
                $files = Get-ChildItem -Path $cacheDir -Filter "*.json" -ErrorAction SilentlyContinue
                foreach ($f in $files) { Remove-Item $f.FullName -Force; $deleted++ }
            }
            $idxPath = Get-CacheIndexPath
            if (Test-Path $idxPath) { Remove-Item $idxPath -Force }
            add-msg -msg "Cache vidé ($deleted fichiers supprimés). Relance du warmup..." -foregroundColor Yellow
            Start-CacheWarmup
            Send-Json -Body "{`"ok`":true,`"deleted`":$deleted}"
        }

        # ==================== API — Arbre / OUs ====================
        Add-PodeRoute -Method Get -Path '/api/tree' -ScriptBlock {
            $treeList = [System.Collections.ArrayList]@(Get-OUTree)
            Send-Json -Body (ConvertTo-Json -InputObject $treeList -Depth 5 -Compress)
        }
        Add-PodeRoute -Method Get -Path '/api/ou/users' -ScriptBlock {
            $dn        = $WebEvent.Query['dn']
            $fresh     = $WebEvent.Query['fresh'] -eq '1'
            $cachePath = Get-OUCachePath -DN $dn

            if (-not $fresh -and (Test-Path $cachePath)) {
                $data = [System.IO.File]::ReadAllText($cachePath, [System.Text.Encoding]::UTF8)
                Add-PodeHeader -Name 'X-Cache' -Value 'HIT'
                add-msg -msg "  → cache HIT : $dn" -foregroundColor DarkGray -quelType writeHost
            } else {
                $userList = [System.Collections.ArrayList]@(Get-OUSiteUsers -SiteDN $dn)
                $data     = ConvertTo-Json -InputObject $userList -Depth 5 -Compress
                [System.IO.File]::WriteAllText($cachePath, $data, [System.Text.Encoding]::UTF8)
                Update-CacheIndex -DN $dn -Count $userList.Count
                Add-PodeHeader -Name 'X-Cache' -Value 'MISS'
                add-msg -msg "  → cache MISS (écrit) : $dn" -foregroundColor DarkGray -quelType writeHost
            }
            Send-Json -Body $data
        }

        # ==================== API — Règles (CRUD) ====================
        Add-PodeRoute -Method Get -Path '/api/regles' -ScriptBlock {
            $rPath = Get-ReglesPath
            $data  = if (Test-Path $rPath) { [System.IO.File]::ReadAllText($rPath, [System.Text.Encoding]::UTF8) } else { '[]' }
            Send-Json -Body $data
        }
        Add-PodeRoute -Method Post -Path '/api/regles' -ScriptBlock {
            $rule = ConvertFrom-Json $WebEvent.Request.Body
            Lock-PodeObject -ScriptBlock {
                $rPath  = Get-ReglesPath
                $regles = if (Test-Path $rPath) { @(ConvertFrom-Json ([System.IO.File]::ReadAllText($rPath, [System.Text.Encoding]::UTF8))) } else { @() }
                $idx    = -1
                for ($i = 0; $i -lt $regles.Count; $i++) { if ($regles[$i].id -eq $rule.id) { $idx = $i; break } }
                if ($idx -ge 0) {
                    $stored = $regles[$idx]
                    # Règle verrouillée : bloquer toute modification, sauf le déverrouillage explicite (locked:false)
                    if ($stored.locked -eq $true -and $rule.locked -ne $false) {
                        Send-Json -Body '{"error":"Règle verrouillée — modification bloquée."}' -StatusCode 403
                        return
                    }
                    $regles[$idx] = $rule
                    # Préserver les champs non gérés par le formulaire (ex. invertOf)
                    if ($stored.PSObject.Properties['invertOf'] -and -not $rule.PSObject.Properties['invertOf']) {
                        $regles[$idx] | Add-Member -NotePropertyName 'invertOf' -NotePropertyValue $stored.invertOf -Force
                    }
                } else { $regles += $rule }
                [System.IO.File]::WriteAllText($rPath, (ConvertTo-Json -InputObject @($regles) -Depth 10 -Compress), [System.Text.Encoding]::UTF8)
                Send-Json -Body '{"ok":true}'
            }
        }
        Add-PodeRoute -Method Post -Path '/api/regles/:id/generate' -ScriptBlock {
            $id    = $WebEvent.Parameters['id']
            $rPath = Get-ReglesPath
            $regles = if (Test-Path $rPath) { @(ConvertFrom-Json ([System.IO.File]::ReadAllText($rPath, [System.Text.Encoding]::UTF8))) } else { @() }
            $rule   = $regles | Where-Object { $_.id -eq $id } | Select-Object -First 1
            if (-not $rule) {
                Send-Json -Body '{"error":"Règle introuvable"}' -StatusCode 404
            } else {
                try {
                    $result = Invoke-RuleGeneration -Rule $rule
                    Send-Json -Body (ConvertTo-Json -InputObject $result -Depth 5 -Compress)
                } catch {
                    add-msg -msg "  [CSV] ERREUR : $($_.Exception.Message)" -foregroundColor Red -quelType writeHost
                    $errMsg = ($_.Exception.Message -replace '[\r\n\t]', ' ' -replace '"', "'")
                    Send-Json -Body "{`"ok`":false,`"error`":`"$errMsg`"}"
                }
            }
        }
        Add-PodeRoute -Method Delete -Path '/api/regles/:id' -ScriptBlock {
            $id = $WebEvent.Parameters['id']
            Lock-PodeObject -ScriptBlock {
                $rPath  = Get-ReglesPath
                $regles = if (Test-Path $rPath) { @(ConvertFrom-Json ([System.IO.File]::ReadAllText($rPath, [System.Text.Encoding]::UTF8))) } else { @() }
                $target = $regles | Where-Object { $_.id -eq $id } | Select-Object -First 1
                if ($target -and $target.locked -eq $true) {
                    Send-Json -Body '{"error":"Règle verrouillée — suppression bloquée."}' -StatusCode 403
                } else {
                    $regles = @($regles | Where-Object { $_.id -ne $id })
                    [System.IO.File]::WriteAllText($rPath, (ConvertTo-Json -InputObject @($regles) -Depth 10 -Compress), [System.Text.Encoding]::UTF8)
                    Send-Json -Body '{"ok":true}'
                }
            }
        }

        # ==================== API — Utilisateurs / préchargement ====================
        Add-PodeRoute -Method Get -Path '/api/users/cache-info' -ScriptBlock {
            $cachePath = Get-GlobalUsersCachePath
            if (Test-Path $cachePath) {
                $fi    = [System.IO.FileInfo]$cachePath
                $count = @(Get-AllUsersFromCache).Count
                $ts    = $fi.LastWriteTime.ToString('dd/MM/yyyy HH:mm')
                Send-Json -Body "{`"ok`":true,`"count`":$count,`"ts`":`"$ts`"}"
            } else {
                Send-Json -Body '{"ok":false,"count":0,"ts":""}'
            }
        }
        Add-PodeRoute -Method Post -Path '/api/users/preload' -ScriptBlock {
            try {
                # Reconstruit TOUS les caches : OUs + utilisateurs global (synchrone),
                # puis purge les caches par site et relance le warmup (reconstruction en arrière-plan).
                [void](Build-OUsCache)
                $count = Build-GlobalUsersCache
                $sd = Split-Path ($global:path."r_settings" -replace '/', '\') -Parent
                $cd = Join-Path $sd "cache"
                if (Test-Path $cd) {
                    Get-ChildItem $cd -Filter '*.json' -ErrorAction SilentlyContinue |
                        Where-Object { $_.Name -notin @('_users_global.json', '_ous_global.json') } |
                        Remove-Item -Force -ErrorAction SilentlyContinue
                }
                Start-CacheWarmup
                Send-Json -Body "{`"ok`":true,`"count`":$count}"
            } catch {
                $errMsg = $_.Exception.Message -replace '"', "'"
                Send-Json -Body "{`"ok`":false,`"error`":`"$errMsg`"}"
            }
        }
        Add-PodeRoute -Method Get -Path '/api/users/preload/status' -ScriptBlock {
            $cachePath = Get-GlobalUsersCachePath
            $cached = Test-Path $cachePath
            $count  = if ($cached) { @(Get-AllUsersFromCache).Count } else { 0 }
            Send-Json -Body "{`"cached`":$(if($cached){'true'}else{'false'}),`"count`":$count}"
        }

        # ==================== API — CSV / sorties ====================
        Add-PodeRoute -Method Get -Path '/api/csv/read' -ScriptBlock {
            $dir  = $WebEvent.Query['dir']
            $file = $WebEvent.Query['file']
            $settingsDir = $global:path."r_settings" -replace '/', '\'
            $baseDir     = Join-Path (Split-Path (Split-Path $settingsDir -Parent) -Parent) "application\output"
            $resolved    = [System.IO.Path]::GetFullPath((Join-Path $dir $file))
            if (-not $resolved.StartsWith($baseDir)) {
                Send-Json -Body '{"error":"Chemin non autorisé"}' -StatusCode 403
            } elseif (-not (Test-Path $resolved)) {
                Send-Json -Body '{"error":"Fichier introuvable"}' -StatusCode 404
            } else {
                $lines = @([System.IO.File]::ReadAllLines($resolved, [System.Text.Encoding]::UTF8))
                $rows  = [System.Collections.Generic.List[PSCustomObject]]::new()
                for ($i = 1; $i -lt $lines.Count; $i++) {
                    $line = $lines[$i].Trim()
                    if (-not $line) { continue }
                    $parts = @($line -split ';' | ForEach-Object { $_ -replace '^"|"$', '' })
                    $nom      = if ($parts.Count -gt 0) { $parts[0] } else { '' }
                    $sam      = if ($parts.Count -gt 1) { $parts[1] } else { '' }
                    $mail     = if ($parts.Count -gt 2) { $parts[2] } else { '' }
                    $fonction = if ($parts.Count -gt 3) { $parts[3] } else { '' }
                    $rows.Add([PSCustomObject]@{ nom = $nom; sam = $sam; mail = $mail; fonction = $fonction })
                }
                Send-Json -Body (ConvertTo-Json -InputObject @($rows) -Depth 2 -Compress)
            }
        }
        Add-PodeRoute -Method Get -Path '/api/output/list' -ScriptBlock {
            $settingsDir = $global:path."r_settings" -replace '/', '\'
            $outputDir   = [System.IO.Path]::GetFullPath((Join-Path (Split-Path (Split-Path $settingsDir -Parent) -Parent) "application\output"))
            $runs        = [System.Collections.Generic.List[PSCustomObject]]::new()
            if (Test-Path $outputDir) {
                foreach ($d in (Get-ChildItem -Path $outputDir -Directory | Sort-Object Name -Descending)) {
                    $csvFiles = @(Get-ChildItem -Path $d.FullName -Filter "*.csv" -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object { $_.Name })
                    $runs.Add([PSCustomObject]@{ run = $d.Name; path = $d.FullName; files = $csvFiles })
                }
            }
            Send-Json -Body (ConvertTo-Json -InputObject @($runs) -Depth 3 -Compress)
        }
        Add-PodeRoute -Method Get -Path '/api/output/read' -ScriptBlock {
            $reqPath     = $WebEvent.Query['path']
            $settingsDir = $global:path."r_settings" -replace '/', '\'
            $normalBase  = [System.IO.Path]::GetFullPath((Join-Path (Split-Path (Split-Path $settingsDir -Parent) -Parent) "application\output")).TrimEnd('\') + '\'
            $resolved    = [System.IO.Path]::GetFullPath($reqPath)
            if (-not $resolved.StartsWith($normalBase, [System.StringComparison]::OrdinalIgnoreCase)) {
                Send-Json -Body '{"error":"Chemin non autorisé"}' -StatusCode 403
            } elseif (-not (Test-Path $resolved)) {
                Send-Json -Body '{"error":"Fichier introuvable"}' -StatusCode 404
            } else {
                $lines = @([System.IO.File]::ReadAllLines($resolved, [System.Text.Encoding]::UTF8))
                if ($lines.Count -eq 0) {
                    Send-Json -Body '{"headers":[],"rows":[]}'
                } else {
                    $sep  = if ($lines[0] -match ';') { ';' } else { ',' }
                    $hdrs = @($lines[0] -split [regex]::Escape($sep) | ForEach-Object { $_.Trim().Trim('"') })
                    $rows = [System.Collections.Generic.List[PSCustomObject]]::new()
                    for ($i = 1; $i -lt $lines.Count; $i++) {
                        $line = $lines[$i].Trim()
                        if (-not $line) { continue }
                        $parts = @($line -split [regex]::Escape($sep) | ForEach-Object { $_.Trim('"') })
                        $row   = [ordered]@{}
                        for ($j = 0; $j -lt $hdrs.Count; $j++) {
                            $row[$hdrs[$j]] = if ($j -lt $parts.Count) { $parts[$j] } else { '' }
                        }
                        $rows.Add([PSCustomObject]$row)
                    }
                    $result = [PSCustomObject]@{ headers = $hdrs; rows = @($rows) }
                    Send-Json -Body (ConvertTo-Json -InputObject $result -Depth 4 -Compress)
                }
            }
        }

        # ==================== API — Règles : contrôle mail ====================
        Add-PodeRoute -Method Post -Path '/api/regles/check-mail' -ScriptBlock {
            try {
                $body = ConvertFrom-Json $WebEvent.Request.Body
                $addr = if ($body.address) { "$($body.address)".Trim() } else { '' }
                if (-not $addr) {
                    Send-Json -Body '{"error":"Adresse manquante"}'
                } else {
                    $searchBase = $global:parametresJson.ad.searchBase
                    $ldapFilter = "(|(mail=$addr)(proxyAddresses=*:$addr))"
                    $obj = Get-ADObject -LDAPFilter $ldapFilter `
                        -SearchBase $searchBase `
                        -Credential $global:AD_credential `
                        -ResultSetSize 1 `
                        -ErrorAction SilentlyContinue
                    $isAvailable = ($null -eq $obj)
                    Send-Json -Body "{`"available`":$(if ($isAvailable) { 'true' } else { 'false' })}"
                }
            } catch {
                $errMsg = $_.Exception.Message -replace '"', "'"
                Send-Json -Body "{`"error`":`"$errMsg`"}"
            }
        }

        # ==================== API — Règles : prévisualisation des groupes ====================
        Add-PodeRoute -Method Post -Path '/api/regles/preview-groups' -ScriptBlock {
            try {
                $rule = ConvertFrom-Json $WebEvent.Request.Body
                $allUsers = @(Get-AllUsersFromCache)
                if ($allUsers.Count -eq 0) {
                    Send-Json -Body '{"error":"Cache JSON vide — ouvrez l'"'"'Explorateur AD et cliquez sur ↻ Cache."}'
                } else {
                    $lbl        = if ($rule.prefix) { Clean-ForFileName $rule.prefix } else { Clean-ForFileName $rule.label }
                    $mailDomain = $global:parametresJson.ad.mailDomain
                    if ($rule.invertOf) {
                        $rPath   = Join-Path ($global:path."r_settings" -replace '/', '\') "regles.json"
                        $srcRule = @(ConvertFrom-Json ([System.IO.File]::ReadAllText($rPath, [System.Text.Encoding]::UTF8))) | Where-Object { $_.id -eq $rule.invertOf } | Select-Object -First 1
                        if (-not $srcRule) {
                            Send-Json -Body '{"error":"Règle source introuvable pour le calcul inverse."}'
                            return
                        }
                        $srcIds  = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
                        @($allUsers | Where-Object { Test-UserMatchesRule -User $_ -Conditions $srcRule.conditions }) | ForEach-Object { [void]$srcIds.Add($_.samAccountName) }
                        $filtered = @($allUsers | Where-Object { -not $srcIds.Contains($_.samAccountName) })
                    } else {
                        $filtered = @($allUsers | Where-Object { Test-UserMatchesRule -User $_ -Conditions $rule.conditions })
                    }
                    $filtered   = @($filtered | Where-Object { -not (Test-UserExcluded $_) })
                    $groups     = [System.Collections.Generic.List[hashtable]]::new()

                    if ($rule.niveau -eq 3) {
                        # Hiérarchie complète pour la prévisualisation (monoNiveau n'affecte que la génération CSV)
                        $byDO = $filtered | Group-Object { Get-RegionFromDN $_.dn } | Where-Object { $_.Name -and $_.Name -ne 'MONCHY' }
                        foreach ($doGrp in $byDO) {
                            $doName      = if ($doGrp.Name) { $doGrp.Name } else { 'SANS-DO' }
                            $doClean     = Clean-ForFileName $doName
                            $doBase      = "$lbl-$doClean"
                            $regionCfg   = $global:parametresJson.ad.regions | Where-Object { $_.label -eq $doName } | Select-Object -First 1
                            $isMultiBase = ($null -ne $regionCfg -and @($regionCfg.bases).Count -gt 1)
                            foreach ($cGrp in ($doGrp.Group | Group-Object { Get-CentreFromDN $_.dn })) {
                                $cName  = if ($cGrp.Name) { $cGrp.Name } else { 'SANS-CENTRE' }
                                $cClean = Clean-ForFileName $cName
                                $cBase  = "$lbl-$doClean-$cClean"
                                $baseLabel = ''
                                if ($isMultiBase) {
                                    $firstUser = $cGrp.Group | Select-Object -First 1
                                    if ($firstUser -and $firstUser.dn) {
                                        foreach ($base in $regionCfg.bases) {
                                            if ($firstUser.dn -like "*,$base") {
                                                if ($base -match '^OU=([^,]+)') { $baseLabel = $Matches[1] }
                                                break
                                            }
                                        }
                                    }
                                }
                                $centreMembers = @($cGrp.Group | Sort-Object displayName | ForEach-Object {
                                    [ordered]@{
                                        name  = if ($_.displayName) { "$($_.displayName)" } else { "$($_.samAccountName)" }
                                        title = if ($_.title)       { "$($_.title)"        } else { '' }
                                    }
                                })
                                $groups.Add(@{ name = $cBase; mail = "$($cBase.ToLower())@$mailDomain"; type = 'centre'; count = $cGrp.Group.Count; members = $centreMembers; baseLabel = $baseLabel })
                            }
                            $groups.Add(@{ name = $doBase; mail = "$($doBase.ToLower())@$mailDomain"; type = 'do'; count = $doGrp.Group.Count; multiBase = $isMultiBase })
                        }
                        $groups.Add(@{ name = $lbl; mail = "$($lbl.ToLower())@$mailDomain"; type = 'global'; count = $filtered.Count })
                    } elseif ($rule.niveau -eq 2) {
                        $byDO = $filtered | Group-Object { Get-RegionFromDN $_.dn } | Where-Object { $_.Name -and $_.Name -ne 'MONCHY' }
                        foreach ($doGrp in $byDO) {
                            $doName      = if ($doGrp.Name) { $doGrp.Name } else { 'SANS-DO' }
                            $doClean     = Clean-ForFileName $doName
                            $doBase      = "$lbl-$doClean"
                            $regionCfg   = $global:parametresJson.ad.regions | Where-Object { $_.label -eq $doName } | Select-Object -First 1
                            $isMultiBase = ($null -ne $regionCfg -and @($regionCfg.bases).Count -gt 1)
                            $doMembers = @($doGrp.Group | Sort-Object displayName | ForEach-Object {
                                [ordered]@{
                                    name  = if ($_.displayName) { "$($_.displayName)" } else { "$($_.samAccountName)" }
                                    title = if ($_.title)       { "$($_.title)"        } else { '' }
                                }
                            })
                            $groups.Add(@{ name = $doBase; mail = "$($doBase.ToLower())@$mailDomain"; type = 'do'; count = $doGrp.Group.Count; members = $doMembers; multiBase = $isMultiBase })
                        }
                        $groups.Add(@{ name = $lbl; mail = "$($lbl.ToLower())@$mailDomain"; type = 'global'; count = $filtered.Count })
                    } else {
                        $globalMembers = @($filtered | Sort-Object displayName | ForEach-Object {
                            [ordered]@{
                                name  = if ($_.displayName) { "$($_.displayName)" } else { "$($_.samAccountName)" }
                                title = if ($_.title)       { "$($_.title)"        } else { '' }
                            }
                        })
                        $groups.Add(@{ name = $lbl; mail = "$($lbl.ToLower())@$mailDomain"; type = 'global'; count = $filtered.Count; members = $globalMembers })
                    }

                    $cacheTs = ''
                    $gcp     = Get-GlobalUsersCachePath
                    if (Test-Path $gcp) { $cacheTs = ([System.IO.FileInfo]$gcp).LastWriteTime.ToString('dd/MM/yyyy HH:mm') }
                    $result = [PSCustomObject]@{
                        prefix     = $lbl
                        mailDomain = $mailDomain
                        total      = $filtered.Count
                        niveau     = [int]$rule.niveau
                        monoNiveau = ($rule.monoNiveau -eq $true)
                        cacheTs    = $cacheTs
                        groups     = @($groups)
                    }
                    Send-Json -Body (ConvertTo-Json -InputObject $result -Depth 5 -Compress)
                }
            } catch {
                $errMsg = $_.Exception.Message -replace '"', "'"
                Send-Json -Body "{`"error`":`"$errMsg`"}"
            }
        }

        # ==================== API — Règles : génération PAIR (règle + inverse) ====================
        Add-PodeRoute -Method Post -Path '/api/regles/generate-pair' -ScriptBlock {
            try {
                $rule     = ConvertFrom-Json $WebEvent.Request.Body
                $allUsers = @(Get-AllUsersFromCache)
                if ($allUsers.Count -eq 0) {
                    Send-Json -Body '{"ok":false,"error":"Cache vide — ouvrez l''Explorateur AD et cliquez sur ↻ Cache."}'
                } else {
                    $rPath  = Join-Path ($global:path."r_settings" -replace '/', '\') "regles.json"
                    $regles = if (Test-Path $rPath) { @(ConvertFrom-Json ([System.IO.File]::ReadAllText($rPath, [System.Text.Encoding]::UTF8))) } else { @() }

                    $peerRule = if ($rule.invertOf) {
                        $regles | Where-Object { $_.id -eq $rule.invertOf } | Select-Object -First 1
                    } else {
                        $regles | Where-Object { $_.invertOf -eq $rule.id } | Select-Object -First 1
                    }

                    $outDir   = Get-RunOutputDir -Label 'PAIR'
                    $allFiles = [System.Collections.Generic.List[string]]::new()

                    foreach ($r in @($rule, $peerRule)) {
                        if (-not $r) { continue }
                        $lbl = if ($r.prefix) { Clean-ForFileName $r.prefix } else { Clean-ForFileName $r.label }

                        if ($r.invertOf) {
                            $srcRule = $regles | Where-Object { $_.id -eq $r.invertOf } | Select-Object -First 1
                            if (-not $srcRule) { continue }
                            $srcIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
                            @($allUsers | Where-Object { Test-UserMatchesRule -User $_ -Conditions $srcRule.conditions }) | ForEach-Object { [void]$srcIds.Add($_.samAccountName) }
                            $filtered = @($allUsers | Where-Object { -not $srcIds.Contains($_.samAccountName) })
                        } else {
                            $filtered = @($allUsers | Where-Object { Test-UserMatchesRule -User $_ -Conditions $r.conditions })
                        }
                        $filtered = @($filtered | Where-Object { -not (Test-UserExcluded $_) })

                        $niveau = if ($r.niveau) { [int]$r.niveau } else { 3 }

                        $utf8Bom = New-Object System.Text.UTF8Encoding($true)

                        if ($niveau -ge 3) {
                            $byDO = $filtered | Group-Object { Get-RegionFromDN $_.dn } | Where-Object { $_.Name -and $_.Name -ne 'MONCHY' }
                            foreach ($doGrp in $byDO) {
                                $doClean = Clean-ForFileName $doGrp.Name
                                $doBase  = "$lbl-$doClean"
                                foreach ($cGrp in ($doGrp.Group | Group-Object { Get-CentreFromDN $_.dn })) {
                                    $cClean  = Clean-ForFileName $cGrp.Name
                                    $cBase   = "$lbl-$doClean-$cClean"
                                    $cLines  = [System.Collections.Generic.List[string]]::new()
                                    $cLines.Add("samAccountName;mail")
                                    foreach ($u in ($cGrp.Group | Sort-Object samAccountName)) { $cLines.Add("$($u.samAccountName);$($u.mail)") }
                                    $cPath = Join-Path $outDir "$cBase.csv"
                                    [System.IO.File]::WriteAllText($cPath, ($cLines -join "`r`n"), $utf8Bom)
                                    [void]$allFiles.Add($cPath)
                                }
                                $doLines = [System.Collections.Generic.List[string]]::new()
                                $doLines.Add("samAccountName;mail")
                                foreach ($u in ($doGrp.Group | Sort-Object samAccountName)) { $doLines.Add("$($u.samAccountName);$($u.mail)") }
                                $doPath = Join-Path $outDir "$doBase.csv"
                                [System.IO.File]::WriteAllText($doPath, ($doLines -join "`r`n"), $utf8Bom)
                                [void]$allFiles.Add($doPath)
                            }
                        } elseif ($niveau -eq 2) {
                            $byDO = $filtered | Group-Object { Get-RegionFromDN $_.dn } | Where-Object { $_.Name -and $_.Name -ne 'MONCHY' }
                            foreach ($doGrp in $byDO) {
                                $doClean = Clean-ForFileName $doGrp.Name
                                $doBase  = "$lbl-$doClean"
                                $doLines = [System.Collections.Generic.List[string]]::new()
                                $doLines.Add("samAccountName;mail")
                                foreach ($u in ($doGrp.Group | Sort-Object samAccountName)) { $doLines.Add("$($u.samAccountName);$($u.mail)") }
                                $doPath = Join-Path $outDir "$doBase.csv"
                                [System.IO.File]::WriteAllText($doPath, ($doLines -join "`r`n"), $utf8Bom)
                                [void]$allFiles.Add($doPath)
                            }
                        }
                        $glLines = [System.Collections.Generic.List[string]]::new()
                        $glLines.Add("samAccountName;mail")
                        foreach ($u in ($filtered | Sort-Object samAccountName)) { $glLines.Add("$($u.samAccountName);$($u.mail)") }
                        $glPath = Join-Path $outDir "$lbl.csv"
                        [System.IO.File]::WriteAllText($glPath, ($glLines -join "`r`n"), $utf8Bom)
                        [void]$allFiles.Add($glPath)
                    }

                    $resultJson = ConvertTo-Json -InputObject @{ ok = $true; outDir = $outDir; files = @($allFiles); total = $allFiles.Count } -Compress
                    Send-Json -Body $resultJson
                }
            } catch {
                $errMsg = $_.Exception.Message -replace '"', "'"
                Send-Json -Body "{`"ok`":false,`"error`":`"$errMsg`"}"
            }
        }

        # ==================== API — Valeurs de champ AD ====================
        Add-PodeRoute -Method Get -Path '/api/ad/values' -ScriptBlock {
            $field = $WebEvent.Query['field']
            if (-not $field) {
                Send-Json -Body '[]'
            } else {
                $values = Get-ADFieldValues -Field $field
                Send-Json -Body (ConvertTo-Json -InputObject @($values) -Depth 2 -Compress)
            }
        }
    }
}

# =============================================================================
#  Helpers de réponse (Pode)
# =============================================================================

function Send-Json {
    # Pode ajoute lui-même "; charset=utf-8" au ContentType → le passer nu (sinon doublon).
    param([string]$Body, [int]$StatusCode = 200)
    if ([string]::IsNullOrEmpty($Body) -or $Body -eq 'null') { $Body = '[]' }
    Write-PodeTextResponse -Value $Body -ContentType 'application/json' -StatusCode $StatusCode
}

function Serve-File {
    param([string]$Key, [string]$ContentType)

    $filePath = $global:path.$Key
    if (-not $filePath -or -not (Test-Path $filePath)) {
        Send-Json -Body "{`"error`":`"File not found: $Key`"}" -StatusCode 404
        return
    }
    $bytes = [System.IO.File]::ReadAllBytes($filePath)
    Add-PodeHeader -Name 'Cache-Control' -Value 'no-cache, no-store, must-revalidate'
    Write-PodeTextResponse -Bytes $bytes -ContentType $ContentType
}

# =============================================================================
#  Helpers cache / valeurs — conservés à l'identique (indépendants de Pode)
# =============================================================================

function Start-CacheWarmup {
    $runspace = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
    $runspace.Open()
    $runspace.SessionStateProxy.SetVariable('gParametresJson', $global:parametresJson)
    $runspace.SessionStateProxy.SetVariable('gCredential',     $global:AD_credential)
    $runspace.SessionStateProxy.SetVariable('gPath',           $global:path)

    $ps = [System.Management.Automation.PowerShell]::Create()
    $ps.Runspace = $runspace
    $ps.AddScript({
        $global:parametresJson = $gParametresJson
        $global:AD_credential  = $gCredential
        $global:path           = $gPath

        function add-msg { param([string]$msg, $foregroundColor, $quelType)
            if ($msg.Trim()) { [Console]::WriteLine("  [Cache] $msg") }
        }

        Import-Module $gPath."f_ad-reader.psm1" -Force -ErrorAction SilentlyContinue

        $scriptsDir = Split-Path $gPath."r_settings" -Parent
        $cacheDir   = Join-Path $scriptsDir "cache"
        if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }

        function Get-LocalCachePath([string]$DN) {
            $firstOU  = if ($DN -match '^OU=([^,]+)') { $Matches[1] -replace '[^\w-]','_' } else { 'site' }
            $checksum = 0
            foreach ($c in $DN.ToCharArray()) { $checksum = ($checksum * 31 + [int][char]$c) -band 0x7FFFFFFF }
            return Join-Path $cacheDir "${firstOU}_${checksum}.json"
        }

        $indexPath = Join-Path $cacheDir "_index.json"
        function Update-LocalIndex([string]$DN, [int]$Count) {
            for ($i = 0; $i -lt 5; $i++) {
                try {
                    $map = if (Test-Path $indexPath) {
                        $ht = @{}
                        (ConvertFrom-Json ([System.IO.File]::ReadAllText($indexPath, [System.Text.Encoding]::UTF8))).PSObject.Properties | ForEach-Object { $ht[$_.Name] = $_.Value }
                        $ht
                    } else { @{} }
                    $map[$DN] = $Count
                    $json = ConvertTo-Json -InputObject ([PSCustomObject]$map) -Compress
                    [System.IO.File]::WriteAllText($indexPath, $json, [System.Text.Encoding]::UTF8)
                    return
                } catch [System.IO.IOException] {
                    Start-Sleep -Milliseconds 50
                }
            }
        }

        $tree  = Get-OUTree
        $sites = @($tree | ForEach-Object { $_.children } | Where-Object { $_ })
        $total = $sites.Count
        [Console]::WriteLine("")
        [Console]::WriteLine("  [Cache] Warmup demarre - " + $total + " sites")

        $done = 0
        foreach ($site in $sites) {
            $cp = Get-LocalCachePath -DN $site.dn
            if (Test-Path $cp) {
                $done++
                continue
            }
            try {
                $list = [System.Collections.ArrayList]@(Get-OUSiteUsers -SiteDN $site.dn)
                $json = ConvertTo-Json -InputObject $list -Depth 5 -Compress
                [System.IO.File]::WriteAllText($cp, $json, [System.Text.Encoding]::UTF8)
                Update-LocalIndex -DN $site.dn -Count $list.Count
                $done++
                [Console]::WriteLine("  [Cache] [" + $done + "/" + $total + "] " + $site.name + " (" + $list.Count + " users)")
            } catch {
                [Console]::WriteLine("  [Cache] ERR " + $site.name + " : " + $_.Exception.Message)
            }
        }
        [Console]::WriteLine("  [Cache] Warmup termine - " + $done + "/" + $total + " sites")
        [Console]::WriteLine("")

        # Construction du cache global utilisateurs (source de vérité pour Règles)
        $globalCachePath = Join-Path $cacheDir "_users_global.json"
        if (-not (Test-Path $globalCachePath)) {
            try {
                Import-Module $gPath."f_ad-reader.psm1" -Force -ErrorAction SilentlyContinue
                $count = Build-GlobalUsersCache
                [Console]::WriteLine("  [Cache] Cache global utilisateurs : $count utilisateurs")
            } catch {
                [Console]::WriteLine("  [Cache] ERR cache global : " + $_.Exception.Message)
            }
        } else {
            [Console]::WriteLine("  [Cache] Cache global utilisateurs deja present.")
        }
    }) | Out-Null

    $ps.BeginInvoke() | Out-Null
    add-msg -msg "Cache warmup demarre en arriere-plan..." -foregroundColor Cyan
}

function Get-CacheIndexPath {
    $scriptsDir = Split-Path $global:path."r_settings" -Parent
    $cacheDir   = Join-Path $scriptsDir "cache"
    if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
    return Join-Path $cacheDir "_index.json"
}

function Update-CacheIndex {
    param([string]$DN, [int]$Count)
    $idx = Get-CacheIndexPath
    for ($i = 0; $i -lt 5; $i++) {
        try {
            $map = if (Test-Path $idx) {
                $raw = [System.IO.File]::ReadAllText($idx, [System.Text.Encoding]::UTF8)
                $obj = ConvertFrom-Json $raw
                $ht  = @{}
                $obj.PSObject.Properties | ForEach-Object { $ht[$_.Name] = $_.Value }
                $ht
            } else { @{} }
            $map[$DN] = $Count
            $json = ConvertTo-Json -InputObject ([PSCustomObject]$map) -Compress
            [System.IO.File]::WriteAllText($idx, $json, [System.Text.Encoding]::UTF8)
            return
        } catch [System.IO.IOException] {
            Start-Sleep -Milliseconds 50
        }
    }
}

function Get-OUCachePath {
    param([string]$DN)
    $scriptsDir = Split-Path $global:path."r_settings" -Parent
    $cacheDir   = Join-Path $scriptsDir "cache"
    if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }

    $firstOU  = if ($DN -match '^OU=([^,]+)') { $Matches[1] -replace '[^\w-]', '_' } else { 'site' }
    $checksum = 0
    foreach ($c in $DN.ToCharArray()) { $checksum = ($checksum * 31 + [int][char]$c) -band 0x7FFFFFFF }
    return Join-Path $cacheDir "${firstOU}_${checksum}.json"
}

function Get-ADFieldValues {
    param([string]$Field)

    # Champ "OU" : mêmes sites (A#####) que l'arborescence de l'Explorateur,
    # lus depuis le cache OUs via Get-OUTree.
    if ($Field -eq 'ou') {
        $sites = [System.Collections.Generic.List[string]]::new()
        foreach ($region in @(Get-OUTree)) {
            foreach ($site in @($region.children)) {
                if ($site.name) { [void]$sites.Add("$($site.name)") }
            }
        }
        return @($sites | Sort-Object -Unique)
    }

    $scriptsDir = Split-Path ($global:path."r_settings" -replace '/', '\') -Parent
    $cacheDir   = Join-Path $scriptsDir "cache"
    if (-not (Test-Path $cacheDir)) { return @() }
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($f in @(Get-ChildItem -Path $cacheDir -Filter "*.json" -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne '_index.json' })) {
        try {
            $users = ConvertFrom-Json ([System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8))
            foreach ($u in $users) {
                $v = $u.$Field
                if ($v -and "$v" -ne '') { [void]$seen.Add("$v") }
            }
        } catch { }
    }
    return @($seen | Sort-Object)
}

function Get-ReglesPath {
    $dir = ($global:path."r_settings") -replace '/', '\'
    return Join-Path $dir "regles.json"
}
