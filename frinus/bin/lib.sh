# lib.sh — funções comuns dos scripts do Frinus Office (carregado com ". lib.sh", não executar direto).
#
# Por que existe: o serviço (systemd --user / launchd) e o atalho NÃO carregam o ~/.bashrc, então o `node` e o
# `claude` instalados pelo nvm não estão no PATH deles. Na instalação gravamos a pasta do node em
# ~/.config/frinus-office/env (FRINUS_NODE_DIR); em tempo de execução lemos de lá e, como reserva, carregamos o nvm.

FRINUS_ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/frinus-office/env"

# Node >= 22.12 (engines do package.json).
frinus_node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' 2>/dev/null
}

frinus_load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # nvm.sh não é compatível com `set -u`.
    case "$-" in *u*) set +u; . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true; set -u ;; *) . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true ;; esac
  fi
}

# Coloca node/claude no PATH: pasta gravada na instalação > nvm > locais comuns.
frinus_load_node() {
  if [ -f "$FRINUS_ENV_FILE" ]; then
    # shellcheck disable=SC1090
    . "$FRINUS_ENV_FILE"
  fi
  if [ -n "${FRINUS_NODE_DIR:-}" ] && [ -x "$FRINUS_NODE_DIR/node" ]; then
    PATH="$FRINUS_NODE_DIR:$PATH"
  fi
  frinus_node_ok || frinus_load_nvm
  local d
  for d in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin; do
    case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && PATH="$PATH:$d" ;; esac
  done
  export PATH
}

# Grava a pasta do node atual para o serviço e o atalho acharem depois.
frinus_save_node() {
  local nd
  nd="$(dirname "$(command -v node)")"
  mkdir -p "$(dirname "$FRINUS_ENV_FILE")"
  printf 'FRINUS_NODE_DIR=%q\n' "$nd" >"$FRINUS_ENV_FILE"
}

frinus_os() { # linux | wsl | mac
  case "$(uname -s)" in
    Darwin) echo mac ;;
    *) if grep -qi microsoft /proc/version 2>/dev/null; then echo wsl; else echo linux; fi ;;
  esac
}
