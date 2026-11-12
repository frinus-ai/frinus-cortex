#!/usr/bin/env bash
# install-office.sh — instala o Frinus Office (fork do Habblaud) em Linux e WSL.
#
# Idempotente: pode rodar de novo com segurança (atualiza o que mudou, não duplica nada).
# Faz, nesta ordem:
#   1) build (client + server) em dist/;
#   2) npm run mod:install SÓ nas contas do Claude Code que têm o MCP do Frinus (FRINUS_ONLY=1),
#      para os cartões de permissão e mensagem chegarem ao escritório;
#   3) serviço systemd --user "frinus-office" na porta 4748 (não mexe no habblaud.service da 4747);
#   4) atalho .desktop ("Frinus Office") que sobe o serviço e abre a tela no navegador.
#
# A porta do mod NÃO é fixa: os hooks leem HABBLAUD_PORT do ambiente da sessão. O frinus-office
# exporta HABBLAUD_PORT=4748 (frinus/office.env), então as sessões abertas por ele falam com a 4748;
# as abertas pelo Habblaud de produção seguem falando com a 4747. A mesma instalação do mod serve os
# dois escritórios — por isso não há conflito com o habblaud.service.
#
# Opções:
#   --dry-run          mostra o que faria, sem build, sem mexer nas contas, sem systemd nem atalho
#   --service <nome>   nome do serviço systemd (padrão: frinus-office); útil para testar
#   --skip-build       não recompila (usa o dist/ existente)
#   --skip-mod         não roda o mod:install nas contas
#   --no-service       não cria/atualiza o serviço systemd
#   --no-desktop       não cria o atalho .desktop
#   -h, --help         esta ajuda
set -euo pipefail

DRY_RUN=0
SERVICE_NAME=frinus-office
SKIP_BUILD=0
SKIP_MOD=0
NO_SERVICE=0
NO_DESKTOP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --service) SERVICE_NAME="${2:?--service precisa de um nome}"; shift ;;
    --skip-build) SKIP_BUILD=1 ;;
    --skip-mod) SKIP_MOD=1 ;;
    --no-service) NO_SERVICE=1 ;;
    --no-desktop) NO_DESKTOP=1 ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "install-office: opção desconhecida: $1" >&2; exit 2 ;;
  esac
  shift
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

# Node 22 (nvm) na frente do PATH, se existir.
node_bin="/home/renato/.nvm/versions/node/v22.17.0/bin"
[ -d "$node_bin" ] && export PATH="$node_bin:$PATH"

# Porta do escritório: lê HABBLAUD_PORT de office.env (padrão 4748), sem sourcing do arquivo inteiro.
PORT="$(sed -n 's/^HABBLAUD_PORT=\([0-9]\{1,5\}\).*/\1/p' "$root/frinus/office.env" | head -1)"
PORT="${PORT:-4748}"

is_wsl=0
grep -qi microsoft /proc/version 2>/dev/null && is_wsl=1

say()  { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }
run()  { printf '  + %s\n' "$*"; [ "$DRY_RUN" = 1 ] || "$@"; }

say "Frinus Office — instalação ($([ "$is_wsl" = 1 ] && echo WSL || echo Linux); porta $PORT; serviço $SERVICE_NAME)"
[ "$DRY_RUN" = 1 ] && echo "   (dry-run: nada será alterado)"

# --- 1) build -------------------------------------------------------------------------------------
if [ "$SKIP_BUILD" = 1 ]; then
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
  say "Mod nas contas: PULADO — 'claude' não está no PATH. Rode depois:  FRINUS_ONLY=1 npm run mod:install"
else
  say "Mod (permissões + mensagens) nas contas COM Frinus"
  # FRINUS_ONLY=1 faz o mod:install enxergar só as contas com o MCP do Frinus (server/accounts/detect.ts).
  if [ "$DRY_RUN" = 1 ]; then
    run sh -c "cd '$root' && FRINUS_ONLY=1 npm run mod:install -- --dry-run"
  else
    run sh -c "cd '$root' && FRINUS_ONLY=1 npm run mod:install"
  fi
fi

# --- 3) serviço systemd --user --------------------------------------------------------------------
unit_dir="$HOME/.config/systemd/user"
unit_file="$unit_dir/${SERVICE_NAME}.service"
if [ "$NO_SERVICE" = 1 ]; then
  say "Serviço systemd: pulado (--no-service)"
elif ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
  say "Serviço systemd: INDISPONÍVEL (sem systemd --user). Rode o escritório à mão: $here/frinus-office"
  [ "$is_wsl" = 1 ] && echo "   Em WSL, habilite systemd em /etc/wsl.conf ([boot] systemd=true) e 'wsl --shutdown'."
else
  say "Serviço systemd --user: $SERVICE_NAME (porta $PORT)"
  unit_content="[Unit]
Description=Frinus Office — escritório visual do cliente Frinus (fork do Habblaud)
After=network.target

[Service]
Type=simple
ExecStart=$here/frinus-office
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
"
  if [ "$DRY_RUN" = 1 ]; then
    echo "  + escreveria $unit_file:"
    printf '%s\n' "$unit_content" | sed 's/^/      | /'
  else
    mkdir -p "$unit_dir"
    printf '%s' "$unit_content" > "$unit_file"
    run systemctl --user daemon-reload
    run systemctl --user enable --now "${SERVICE_NAME}.service"
    echo "   status: systemctl --user status ${SERVICE_NAME}"
  fi
fi

# --- 4) atalho .desktop ---------------------------------------------------------------------------
if [ "$NO_DESKTOP" = 1 ]; then
  say "Atalho .desktop: pulado (--no-desktop)"
else
  say "Atalho .desktop (Frinus Office)"
  apps_dir="$HOME/.local/share/applications"
  desktop_file="$apps_dir/frinus-office.desktop"
  icon="applications-science"
  [ -f "$root/client/public/assets/og-image.png" ] && icon="$root/client/public/assets/og-image.png"
  desktop_content="[Desktop Entry]
Type=Application
Name=Frinus Office
Comment=A Mente por Trás da sua IA — escritório visual dos agentes
Exec=env HABBLAUD_PORT=$PORT FRINUS_OFFICE_SERVICE=$SERVICE_NAME $here/frinus-office-open
Icon=$icon
Terminal=false
Categories=Network;
"
  if [ "$DRY_RUN" = 1 ]; then
    echo "  + escreveria $desktop_file:"
    printf '%s\n' "$desktop_content" | sed 's/^/      | /'
  else
    mkdir -p "$apps_dir"
    printf '%s' "$desktop_content" > "$desktop_file"
    chmod +x "$desktop_file" 2>/dev/null || true
    command -v update-desktop-database >/dev/null 2>&1 && run update-desktop-database "$apps_dir" || true
  fi
fi

say "Pronto. Escritório em http://127.0.0.1:$PORT"
[ "$DRY_RUN" = 1 ] && echo "   (dry-run — nada foi alterado)"
exit 0
