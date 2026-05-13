import-module -Name $(join-path -Path $PSScriptRoot -ChildPath "_initGlobalVariables.psm1")
import-module -Name $global:path."f_connect.psm1" -force

[CmdletBinding()]
$Loop = $true

function GO{
    While ($Loop) {
        write-host "+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++ " -ForegroundColor yellow
        write-host "                              Liste de distribution                                 " -ForegroundColor yellow
        write-host "+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++ " -ForegroundColor yellow
        write-host ""
        write-host "1) test 1" -ForegroundColor green
        write-host ""
        write-host "2) test 2" -ForegroundColor green
        write-host ""
        write-host "99) Control d'appel de variables globales" -ForegroundColor green
        write-host ""

        $opt = Read-Host "Selectionner votre option [1-2] :: [0 - Exit]"

        switch ($opt){
            1 {
                    # SCRIPT
                    exit
            }
            0 {
                    $Loop = $true
                    cls
                    Exit
            }
        }
    }
}

GO

