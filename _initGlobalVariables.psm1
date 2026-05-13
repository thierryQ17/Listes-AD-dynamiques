# write-host "====================================> Initialisation des variables globales <====================================" -ForegroundColor Green
$global:prefixeF = "f_"
$global:prefixeR = "r_"
$global:prefixeMdp = "mdp__"
$global:connect_AD = "AD"
$global:connect_exchangeOnline = "exchangeOnline"
$global:credentialXML = "credential.xml"

function init_globalVariables {
    $basePath= $PSScriptRoot
    $directories = Get-ChildItem -Path $basePath -Directory -Recurse

    $path = @{}

    $leaf_basePath = Split-Path -Path $basePath -Leaf

    $xmlConnect = "xmlConnect"
    $exludedDirectories = @()
    $exludedFiles = @("application\out\0-enAttente")

    foreach ($directory in $directories) {
        $dirFullName = $directory.FullName

        $flg_exludedDirectory = $false
        if ($exludedDirectories.count -gt 0){
            foreach ($exludedDirectory in $exludedDirectories) {
                if ($dirFullName -like "*$exludedDirectory*") {
                    $flg_exludedDirectory = $true
                }
            }
        }
        if (!$flg_exludedDirectory){
            $parent_dirFullName = Split-Path -Path $dirFullName -parent

            $leaf_dirFullName = Split-Path -Path $directory -Leaf
            $leaf_parentdirFullName = Split-Path -Path $parent_dirFullName -leaf

            $absolutePathWithSlash = $dirFullName -replace '\\', '/'
            $a = ($dirFullName -split [regex]::Escape($leaf_basePath))[1]
            $relativePath = $leaf_basePath + $a
            $variableName = "$($relativePath -replace '[^a-zA-Z0-9_\-\.]', '|')"

            $v1 = $global:prefixeR
            $v2 = $leaf_parentdirFullName
            $v3 = $($variableName.Split('|')[-1])

            if($leaf_parentdirFullName -eq $xmlConnect){
                $baseKey = "$v1$v2`_$($v3.Split('|')[-1])"
            }else{
                $baseKey = "$v1$v3"
            }
            $key = $baseKey
            $suffix = 1
            while ($path.ContainsKey($key)) {
                if ($suffix -gt 1) {
                    $key = "${baseKey}_$suffix"
                }
                $suffix++
            }
            $path[$key] = $absolutePathWithSlash
        }

    }

    $files = Get-ChildItem -Path $basePath -File -Recurse
    foreach ($file in $files) {
        $fileFullName = $file.FullName

        $flg_exludedFile = $false
        if ($exludedFiles.count -gt 0){
            foreach ($exludedFile in $exludedFiles) {
                if ($fileFullName -like "*$exludedFile*") {
                    $flg_exludedFile = $true
                }
            }
        }
        if (!$flg_exludedFile){
            $parent_fileFullName = Split-Path -Path $fileFullName -parent
            $parentParent_fileFullName = Split-Path -Path $parent_fileFullName -parent

            $leaf_parentFileFullName = Split-Path -Path $parent_fileFullName -leaf
            $leaf_parentParentFileFullName = Split-Path -Path $parentParent_fileFullName -leaf

            $absolutePathWithSlash = $fileFullName -replace '\\', '/'
            $variableName = "$($file.BaseName -replace '[^a-zA-Z0-9_\-\.]', '_')"
            $ext = $file.Extension

            $v1 = $global:prefixeF
            $v2 = $global:prefixeMdp
            $v3 = $leaf_parentFileFullName
            $v4 = $variableName

            if ($leaf_parentParentFileFullName -eq $xmlConnect){
                $baseKey = "$v1$v2$v3`_$v4$ext"
            }else{
                $baseKey = "$v1$v4$ext"
            }
            $key = $baseKey

            $suffix = 1
            while ($path.ContainsKey($key)) {
                if ($suffix -gt 1) {
                    $key = "${baseKey}_$suffix"
                }
                $suffix++
            }
            $pasInclus = @("_transcriptLog", ".vscode")
            switch ($(Split-Path -Path $file.DirectoryName -Leaf)) {
                "log" {
                    if($file.Name -eq "log.log") {
                        $path[$key] = $absolutePathWithSlash
                    }
                    break
                }
                { $pasInclus -contains $_ } {
                    break
                }
                "_transcriptLog" {break}
                ".vscode" {break}
                default { $path[$key] = $absolutePathWithSlash }
            }
        }

    }
    $outputJsonPath = Join-Path -Path $basePath -ChildPath $(join-path $path["r_settings"] "variablesGlobales.json")

    $sortedPath = [ordered]@{}
    $path.GetEnumerator() | Sort-Object Name | ForEach-Object { $sortedPath[$_.Name] = $_.Value }

    $jsonObject = $sortedPath
    # !!! ==> $path["r_settings"] chemin absolu calculé lors de l'initialisation des variables globales
    $outputJsonPath = Join-Path $path["r_settings"] "variablesGlobales.json"
    $jsonObject | ConvertTo-Json -Depth 5 | Set-Content -Path $outputJsonPath -Force
    $global:path = Get-Content -Raw $outputJsonPath | ConvertFrom-Json -ErrorAction Stop;
    $global:path.PSObject.Properties | Sort-Object Name | Format-Table Name, Value -AutoSize
}

