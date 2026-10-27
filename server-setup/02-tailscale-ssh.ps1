# Шаг 2. Tailscale + OpenSSH-сервер (доступен только из сети Tailscale). От администратора.
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

Write-Host '[1/3] Ставлю Tailscale через winget...'
winget install --id Tailscale.Tailscale -e --accept-package-agreements --accept-source-agreements

Write-Host '[2/3] Ставлю OpenSSH Server и включаю автозапуск...'
Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null
Set-Service sshd -StartupType Automatic
Start-Service sshd

Write-Host '[3/3] Firewall: порт 22 только для адресов Tailscale (100.64.0.0/10)...'
Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Disable-NetFirewallRule
if (-not (Get-NetFirewallRule -Name 'sshd-tailscale' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'sshd-tailscale' -DisplayName 'OpenSSH (Tailscale only)' `
    -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow -RemoteAddress 100.64.0.0/10 | Out-Null
}

Write-Host ''
Write-Host 'ДАЛЬШЕ ВРУЧНУЮ (нужен твой логин):'
Write-Host '  tailscale up --unattended      # откроет браузер для входа; --unattended = работает до входа в Windows'
Write-Host '  Потом положи публичный ключ MacBook в authorized_keys (см. README).'
