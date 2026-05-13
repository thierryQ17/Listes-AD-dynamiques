import-module -Name $(join-path $PSScriptRoot _initGlobalVariables.psm1) -force
import-module -Name $global:path."f_connect.psm1" -force

Start-Transcript -OutputDirectory $global:path."r__transcriptLog"

write-host ""
try {
    $f = $global:path."f_parametres.json"
    $global:parametresJson = Get-Content -Raw $f | ConvertFrom-Json -ErrorAction Stop;
    $msg = "Le fichier JSON de paramètres '$f' est chargé avec succès.";
    write-host $msg -ForegroundColor Green
    Add-Content -Path $global:fileLog -Value $msg
} catch {
    $msg = "La structure du fichier JSON '$f' n'est pas valide. Processus arrêté.";
    write-host $msg -ForegroundColor Red
    Add-Content -Path $global:fileLog -Value $msg
    return
}

# Test de connexion à l'Active Directory
if ( ! $(connect-ADSession -username "thgadre.adm") ) {
    Write-Host "Test de connexion à l'AD : ECHEC" -ForegroundColor Red
}else{
    Write-Host "Test de connexion à l'AD : OK" -ForegroundColor Green
}
write-host "Test-ADConnection ==>" $(Test-ADConnection)
write-host ""

# Test de connexion à Microsoft Graph
if ( ! $(ConnectGraphWithClientSecret -env "aftral" -app "script_Aftral") ) {
    Write-Host "Test de connexion à GRAPH : ECHEC" -ForegroundColor Red
}else{
    Write-Host "Test de connexion à GRAPH: OK" -ForegroundColor Green
}
write-host "Test-MgGraphConnection ==>" $(Test-MgGraphConnection)
write-host ""

