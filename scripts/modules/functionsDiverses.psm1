function Start-SleepWithProgress {
	Param(
        [int]$sleeptime,
        [string]$Activity="Activité en attente")
    if (!$Activity)
    {
        $Activity="Activité en attente"
    }
	for ($i=0;$i -le $sleeptime;$i++){
		$timeleft = ($sleeptime - $i)
		Write-Progress -Activity $Activity -CurrentOperation "$Timeleft secondes restantes" -PercentComplete (($i/$sleeptime)*100);
		Start-Sleep 1
	}
	Write-Progress -Completed -Activity "En attente"
}

function To-ProperCase {
    param([string]$text)
    if ([string]::IsNullOrWhiteSpace($text)) { return "" }
    $words = $text -split '\s+' | ForEach-Object {
        if ($_.Length -gt 0) {
            $_.Substring(0,1).ToUpper() + $_.Substring(1).ToLower()
        } else {""}
    }
    return ($words -join ' ')
}

function send {
    Param(
        [Parameter(Mandatory=$true)] $subject,
        [Parameter(Mandatory=$true)] $attachments,
        [Parameter(Mandatory=$true)] $mailTo,
        [Parameter(Mandatory=$true)] $body
    )
    try{
        $SmtpClient = new-object system.net.mail.smtpClient
        $MailMessage = New-Object system.net.mail.mailmessage

        $SmtpClient.host = $global:parametresJson.mail.smtpServer
        $MailMessage.From = $global:parametresJson.mail.from

        $subject = $subject
        $MailMessage.Subject = $subject
        $MailMessage.IsBodyHtml = $True
        $MailMessage.Body = $body

        $mailTo | forEach {
            $MailMessage.To.add($_)
        }

        if ( $global:parametresJson.mailing.attachedFile ){
            foreach ($attachment in $attachments) {
                $MailMessage.Attachments.Add($attachment)
            }
        }

        $SmtpClient.Send($MailMessage)

    }catch{
        $msg = "Une erreur s'est produite lors de l'envoi du message de log. $($Error[0])"
        write-output $msg
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

function show-PSCustomObjectOrHashtableContent {
    param (
        [Parameter(Mandatory=$true)]
        [string]$nomVariable,
        [Parameter(Mandatory=$false)]
        [string]$msgInfo = ""
    )
    try {
        $inputObject = Get-Variable -Name $nomVariable -ValueOnly -ErrorAction Stop
    } catch {
        Write-Output "Erreur : La variable '$nomVariable' n'existe pas ou n'est pas accessible. $msgInfo"
        return
    }
    show-PSCustomObjectOrHashtableContent_2 -InputObject $inputObject -nomVariable $nomVariable -msgInfo $msgInfo
}

function show-PSCustomObjectOrHashtableContent_2 {
    param (
        [Parameter(Mandatory=$true)]
        $InputObject,
        [Parameter(Mandatory=$true)]
        [string]$nomVariable,
        [Parameter(Mandatory=$false)]
        [string]$msgInfo
    )
    $msg1 = "`n-----------------------------------------------------------`nVariable `$$nomVariable ([typeVariable]) - $msgInfo"
    $msg2 = "-----------------------------------------------------------`n"

    if ($InputObject -is [System.Management.Automation.PSCustomObject]) {
          $result = $InputObject | ConvertTo-Json
          $msg1 = $msg1 -replace "\[typeVariable\]", "PSCustomObject"
    } elseif ($InputObject -is [System.Collections.Hashtable]) {
          $result = $InputObject | ConvertTo-Json
          $msg1 = $msg1 -replace "\[typeVariable\]", "Hashtable"
    } else {
        $result = "Erreur : L'objet n'est ni un PSCustomObject ni une Hashtable."
        $msg1 = $msg1 -replace "\[typeVariable\]", "Type Inconnu"
    }

    write-host $msg1
    Write-Output $result
    write-host $msg2
}

