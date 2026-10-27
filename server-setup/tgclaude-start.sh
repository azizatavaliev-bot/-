#!/usr/bin/env bash
# Идемпотентный запуск: если сессия tgclaude жива — ничего не делает.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
tmux has-session -t tgclaude 2>/dev/null && exit 0
# Сессия живёт, пока жив claude: упал claude -> сессия исчезла -> watchdog поднимет заново.
tmux new-session -d -s tgclaude "claude --channels plugin:telegram@claude-plugins-official"
