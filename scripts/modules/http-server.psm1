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
        '^(/|/index\.html)$' {
            $Response.StatusCode = 302
            $Response.Headers.Add("Location", "/explorer")
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
                if ($idx -ge 0) { $regles[$idx] = $rule } else { $regles += $rule }
                [System.IO.File]::WriteAllText($rPath, (ConvertTo-Json -InputObject @($regles) -Depth 10 -Compress), [System.Text.Encoding]::UTF8)
                Send-JsonResponse -Response $Response -Body '{"ok":true}'
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
                        $errMsg = $_.Exception.Message -replace '"', "'"
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
            $map = if (Test-Path $indexPath) {
                $ht = @{}
                (ConvertFrom-Json ([System.IO.File]::ReadAllText($indexPath, [System.Text.Encoding]::UTF8))).PSObject.Properties | ForEach-Object { $ht[$_.Name] = $_.Value }
                $ht
            } else { @{} }
            $map[$DN] = $Count
            $json = ConvertTo-Json -InputObject ([PSCustomObject]$map) -Compress
            [System.IO.File]::WriteAllText($indexPath, $json, [System.Text.Encoding]::UTF8)
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
    $idx  = Get-CacheIndexPath
    $map  = if (Test-Path $idx) {
        $raw = [System.IO.File]::ReadAllText($idx, [System.Text.Encoding]::UTF8)
        $obj = ConvertFrom-Json $raw
        $ht  = @{}
        $obj.PSObject.Properties | ForEach-Object { $ht[$_.Name] = $_.Value }
        $ht
    } else { @{} }
    $map[$DN] = $Count
    $json = ConvertTo-Json -InputObject ([PSCustomObject]$map) -Compress
    [System.IO.File]::WriteAllText($idx, $json, [System.Text.Encoding]::UTF8)
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
    $scriptsDir = Split-Path ($global:path."r_settings" -replace '/', '\') -Parent
    $cacheDir   = Join-Path $scriptsDir "cache"
    if (-not (Test-Path $cacheDir)) { return @() }
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($f in Get-ChildItem -Path $cacheDir -Filter "*.json" -Exclude "_index.json" -ErrorAction SilentlyContinue) {
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
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-JsonResponse {
    param($Response, [string]$Body)

    if ([string]::IsNullOrEmpty($Body) -or $Body -eq 'null') { $Body = '[]' }
    $Response.ContentType = "application/json; charset=utf-8"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
}
