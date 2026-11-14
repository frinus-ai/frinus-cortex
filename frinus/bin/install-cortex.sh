#!/usr/bin/env bash
# install-cortex.sh — instala o Frinus Córtex (fork do Habblaud) em Linux, WSL e macOS.
#
# Idempotente: pode rodar de novo com segurança (atualiza o que mudou, não duplica nada).
# Faz, nesta ordem:
#   0) MIGRAÇÃO do Frinus Office antigo (clientes v0.2.2): para/desabilita/remove o serviço, o LaunchAgent e o
#      atalho "frinus-office"; move ~/.frinus-office -> ~/.frinus-cortex e ~/.config/frinus-office ->
#      ~/.config/frinus-cortex (sem sobrescrever); e relocaliza o app de ~/.local/share/frinus-office para
#      ~/.local/share/frinus-cortex. Tudo idempotente — rodar 2x é no-op.
#   1) build (client + server) em dist/ — PULADO na release, que já vem compilada (arquivo .release na raiz);
#   2) npm run mod:install SÓ nas contas do Claude Code que têm o MCP do Frinus (FRINUS_ONLY=1),
#      para os cartões de permissão e mensagem chegarem ao Córtex;
#   3) início automático na porta 4748 (não mexe no habblaud.service da 4747):
#        Linux/WSL com systemd -> serviço systemd --user "frinus-cortex"
#        macOS                 -> LaunchAgent ~/Library/LaunchAgents/br.com.frinus.cortex.plist
#        Windows (WSL)         -> quem cuida é o instalador do Windows (setup.ps1), que chama com --no-service:
#                                 o WSL desliga quando nenhum programa do Windows o usa, então o Córtex roda
#                                 pelo atalho/inicialização do Windows (frinus/bin/frinus-cortex-wsl).
#   4) atalho "Frinus Córtex" que sobe o Córtex e abre a tela no navegador
#      (Linux: .desktop no menu · macOS: "Frinus Córtex.command" na Mesa · Windows: criado pelo setup.ps1).
#
# Opções:
#   --dry-run          mostra o que faria, sem build, sem mexer nas contas, sem serviço nem atalho
#   --service <nome>   nome do serviço systemd (padrão: frinus-cortex); útil para testar
#   --skip-build       não recompila (usa o dist/ existente)
#   --skip-mod         não roda o mod:install nas contas
#   --skip-migrate     não migra o Frinus Office antigo (FRINUS_SKIP_MIGRATE=1 faz o mesmo)
#   --no-service       não cria/atualiza o início automático
#   --no-desktop       não cria o atalho
#   -h, --help         esta ajuda
set -euo pipefail

DRY_RUN=0
SERVICE_NAME=frinus-cortex
SKIP_BUILD=0
SKIP_MOD=0
SKIP_MIGRATE="${FRINUS_SKIP_MIGRATE:-0}"
NO_SERVICE=0
NO_DESKTOP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --service) SERVICE_NAME="${2:?--service precisa de um nome}"; shift ;;
    --skip-build) SKIP_BUILD=1 ;;
    --skip-mod) SKIP_MOD=1 ;;
    --skip-migrate) SKIP_MIGRATE=1 ;;
    --no-service) NO_SERVICE=1 ;;
    --no-desktop) NO_DESKTOP=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "install-cortex: opção desconhecida: $1" >&2; exit 2 ;;
  esac
  shift
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

# shellcheck disable=SC1091
. "$here/lib.sh"
frinus_load_node

CFG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_BASE="${XDG_DATA_HOME:-$HOME/.local/share}"
CORTEX_APP_DIR="${FRINUS_CORTEX_DIR:-$DATA_BASE/frinus-cortex}"

# Porta do Córtex: lê HABBLAUD_PORT de cortex.env (padrão 4748), sem sourcing do arquivo inteiro.
ENV_FILE="$root/frinus/cortex.env"; [ -f "$ENV_FILE" ] || ENV_FILE="$root/frinus/office.env"
PORT="$(sed -n 's/^HABBLAUD_PORT=\([0-9]\{1,5\}\).*/\1/p' "$ENV_FILE" | head -1)"
PORT="${PORT:-4748}"
OS="$(frinus_os)"

