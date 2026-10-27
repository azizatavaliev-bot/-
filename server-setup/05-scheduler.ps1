# Шаг 5. Планировщик: запуск при входе в Windows + проверка каждые 5 минут + автоперезапуск.
# Запускать обычным PowerShell под своим пользователем (WSL привязан к пользователю).
$ErrorActionPreference = 'Stop'
$dir = 'C:\tgclaude'
New-Item -ItemType Directory -Force $dir | Out-Null
Copy-Item "$PSScriptRoot\watchdog.ps1", "$PSScriptRoot\wsl-setup.sh", "$PSScriptRoot\tgclaude-start.sh" $dir -Force

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$dir\watchdog.ps1`""
$tLogon  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$tRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
  -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'TgClaude-Watchdog' -Action $action -Trigger @($tLogon, $tRepeat) `
  -Settings $settings -Principal $principal -Force | Out-Null
Write-Host 'Задача TgClaude-Watchdog создана. Проверка: Get-ScheduledTask TgClaude-Watchdog'
Write-Host 'Лог: %LOCALAPPDATA%\tgclaude\watchdog.log'
