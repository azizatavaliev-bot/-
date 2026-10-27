# Шаг 1. Отключаем сон, гибернацию, быстрый запуск. Запускать от администратора.
#Requires -RunAsAdministrator
Write-Host '[1/1] Отключаю сон, гибернацию и быстрый запуск...'
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change hibernate-timeout-dc 0
powercfg /change disk-timeout-ac 0
powercfg /change monitor-timeout-ac 10   # экран гаснет, система работает
# закрытие крышки (ноутбук): ничего не делать
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT
powercfg /hibernate off                  # убирает и гибернацию, и fast startup
reg add "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Power" /v HiberbootEnabled /t REG_DWORD /d 0 /f | Out-Null
Write-Host 'Готово. Проверка:'
powercfg /a
