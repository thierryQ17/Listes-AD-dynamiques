function Start-HttpServer {
    param([int]$Port = 8080)

    $listener = [System.Net.HttpListener]::new()
    $listener.Prefixes.Add("http://localhost:$Port/")

    try {
        $listener.Start()
    } catch {
        add-msg -msg "Impossible de démarrer le serveur sur le port $Port : $($_.Exception.Message)" -foregroundColor Red
        return
    }

    add-msg -msg "Serveur HTTP actif : http://localhost:$Port" -foregroundColor Green

    try {
        while ($listener.IsListening) {
            $context  = $listener.GetContext()
            $request  = $context.Request
            $response = $context.Response
            $response.Headers.Add("Access-Control-Allow-Origin", "*")

            $url    = $request.Url.LocalPath
            $method = $request.HttpMethod

            try {
                Invoke-RouteHandler -Request $request -Response $response -Url $url -Method $method
            } catch {
                add-msg -msg "Erreur route '$url' : $($_.Exception.Message)" -foregroundColor Red
                try {
                    $response.StatusCode = 500
                    $errBytes = [System.Text.Encoding]::UTF8.GetBytes('{"error":"Internal server error"}')
                    $response.ContentType      = "application/json; charset=utf-8"
                    $response.ContentLength64  = $errBytes.Length
                    $response.OutputStream.Write($errBytes, 0, $errBytes.Length)
                } catch { }
            } finally {
                try { $response.OutputStream.Close() } catch {}
            }
        }
    } finally {
        $listener.Stop()
        add-msg -msg "Serveur arrêté." -foregroundColor Yellow
    }
}

