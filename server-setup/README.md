# Windows-сервер 24/7: Tailscale + SSH + WSL2 + Claude↔Telegram

Скрипты нужно запустить на самом ПК (облачная сессия до него не достаёт). Порядок:

| # | Что | Как |
|---|-----|-----|
| 1 | Сон/гибернация/fast startup | `01-power.ps1` (админ PowerShell) |
| 2 | Tailscale + OpenSSH | `02-tailscale-ssh.ps1` (админ) → потом `tailscale up --unattended` |
| 3 | WSL2 + Ubuntu | `03-wsl.ps1` (админ) → перезагрузка → создать пользователя → `bash wsl-setup.sh` внутри Ubuntu |
| 4 | Telegram-плагин | вручную, см. вывод `wsl-setup.sh` (токен вводишь сам) |
| 5 | Планировщик | `05-scheduler.ps1` (обычный PowerShell под своим пользователем) |
| 6 | Автовход | ниже |
| 7 | Heartbeat | ниже |

Если PowerShell ругается на политику: `Set-ExecutionPolicy -Scope Process Bypass`.

## SSH с MacBook
На Mac: `cat ~/.ssh/id_ed25519.pub` (нет ключа — `ssh-keygen -t ed25519`).
На ПК (админ-аккаунт) вставь ключ в `C:\ProgramData\ssh\administrators_authorized_keys`, затем:
`icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant "SYSTEM:F" /grant "Administrators:F"`
Подключение: `ssh ИМЯ_ПОЛЬЗОВАТЕЛЯ@ИМЯ-ПК` (имя из Tailscale). Когда ключ заработал, поставь `PasswordAuthentication no` в `C:\ProgramData\ssh\sshd_config` и `Restart-Service sshd`.

## 6. Автовход без пароля открытым текстом
🎯 Бери **Sysinternals Autologon** (https://learn.microsoft.com/sysinternals/downloads/autologon): пароль хранится как зашифрованный LSA-секрет, а не в реестре текстом. Запусти, введи пользователя/пароль → Enable.
Риск: любой, кто физически у ПК, попадает в твою сессию. Поэтому включи BitLocker, держи ПК в безопасном месте. Лучше отдельная локальная учётка с минимумом прав и без почтовых/банковских сессий.
Не делай через `reg add ... DefaultPassword` — это и есть пароль открытым текстом.

## 7. Heartbeat (dead-man's switch)
Сам молчащий ПК алерт отправить не может, поэтому проверяет внешний сервис.
1. Заведи check на healthchecks.io: период **5 мин**, grace **5 мин**.
2. Подключи канал оповещения: Telegram (интеграция у них готовая) или email.
3. Сохрани URL пинга в переменную пользователя (в файл он не попадает):
   `setx TGCLAUDE_HEARTBEAT_URL "https://hc-ping.com/ТВОЙ-UUID"`
`watchdog.ps1` каждые 5 минут пингует URL, если сессия tgclaude жива, и шлёт `/fail`, если нет. Нет пинга 10 минут (ПК выключен, завис, нет сети, watchdog умер) → тебе приходит алерт.
Ограничение: проверяется «процесс жив», а не «Claude отвечает». Для глубокой проверки позже добавим тестовое сообщение боту раз в сутки.

## Диагностика
- `Get-ScheduledTaskInfo TgClaude-Watchdog` — последний запуск и код
- `Get-Content $env:LOCALAPPDATA\tgclaude\watchdog.log -Tail 30`
- `wsl -d Ubuntu -- tmux attach -t tgclaude` — посмотреть сессию
- Отключи авто-перезагрузку Windows Update в активные часы, иначе ПК будет уходить в ребут без входа (поможет Autologon).
