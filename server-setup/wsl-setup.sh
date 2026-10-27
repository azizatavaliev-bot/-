#!/usr/bin/env bash
# Шаг 3b. Внутри Ubuntu (WSL): tmux, Bun, Claude Code, скрипт запуска tgclaude.
# Запуск: bash wsl-setup.sh   (из той же папки, где лежит tgclaude-start.sh)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

echo "[1/4] apt: tmux, curl, unzip, git..."
sudo apt-get update -y
sudo apt-get install -y tmux curl unzip git ca-certificates

echo "[2/4] Bun..."
command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash

echo "[3/4] Claude Code (официальный установщик)..."
command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash

echo "[4/4] Скрипт запуска ~/bin/tgclaude-start.sh..."
mkdir -p "$HOME/bin"
install -m 755 "$here/tgclaude-start.sh" "$HOME/bin/tgclaude-start.sh"

cat <<'MSG'

ГОТОВО. Дальше ВРУЧНУЮ (нужны твои токены, я их нигде не храню):
  1) Создай своего бота у @BotFather -> /newbot -> получи токен.
  2) Узнай свой Telegram ID (например, у @userinfobot).
  3) Запусти `claude`, войди в аккаунт, затем внутри:
       /plugin install telegram@claude-plugins-official
       /telegram:configure        <- вставь токен здесь (плагин сам кладёт его в свой конфиг)
       /telegram:access           <- оставь доступ только для своего ID (allowlist), pairing закрой
     Точные команды сверь с README плагина: они могут называться иначе.
  4) Проверка:  ~/bin/tgclaude-start.sh && tmux attach -t tgclaude
MSG