function Invoke-RouteHandler {
    param($Request, $Response, [string]$Url, [string]$Method)

    add-msg -msg "$Method $Url" -foregroundColor DarkGray -quelType writeHost

    switch -Regex ($Url) {
        '^(/|/shell(\.html)?)$' {
            Serve-StaticFile -Response $Response -Key "f_shell.html" -ContentType "text/html"
        }
        '^/groupes(\.html)?$' {
            Serve-StaticFile -Response $Response -Key "f_index.html" -ContentType "text/html"
        }
        '^/index\.html$' {
            $Response.StatusCode = 302
            $Response.Headers.Add("Location", "/groupes")
        }
        '^/app\.js$' {
            Serve-StaticFile -Response $Response -Key "f_app.js" -ContentType "application/javascript"
        }
        '^/style\.css$' {
            Serve-StaticFile -Response $Response -Key "f_style.css" -ContentType "text/css"
        }
        '^/api/groups$' {
            $data = Get-I2NGroups | ConvertTo-Json -Depth 3 -Compress
            Send-JsonResponse -Response $Response -Body $data
        }
        '^/api/group/members$' {
            $dn   = [uri]::UnescapeDataString($Request.QueryString["dn"])
            $data = Get-I2NGroupMembers -GroupDN $dn | ConvertTo-Json -Depth 3 -Compress
            Send-JsonResponse -Response $Response -Body $data
        }
        '^/api/search$' {
            $q    = if ($Request.QueryString["q"])    { $Request.QueryString["q"] }    else { '' }
            $type = if ($Request.QueryString["type"]) { $Request.QueryString["type"] } else { 'both' }
            $data = Search-ADObjects -Query $q -Type $type | ConvertTo-Json -Depth 3 -Compress
            Send-JsonResponse -Response $Response -Body $data
        }
        '^/explorer(\.html)?$' {
            Serve-StaticFile -Response $Response -Key "f_explorer.html" -ContentType "text/html"
        }
        '^/regles(\.html)?$' {
            Serve-StaticFile -Response $Response -Key "f_regles.html" -ContentType "text/html"
        }
        '^/regles\.js$' {
            Serve-StaticFile -Response $Response -Key "f_regles.js" -ContentType "application/javascript"
        }
        '^/regles\.css$' {
            Serve-StaticFile -Response $Response -Key "f_regles.css" -ContentType "text/css"
        }
        '^/explorer\.js$' {
            Serve-StaticFile -Response $Response -Key "f_explorer.js" -ContentType "application/javascript"
        }
        '^/explorer\.css$' {
            Serve-StaticFile -Response $Response -Key "f_explorer.css" -ContentType "text/css"
        }
        '^/api/cache/counts$' {
            $idx  = Get-CacheIndexPath
            $data = if (Test-Path $idx) { [System.IO.File]::ReadAllText($idx, [System.Text.Encoding]::UTF8) } else { '{}' }
            Send-JsonResponse -Response $Response -Body $data
        }
        '^/api/cache/info$' {
            $gPath    = Get-GlobalUsersCachePath
            $builtAt  = if (Test-Path $gPath) { (Get-Item $gPath).LastWriteTime.ToString('yyyy-MM-ddTHH:mm:ss') } else { $null }
            $nullStr  = 'null'
            $body     = if ($builtAt) { "{`"builtAt`":`"$builtAt`"}" } else { "{`"builtAt`":$nullStr}" }
            Send-JsonResponse -Response $Response -Body $body
        }
        '^/api/cache/refresh-all$' {
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
            Send-JsonResponse -Response $Response -Body "{`"ok`":true,`"deleted`":$deleted}"
        }
        '^/api/tree$' {
            $treeList = [System.Collections.ArrayList]@(Get-OUTree)
            $data = ConvertTo-Json -InputObject $treeList -Depth 5 -Compress
            Send-JsonResponse -Response $Response -Body $data
        }
        '^/api/ou/users$' {
            $dn    = [uri]::UnescapeDataString($Request.QueryString["dn"])
            $fresh = $Request.QueryString["fresh"] -eq '1'
            $cachePath = Get-OUCachePath -DN $dn

            if (-not $fresh -and (Test-Path $cachePath)) {
                $data = [System.IO.File]::ReadAllText($cachePath, [System.Text.Encoding]::UTF8)
                $Response.Headers.Add("X-Cache", "HIT")
                add-msg -msg "  → cache HIT : $dn" -foregroundColor DarkGray -quelType writeHost
            } else {
                $userList = [System.Collections.ArrayList]@(Get-OUSiteUsers -SiteDN $dn)
                $data     = ConvertTo-Json -InputObject $userList -Depth 5 -Compress
                [System.IO.File]::WriteAllText($cachePath, $data, [System.Text.Encoding]::UTF8)
                Update-CacheIndex -DN $dn -Count $userList.Count
                $Response.Headers.Add("X-Cache", "MISS")
                add-msg -msg "  → cache MISS (écrit) : $dn" -foregroundColor DarkGray -quelType writeHost
            }
            Send-JsonResponse -Response $Response -Body $data
        }
        '^/api/regles$' {
            $rPath = Get-ReglesPath
            if ($Method -eq 'GET') {
                $data = if (Test-Path $rPath) { [System.IO.File]::ReadAllText($rPath, [System.Text.Encoding]::UTF8) } else { '[]' }
                Send-JsonResponse -Response $Response -Body $data
            } elseif ($Method -eq 'POST') {
                $rule   = ConvertFrom-Json (Read-RequestBody -Request $Request)
                $regles = if (Test-Path $rPath) { @(ConvertFrom-Json ([System.IO.File]::ReadAllText($rPath, [System.Text.Encoding]::UTF8))) } else { @() }
                $idx    = -1
                for ($i = 0; $i -lt $regles.Count; $i++) { if ($regles[$i].id -eq $rule.id) { $idx = $i; break } }
                if ($idx -ge 0) {
                    $stored = $regles[$idx]
                    $regles[$idx] = $rule
                    # Préserver les champs non gérés par le formulaire (ex. invertOf)
                    if ($stored.PSObject.Properties['invertOf'] -and -not $rule.PSObject.Properties['invertOf']) {
                        $regles[$idx] | Add-Member -NotePropertyName 'invertOf' -NotePropertyValue $stored.invertOf -Force
                    }
                } else { $regles += $rule }
                [System.IO.File]::WriteAllText($rPath, (ConvertTo-Json -InputObject @($regles) -Depth 10 -Compress), [System.Text.Encoding]::UTF8)
                Send-JsonResponse -Response $Response -Body '{"ok":true}'
            }
        }
        '^/api/users/cache-info$' {
            $cachePath = Get-GlobalUsersCachePath
            if (Test-Path $cachePath) {
                $fi    = [System.IO.FileInfo]$cachePath
                $count = @(Get-AllUsersFromCache).Count
                $ts    = $fi.LastWriteTime.ToString('dd/MM/yyyy HH:mm')
                Send-JsonResponse -Response $Response -Body "{`"ok`":true,`"count`":$count,`"ts`":`"$ts`"}"
            } else {
                Send-JsonResponse -Response $Response -Body '{"ok":false,"count":0,"ts":""}'
            }
        }
        '^/api/users/preload$' {
            if ($Method -eq 'POST') {
                try {
                    $count = Build-GlobalUsersCache
                    Send-JsonResponse -Response $Response -Body "{`"ok`":true,`"count`":$count}"
                } catch {
                    $errMsg = $_.Exception.Message -replace '"', "'"
                    Send-JsonResponse -Response $Response -Body "{`"ok`":false,`"error`":`"$errMsg`"}"
                }
            }
        }
        '^/api/users/preload/status$' {
            $cachePath = Get-GlobalUsersCachePath
            $cached = Test-Path $cachePath
            $count  = if ($cached) { @(Get-AllUsersFromCache).Count } else { 0 }
            Send-JsonResponse -Response $Response -Body "{`"cached`":$(if($cached){'true'}else{'false'}),`"count`":$count}"
        }
        '^/api/csv/read$' {
            $dir  = [uri]::UnescapeDataString($Request.QueryString["dir"])
            $file = [uri]::UnescapeDataString($Request.QueryString["file"])
            $settingsDir = $global:path."r_settings" -replace '/', '\'
            $baseDir     = Join-Path (Split-Path (Split-Path $settingsDir -Parent) -Parent) "application\output"
            $resolved    = [System.IO.Path]::GetFullPath((Join-Path $dir $file))
            if (-not $resolved.StartsWith($baseDir)) {
                $Response.StatusCode = 403
                Send-JsonResponse -Response $Response -Body '{"error":"Chemin non autorisé"}'
            } elseif (-not (Test-Path $resolved)) {
                $Response.StatusCode = 404
                Send-JsonResponse -Response $Response -Body '{"error":"Fichier introuvable"}'
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
                Send-JsonResponse -Response $Response -Body (ConvertTo-Json -InputObject @($rows) -Depth 2 -Compress)
            }
        }
        '^/api/regles/preview-groups$' {
            if ($Method -eq 'POST') {
                try {
                    $rule = ConvertFrom-Json (Read-RequestBody -Request $Request)
                    $allUsers = @(Get-AllUsersFromCache)
                    if ($allUsers.Count -eq 0) {
                        Send-JsonResponse -Response $Response -Body '{"error":"Cache JSON vide — ouvrez l'"'"'Explorateur AD et cliquez sur ↻ Cache."}'
                    } else {
                        $lbl        = if ($rule.prefix) { Clean-ForFileName $rule.prefix } else { Clean-ForFileName $rule.label }
                        $mailDomain = $global:parametresJson.ad.mailDomain
                        if ($rule.invertOf) {
                            $rPath   = Join-Path ($global:path."r_settings" -replace '/', '\') "regles.json"
                            $srcRule = @(ConvertFrom-Json ([System.IO.File]::ReadAllText($rPath, [System.Text.Encoding]::UTF8))) | Where-Object { $_.id -eq $rule.invertOf } | Select-Object -First 1
                            if (-not $srcRule) {
                                Send-JsonResponse -Response $Response -Body '{"error":"Règle source introuvable pour le calcul inverse."}'
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
                        Send-JsonResponse -Response $Response -Body (ConvertTo-Json -InputObject $result -Depth 5 -Compress)
                    }
                } catch {
                    $errMsg = $_.Exception.Message -replace '"', "'"
                    Send-JsonResponse -Response $Response -Body "{`"error`":`"$errMsg`"}"
                }
            }
        }
        '^/api/regles/generate-pair$' {
            if ($Method -eq 'POST') {
                try {
                    $rule     = ConvertFrom-Json (Read-RequestBody -Request $Request)
                    $allUsers = @(Get-AllUsersFromCache)
                    if ($allUsers.Count -eq 0) {
                        Send-JsonResponse -Response $Response -Body '{"ok":false,"error":"Cache vide — ouvrez l''Explorateur AD et cliquez sur ↻ Cache."}'
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
                        Send-JsonResponse -Response $Response -Body $resultJson
                    }
                } catch {
                    $errMsg = $_.Exception.Message -replace '"', "'"
                    Send-JsonResponse -Response $Response -Body "{`"ok`":false,`"error`":`"$errMsg`"}"
                }
            }
        }
        '^/api/output/list$' {
            $settingsDir = $global:path."r_settings" -replace '/', '\'
            $outputDir   = [System.IO.Path]::GetFullPath((Join-Path (Split-Path (Split-Path $settingsDir -Parent) -Parent) "application\output"))
            $runs        = [System.Collections.Generic.List[PSCustomObject]]::new()
            if (Test-Path $outputDir) {
                foreach ($d in (Get-ChildItem -Path $outputDir -Directory | Sort-Object Name -Descending)) {
                    $csvFiles = @(Get-ChildItem -Path $d.FullName -Filter "*.csv" -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object { $_.Name })
                    $runs.Add([PSCustomObject]@{ run = $d.Name; path = $d.FullName; files = $csvFiles })
                }
            }
            Send-JsonResponse -Response $Response -Body (ConvertTo-Json -InputObject @($runs) -Depth 3 -Compress)
        }
        '^/api/output/read$' {
            $reqPath    = [uri]::UnescapeDataString($Request.QueryString["path"])
            $settingsDir = $global:path."r_settings" -replace '/', '\'
            $normalBase = [System.IO.Path]::GetFullPath((Join-Path (Split-Path (Split-Path $settingsDir -Parent) -Parent) "application\output")).TrimEnd('\') + '\'
            $resolved   = [System.IO.Path]::GetFullPath($reqPath)
            if (-not $resolved.StartsWith($normalBase, [System.StringComparison]::OrdinalIgnoreCase)) {
                $Response.StatusCode = 403
                Send-JsonResponse -Response $Response -Body '{"error":"Chemin non autorisé"}'
            } elseif (-not (Test-Path $resolved)) {
                $Response.StatusCode = 404
                Send-JsonResponse -Response $Response -Body '{"error":"Fichier introuvable"}'
            } else {
                $lines = @([System.IO.File]::ReadAllLines($resolved, [System.Text.Encoding]::UTF8))
                if ($lines.Count -eq 0) {
                    Send-JsonResponse -Response $Response -Body '{"headers":[],"rows":[]}'
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
                    Send-JsonResponse -Response $Response -Body (ConvertTo-Json -InputObject $result -Depth 4 -Compress)
                }
            }
        }
        '^/api/regles/check-mail$' {
            if ($Method -eq 'POST') {
                try {
                    $body = ConvertFrom-Json (Read-RequestBody -Request $Request)
                    $addr = if ($body.address) { "$($body.address)".Trim() } else { '' }
                    if (-not $addr) {
                        Send-JsonResponse -Response $Response -Body '{"error":"Adresse manquante"}'
                    } else {
                        $searchBase = $global:parametresJson.ad.searchBase
                        $ldapFilter = "(|(mail=$addr)(proxyAddresses=*:$addr))"
                        $obj = Get-ADObject -LDAPFilter $ldapFilter `
                            -SearchBase $searchBase `
                            -Credential $global:AD_credential `
                            -ResultSetSize 1 `
                            -ErrorAction SilentlyContinue
                        $isAvailable = ($null -eq $obj)
                        Send-JsonResponse -Response $Response -Body "{`"available`":$(if ($isAvailable) { 'true' } else { 'false' })}"
                    }
                } catch {
                    $errMsg = $_.Exception.Message -replace '"', "'"
                    Send-JsonResponse -Response $Response -Body "{`"error`":`"$errMsg`"}"
                }
            }
        }
        '^/api/regles/([^/]+)/generate$' {
            $id    = [uri]::UnescapeDataString($Matches[1])
            $rPath = Get-ReglesPath
            if ($Method -eq 'POST') {
                $regles = if (Test-Path $rPath) { @(ConvertFrom-Json ([System.IO.File]::ReadAllText($rPath, [System.Text.Encoding]::UTF8))) } else { @() }
                $rule   = $regles | Where-Object { $_.id -eq $id } | Select-Object -First 1
                if (-not $rule) {
                    $Response.StatusCode = 404
                    Send-JsonResponse -Response $Response -Body '{"error":"Règle introuvable"}'
                } else {
                    try {
                        $result     = Invoke-RuleGeneration -Rule $rule
                        $resultJson = ConvertTo-Json -InputObject $result -Depth 5 -Compress
                        Send-JsonResponse -Response $Response -Body $resultJson
                    } catch {
                        add-msg -msg "  [CSV] ERREUR : $($_.Exception.Message)" -foregroundColor Red -quelType writeHost
                        $errMsg = ($_.Exception.Message -replace '[\r\n\t]', ' ' -replace '"', "'")
                        Send-JsonResponse -Response $Response -Body "{`"ok`":false,`"error`":`"$errMsg`"}"
                    }
                }
            }
        }
        '^/api/regles/([^/]+)$' {
            $id     = [uri]::UnescapeDataString($Matches[1])
            $rPath  = Get-ReglesPath
            if ($Method -eq 'DELETE') {
                $regles = if (Test-Path $rPath) { @(ConvertFrom-Json ([System.IO.File]::ReadAllText($rPath, [System.Text.Encoding]::UTF8))) } else { @() }
                $regles = @($regles | Where-Object { $_.id -ne $id })
                [System.IO.File]::WriteAllText($rPath, (ConvertTo-Json -InputObject @($regles) -Depth 10 -Compress), [System.Text.Encoding]::UTF8)
                Send-JsonResponse -Response $Response -Body '{"ok":true}'
            }
        }
        '^/api/ad/values$' {
            $field = $Request.QueryString["field"]
            if (-not $field) {
                Send-JsonResponse -Response $Response -Body '[]'
            } else {
                $values = Get-ADFieldValues -Field $field
                $data   = ConvertTo-Json -InputObject @($values) -Depth 2 -Compress
                Send-JsonResponse -Response $Response -Body $data
            }
        }
        default {
            $Response.StatusCode = 404
            Send-JsonResponse -Response $Response -Body '{"error":"Not found"}'
        }
    }
}

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
    # lus en direct dans l'AD via Get-OUTree — indépendant du cache utilisateurs.
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

function Read-RequestBody {
    param($Request)
    $reader = [System.IO.StreamReader]::new($Request.InputStream, [System.Text.Encoding]::UTF8)
    return $reader.ReadToEnd()
}

function Serve-StaticFile {
    param($Response, [string]$Key, [string]$ContentType)

    $filePath = $global:path.$Key
    if (-not $filePath -or -not (Test-Path $filePath)) {
        $Response.StatusCode = 404
        Send-JsonResponse -Response $Response -Body "{`"error`":`"File not found: $Key`"}"
        return
    }

    $bytes = [System.IO.File]::ReadAllBytes($filePath)
    $Response.ContentType     = "$ContentType; charset=utf-8"
    $Response.ContentLength64 = $bytes.Length
    $Response.Headers.Add("Cache-Control", "no-cache, no-store, must-revalidate")
    try { $Response.OutputStream.Write($bytes, 0, $bytes.Length) } catch { }
}

function Send-JsonResponse {
    param($Response, [string]$Body)

    if ([string]::IsNullOrEmpty($Body) -or $Body -eq 'null') { $Body = '[]' }
    $Response.ContentType = "application/json; charset=utf-8"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $Response.ContentLength64 = $bytes.Length
    try { $Response.OutputStream.Write($bytes, 0, $bytes.Length) } catch { }
}