say()  { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }
run()  { printf '  + %s\n' "$*"; [ "$DRY_RUN" = 1 ] || "$@"; }
write_file() { # write_file <arquivo> <conteúdo>
  if [ "$DRY_RUN" = 1 ]; then
    echo "  + escreveria $1:"; printf '%s\n' "$2" | sed 's/^/      | /'
  else
    mkdir -p "$(dirname "$1")"; printf '%s' "$2" >"$1"
  fi
}

# --- 0) migração do Frinus Office antigo ----------------------------------------------------------
# Move o cliente v0.2.2 ("frinus-office") para "frinus-cortex". Best-effort e idempotente: cada passo
# só age se o alvo antigo existir, e nunca sobrescreve dados já migrados.
move_legacy_dir() { # move_legacy_dir <src> <dst> <rótulo>
  local src="$1" dst="$2" label="$3"
  [ -d "$src" ] || return 0
  [ "$src" = "$dst" ] && return 0
  if [ ! -e "$dst" ]; then
    say "Migração: movendo $label ($src -> $dst)"
    run mkdir -p "$(dirname "$dst")"
    run mv "$src" "$dst"
  else
    say "Migração: $label já existe em $dst — copiando só o que falta e mantendo o antigo em $src"
    [ "$DRY_RUN" = 1 ] || cp -an "$src/." "$dst/" 2>/dev/null || cp -rn "$src/." "$dst/" 2>/dev/null || true
  fi
}

relocate_app() {
  local target="$CORTEX_APP_DIR"
  local cur tgt
  cur="$(cd "$root" && pwd -P)"
  tgt="$(cd "$target" 2>/dev/null && pwd -P || echo "$target")"
  [ "$cur" = "$tgt" ] && return 0
  # Só relocaliza um app de verdade (release pronta ou build presente).
  [ -f "$root/.release" ] || [ -f "$root/dist/server/index.js" ] || return 0
  say "Migração: relocando o app para $target (mantém $cur intacto)"
  if [ "$DRY_RUN" != 1 ]; then
    mkdir -p "$(dirname "$target")"
    rm -rf "$target.new" "$target.old"
    mkdir -p "$target.new"
    cp -a "$root/." "$target.new/"
    [ -d "$target" ] && mv "$target" "$target.old"
    mv "$target.new" "$target"
    rm -rf "$target.old"
  fi
  # A partir daqui o instalador opera a partir do diretório novo (serviço/atalho apontam para ele).
  here="$target/frinus/bin"
  root="$target"
}