function load_jsonParameters {
     try {
        $f = $global:path."f_parametres.json"
        $global:parametresJson = Get-Content -Raw $f | ConvertFrom-Json -ErrorAction Stop;
        $msg = "[`$global:parametresJson] ==> chargé avec succès : '$f'";
        add-msg -msg $msg -foregroundColor Green
    } catch {
        $msg = "La structure du fichier JSON '$f' n'est pas chargé. Processus arrêté.";
        add-msg -msg $msg -foregroundColor Red
        return
    }
}

function add-msg{
	param(
		[string]$msg,
		[ValidateSet("White","Yellow","Green","Red","Cyan","Magenta","Blue","Gray","DarkYellow","DarkGreen","DarkRed","DarkCyan","DarkMagenta","DarkBlue","DarkGray")]
		[string]$foregroundColor = "White",
		[ValidateSet("writeHost","addContent","lesDeux")]
		[string]$quelType = "lesDeux"
	)
	if($quelType -eq "addContent"){
		Add-Content -Path $global:fileLog -Value $msg
	}elseif($quelType -eq "writeHost"){
		Write-Host $msg -ForegroundColor $foregroundColor
	}else{
		Write-Host $msg -ForegroundColor $foregroundColor
		Add-Content -Path $global:fileLog -Value $msg
	}
}

init_globalVariables

# initialisation le fichier de log
$global:fileLog_maintenant = $((Get-Date).ToString("yyyyMMddHHmm"))
$logFile = "$global:fileLog_maintenant`_log.log"
$global:fileLog = Join-Path -Path $global:path."r_log" -ChildPath $logFile

$msg = "[`$global:fileLog_maintenant`] ==> '$global:fileLog_maintenant' : Acronym de la variable globale '`$global:fileLog'"
add-msg -msg $msg -foregroundColor Green

$msg = "[`$global:fileLog] ==> Accès au fichier de log : '$global:fileLog'"
add-msg -msg $msg -foregroundColor Green

$msg = "[`$global:path.""...""] ==> Initialisation des variables globales : '"+$(Join-Path $global:path."r_settings" "variablesGlobales.json")+"'"
add-msg -msg $msg -foregroundColor Green

$msg = "[`$global:path.""r_settings""] ==> accès au répertoire (r_) ""r_settings"" '" + $global:path."r_settings" + "'"
add-msg -msg $msg -foregroundColor Green

$msg = "[`$global:path.""f_settings.json""] ==> accès au fichier (f_) ""f_settings"" '" + $global:path."f_settings.json" + "'"
add-msg -msg $msg -foregroundColor Green

load_jsonParameters

$msg = ""
add-msg -msg $msg

$msg = "----------------------------------------- ############## ----------------------------------------- "
add-msg -msg $msg -foregroundColor Green

$msg = ""
add-msg -msg $msg

