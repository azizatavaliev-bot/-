# Шаг 3a. Ставим WSL2 + Ubuntu. От администратора. Потребуется перезагрузка.
#Requires -RunAsAdministrator
Write-Host 'Ставлю WSL2 и Ubuntu...'
wsl --install -d Ubuntu --no-launch
wsl --set-default-version 2
Write-Host ''
Write-Host 'ПЕРЕЗАГРУЗИ ПК. После перезагрузки:'
Write-Host '  1) открой "Ubuntu" из меню Пуск и создай Linux-пользователя;'
Write-Host '  2) запусти:  wsl -d Ubuntu -- bash /mnt/c/tgclaude/wsl-setup.sh   (после 05-scheduler.ps1 файлы лежат в C:\tgclaude)'
Write-Host '     или скопируй server-setup\wsl-setup.sh и tgclaude-start.sh в любую папку и запусти оттуда.'