migrate_legacy_office() {
  # 1) serviço systemd --user antigo
  local old_unit="$CFG_BASE/systemd/user/frinus-office.service"
  if [ "$OS" != mac ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    if systemctl --user list-unit-files frinus-office.service >/dev/null 2>&1 || [ -f "$old_unit" ]; then
      say "Migração: desligando e removendo o serviço antigo frinus-office"
      run systemctl --user stop frinus-office.service || true
      run systemctl --user disable frinus-office.service || true
      [ -f "$old_unit" ] && run rm -f "$old_unit"
      run systemctl --user daemon-reload || true
    fi
  fi
  # 2) LaunchAgent antigo (macOS)
  local old_plist="$HOME/Library/LaunchAgents/br.com.frinus.office.plist"
  if [ -f "$old_plist" ]; then
    say "Migração: removendo o LaunchAgent antigo br.com.frinus.office"
    [ "$DRY_RUN" = 1 ] || launchctl bootout "gui/$(id -u)/br.com.frinus.office" >/dev/null 2>&1 || true
    run rm -f "$old_plist"
  fi
  local old_cmd="$HOME/Desktop/Frinus Office.command"
  [ -e "$old_cmd" ] && { say "Migração: removendo o atalho antigo da Mesa (Frinus Office.command)"; run rm -f "$old_cmd"; }
  # 3) atalho .desktop antigo (Linux)
  local old_desktop="$DATA_BASE/applications/frinus-office.desktop"
  [ -f "$old_desktop" ] && { say "Migração: removendo o atalho antigo frinus-office.desktop"; run rm -f "$old_desktop"; }
  # 4) dados e configuração (sem sobrescrever)
  move_legacy_dir "$HOME/.frinus-office" "$HOME/.frinus-cortex" "os dados"
  move_legacy_dir "$CFG_BASE/frinus-office" "$CFG_BASE/frinus-cortex" "a configuração"
  # 5) relocar o app para ~/.local/share/frinus-cortex (sem apagar a pasta de onde rodamos)
  relocate_app
}

say "Frinus Córtex — instalação ($OS; porta $PORT)"
[ "$DRY_RUN" = 1 ] && echo "   (dry-run: nada será alterado)"

if [ "$SKIP_MIGRATE" = 1 ]; then
  say "Migração do Frinus Office antigo: pulada (--skip-migrate)"
else
  migrate_legacy_office
fi

# Depois da migração, o env do node é gravado na pasta nova (cortex), nunca na legada que acabou de ser movida.
FRINUS_ENV_FILE="$CFG_BASE/frinus-cortex/env"

if ! frinus_node_ok; then
  echo "install-cortex: precisa do Node 22.12 ou mais novo (achei: $(node --version 2>/dev/null || echo nenhum))." >&2
  exit 1
fi
# O serviço e o atalho não leem o ~/.bashrc: guardamos onde está o node.
[ "$DRY_RUN" = 1 ] && echo "  + gravaria $FRINUS_ENV_FILE (FRINUS_NODE_DIR=$(dirname "$(command -v node)"))" || frinus_save_node

# --- 1) build -------------------------------------------------------------------------------------
if [ -f "$root/.release" ] && [ -f "$root/dist/server/index.js" ]; then
  say "Build: não precisa (versão pronta $(cat "$root/.release"))"
elif [ "$SKIP_BUILD" = 1 ]; then
  say "Build: pulado (--skip-build)"
else
  say "Build (client + server)"
  if [ ! -d "$root/node_modules" ]; then
    run sh -c "cd '$root' && npm ci"
  fi
  run sh -c "cd '$root' && npm run build"
fi

# --- 2) mod nas contas com Frinus -----------------------------------------------------------------
if [ "$SKIP_MOD" = 1 ]; then
  say "Mod nas contas: pulado (--skip-mod)"
elif ! command -v claude >/dev/null 2>&1; then
  say "Mod nas contas: PULADO — 'claude' não está no PATH. Rode depois:  cd '$root' && FRINUS_ONLY=1 npm run mod:install"
else
  say "Mod (permissões + mensagens) nas contas COM Frinus"
  # FRINUS_ONLY=1 faz o mod:install enxergar só as contas com o MCP do Frinus (server/accounts/detect.ts).
  # Melhor esforço: sem o mod o Córtex funciona, só sem os cartões de permissão/mensagem.
  if [ "$DRY_RUN" = 1 ]; then
    run sh -c "cd '$root' && FRINUS_ONLY=1 npm run --silent mod:install -- --dry-run"
  else
    run sh -c "cd '$root' && FRINUS_ONLY=1 npm run --silent mod:install" || echo "   (aviso: o mod não foi instalado; o Córtex funciona assim mesmo)"
  fi
fi

# --- 3) início automático -------------------------------------------------------------------------
if [ "$NO_SERVICE" = 1 ]; then
  say "Início automático: pulado (--no-service)"
elif [ "$OS" = wsl ]; then
  # Um serviço systemd aqui atrapalharia: subiria o Córtex sem nenhum wsl.exe segurando o Ubuntu ligado, o
  # frinus-cortex-wsl acharia a porta ocupada e sairia, e o WSL desligaria tudo minutos depois.
  say "Início automático: pelo Windows (atalho e Inicializar chamam $here/frinus-cortex-wsl)"
elif [ "$OS" = mac ]; then
  label="br.com.frinus.cortex"
  plist="$HOME/Library/LaunchAgents/$label.plist"
  logdir="$HOME/Library/Logs"
  say "Início automático (macOS LaunchAgent $label, porta $PORT)"
  write_file "$plist" "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$here/frinus-cortex</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$logdir/frinus-cortex.log</string>
  <key>StandardErrorPath</key><string>$logdir/frinus-cortex.log</string>
</dict>
</plist>
"
  if [ "$DRY_RUN" != 1 ]; then
    launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load -w "$plist" 2>/dev/null || true
  fi
elif ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
  say "Início automático: INDISPONÍVEL (sem systemd --user). O atalho sobe o Córtex: $here/frinus-cortex-open"
else
  unit_file="$CFG_BASE/systemd/user/${SERVICE_NAME}.service"
  say "Serviço systemd --user: $SERVICE_NAME (porta $PORT)"
  write_file "$unit_file" "[Unit]
Description=Frinus Córtex — escritório visual do cliente Frinus (fork do Habblaud)
After=network.target

[Service]
Type=simple
ExecStart=$here/frinus-cortex
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
"
  if [ "$DRY_RUN" != 1 ]; then
    run systemctl --user daemon-reload
    run systemctl --user enable "${SERVICE_NAME}.service"
    # restart (não só start): numa atualização, o serviço passa a rodar a versão nova.
    run systemctl --user restart "${SERVICE_NAME}.service"
    echo "   status: systemctl --user status ${SERVICE_NAME}"
  fi
fi

# --- 4) atalho ------------------------------------------------------------------------------------
icon="$root/dist/client/assets/brand/icon-512.png"
[ -f "$icon" ] || icon="$root/client/public/assets/brand/icon-512.png"
if [ "$NO_DESKTOP" = 1 ]; then
  say "Atalho: pulado (--no-desktop)"
elif [ "$OS" = wsl ]; then
  say "Atalho: no Windows ele é criado pelo instalador do Windows (Frinus Córtex na área de trabalho)"
elif [ "$OS" = mac ]; then
  cmd_file="$HOME/Desktop/Frinus Córtex.command"
  say "Atalho na Mesa: Frinus Córtex"
  write_file "$cmd_file" "#!/bin/bash
# Frinus Córtex — abre o Córtex no navegador (sobe o serviço se preciso).
HABBLAUD_PORT=$PORT '$here/frinus-cortex-open'
osascript -e 'tell application \"Terminal\" to close (every window whose name contains \"Frinus Córtex\")' >/dev/null 2>&1 &
exit 0
"
  if [ "$DRY_RUN" != 1 ]; then
    chmod +x "$cmd_file"
    # Ícone com a logo (melhor esforço; mesmo método do instalador do frinus-mcp).
    [ -f "$icon" ] && osascript -l JavaScript -e "ObjC.import('AppKit'); \$.NSWorkspace.sharedWorkspace.setIconForFileOptions(\$.NSImage.alloc.initWithContentsOfFile('$icon'), '$cmd_file', 0)" >/dev/null 2>&1 || true
  fi
else
  desktop_file="$DATA_BASE/applications/frinus-cortex.desktop"
  say "Atalho no menu: Frinus Córtex"
  [ -f "$icon" ] || icon="applications-science"
  write_file "$desktop_file" "[Desktop Entry]
Type=Application
Name=Frinus Córtex
Comment=A Mente por Trás da sua IA — escritório visual dos agentes
Exec=env HABBLAUD_PORT=$PORT FRINUS_CORTEX_SERVICE=$SERVICE_NAME $here/frinus-cortex-open
Icon=$icon
Terminal=false
Categories=Network;
"
  if [ "$DRY_RUN" != 1 ]; then
    chmod +x "$desktop_file" 2>/dev/null || true
    command -v update-desktop-database >/dev/null 2>&1 && run update-desktop-database "$(dirname "$desktop_file")" || true
  fi
fi

say "Pronto. Córtex em http://127.0.0.1:$PORT"
[ "$DRY_RUN" = 1 ] && echo "   (dry-run — nada foi alterado)"
exit 0
