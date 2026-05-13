function load_jsonParameters {
     try {
        $f = $global:path."f_parametres.json"
        $global:parametresJson = Get-Content -Raw $f | ConvertFrom-Json -ErrorAction Stop;
        $msg = "[`$global:parametresJson] ==> chargé avec succès : '$f'";
        write-host $msg -ForegroundColor Green
        Add-Content -Path $global:fileLog -Value $msg
    } catch {
        $msg = "La structure du fichier JSON '$f' n'est pas valide. Processus arrêté.";
        write-host $msg -ForegroundColor Red
        Add-Content -Path $global:fileLog -Value $msg
        return
    }
}

function load_jsonParameters_compteAftral {
     try {
        $f = $jsonParameters_compteAftral = "\\A20000A00S242\compte-Aftral\settings\parametres.json"
        $global:jsonParameters_compteAftral = Get-Content -Raw $f | ConvertFrom-Json -ErrorAction Stop;
        $msg = "[`$global:jsonParameters_compteAftral] ==> chargé avec succès : '$f'";
        write-host $msg -ForegroundColor Green
        Add-Content -Path $global:fileLog -Value $msg
    } catch {
        $msg = "La structure du fichier JSON '$f' n'est pas valide. Processus arrêté.";
        write-host $msg -ForegroundColor Red
        Add-Content -Path $global:fileLog -Value $msg
        return
    }
}

