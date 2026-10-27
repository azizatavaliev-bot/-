# Шаг 5+7. Watchdog: держит WSL живым, поднимает tmux-сессию tgclaude, шлёт heartbeat.
# URL пинга берётся из переменной пользователя TGCLAUDE_HEARTBEAT_URL (в файлах не хранится).
$distro = 'Ubuntu'
$logDir = Join-Path $env:LOCALAPPDATA 'tgclaude'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'watchdog.log'
if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Move-Item $log "$log.old" -Force }
function Log($m) { "$(Get-Date -Format s)  $m" | Add-Content $log }

# 1. Держим WSL-VM живой: скрытый процесс sleep infinity
$alive = Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" |
         Where-Object { $_.CommandLine -match 'tgclaude-keepalive' }
if (-not $alive) {
  Log 'keepalive отсутствует -> запускаю'
  Start-Process wsl.exe -WindowStyle Hidden -ArgumentList '-d', $distro, '--', 'bash', '-c', 'exec -a tgclaude-keepalive sleep infinity'
  Start-Sleep 5
}

# 2. Поднимаем сессию tgclaude (скрипт идемпотентный)
wsl.exe -d $distro -- bash -lc '~/bin/tgclaude-start.sh' 2>&1 | ForEach-Object { Log "start: $_" }

# 3. Проверка здоровья и heartbeat
Start-Sleep 3
wsl.exe -d $distro -- tmux has-session -t tgclaude 2>$null
$ok = ($LASTEXITCODE -eq 0)
Log ("health: " + $(if ($ok) { 'OK' } else { 'FAIL' }))

$url = [Environment]::GetEnvironmentVariable('TGCLAUDE_HEARTBEAT_URL', 'User')
if ($url) {
  $target = if ($ok) { $url } else { "$url/fail" }
  try { Invoke-WebRequest -Uri $target -UseBasicParsing -TimeoutSec 15 | Out-Null }
  catch { Log "heartbeat error: $($_.Exception.Message)" }
} else { Log 'TGCLAUDE_HEARTBEAT_URL не задан - heartbeat пропущен' }
