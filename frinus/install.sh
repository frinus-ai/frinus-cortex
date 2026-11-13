#!/usr/bin/env bash
# install.sh — instalador ponta a ponta do Frinus (cliente) para Linux e WSL.
#
# Faz, nesta ordem:
#   1) PRÉ-REQUISITOS: Node 22 (via nvm, se preciso) e o Claude Code — delegados ao instalador do frinus-mcp.
#   2) CADASTRA UMA conta Frinus (apelido + chave), reaproveitando o install.sh do frinus-mcp:
#      cria ~/.claude-<apelido>, liga o MCP frinus-mcp no .claude.json, instala o comando "frinus" e a equipe.
#      As DEMAIS contas entram depois pela própria interface (botão "Adicionar conta Frinus"), sem reinstalar.
#   3) PERGUNTA se o cliente quer a INTERFACE GRÁFICA (Frinus Office). É OPCIONAL:
#        • SIM  -> tudo já vem ativado em 1 passo: build + mod/plugins em TODAS as contas Frinus + dados de uso +
#                  serviço systemd --user na porta 4748 + atalho. O cliente NÃO ativa nada à mão.
#        • NÃO  -> fica só o Frinus no terminal (comando "frinus").
#
# Idempotente: pode rodar de novo com segurança. A chave é digitada escondida pelo instalador do frinus-mcp e
# NUNCA aparece na tela, em log ou em argumento de comando.
#
# Opções:
#   --dry-run            mostra o que faria, sem instalar nem gravar nada
#   --alias <apelido>    apelido da conta (pasta ~/.claude-<apelido>); sem isto, pergunta
#   --gui | --no-gui     não pergunta: instala (ou não) a interface gráfica
#   --mcp-install <path> caminho do install.sh do frinus-mcp (senão procura ao lado do repo / na variável / baixa)
#   --service <nome>     nome do serviço systemd da interface (padrão: frinus-office)
#   -h, --help           esta ajuda
set -euo pipefail

DRY_RUN=0
ALIAS=""
GUI=""            # "", "1" (sim) ou "0" (não)
MCP_INSTALL=""
SERVICE_NAME=frinus-office
DICTATION=1       # ditado por voz (whisper local); --no-dictation desliga

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --alias) ALIAS="${2:?--alias precisa de um apelido}"; shift ;;
    --gui) GUI=1 ;;
    --no-gui) GUI=0 ;;
    --no-dictation) DICTATION=0 ;;
    --mcp-install) MCP_INSTALL="${2:?--mcp-install precisa de um caminho}"; shift ;;
    --service) SERVICE_NAME="${2:?--service precisa de um nome}"; shift ;;
    -h|--help) sed -n '2,37p' "$0"; exit 0 ;;
    *) echo "install: opção desconhecida: $1" >&2; exit 2 ;;
  esac
  shift
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # .../frinus
root="$(cd "$here/.." && pwd)"                            # .../frinus-office

# Node 22 (nvm) na frente do PATH, se existir (o build da interface precisa dele).
node_bin="/home/renato/.nvm/versions/node/v22.17.0/bin"
[ -d "$node_bin" ] && export PATH="$node_bin:$PATH"

is_wsl=0
grep -qi microsoft /proc/version 2>/dev/null && is_wsl=1

say()  { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }
run()  { printf '  + %s\n' "$*"; [ "$DRY_RUN" = 1 ] || "$@"; }
ask()  { # ask <prompt> -> ecoa a resposta (lê do terminal real quando há um)
  local a=""
  printf '%s ' "$1" >&2
  if { : </dev/tty; } 2>/dev/null; then IFS= read -r a </dev/tty || true; else IFS= read -r a || true; fi
  printf '%s' "$a"
}

say "Frinus — instalação ($([ "$is_wsl" = 1 ] && echo WSL || echo Linux))"
[ "$DRY_RUN" = 1 ] && echo "   (dry-run: nada será alterado)"

# --- Ditado por voz (whisper local, pt-BR) — DEPENDÊNCIAS -----------------------------------------------------
# O ditado é LOCAL (nada de áudio sai do computador): precisa do whisper-cli (whisper.cpp), do ffmpeg e de um
# modelo multilíngue (ggml-base.bin). O servidor acha isso sozinho (server/dictation/whisper.ts) e, achando,
# o microfone aparece na caixa e no terminal, já ligado. Melhor esforço: se algo falhar, o resto da instalação
# segue (o ditado é opcional).
WHISPER_MODEL_DIR="$HOME/.local/share/whisper"
WHISPER_MODEL="$WHISPER_MODEL_DIR/ggml-base.bin"
WHISPER_MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
LOCAL_BIN="$HOME/.local/bin"

have() { command -v "$1" >/dev/null 2>&1; }
apt_install() { # apt_install <pacotes...> — usa sudo se não for root; silencioso no dry-run
  have apt-get || { echo "   (sem apt-get: instale manualmente: $*)"; return 1; }
  local sudo=""; [ "$(id -u)" = 0 ] || sudo="sudo"
  run $sudo apt-get update -y
  run $sudo apt-get install -y "$@"
}

install_dictation() {
  say "Ditado por voz (whisper local, pt-BR) — dependências"
  # ffmpeg (converte o áudio do navegador para wav)
  if have ffmpeg; then echo "   ffmpeg: ok"; else apt_install ffmpeg || echo "   (instale o ffmpeg para o ditado funcionar)"; fi

  # whisper-cli (whisper.cpp): se não existir, compila do código (precisa de git + cmake + compilador C++)
  if have whisper-cli || [ -x "$LOCAL_BIN/whisper-cli" ]; then
    echo "   whisper-cli: ok"
  else
    if have git && have cmake && { have g++ || have c++ || have clang++; }; then
      local src; src="$(mktemp -d)"
      run git clone --depth 1 https://github.com/ggerganov/whisper.cpp "$src/whisper.cpp"
      if [ "$DRY_RUN" != 1 ] && [ -d "$src/whisper.cpp" ]; then
        ( cd "$src/whisper.cpp" && cmake -B build -DCMAKE_BUILD_TYPE=Release >/dev/null && cmake --build build --config Release -j"$(nproc 2>/dev/null || echo 2)" --target whisper-cli ) \
          && mkdir -p "$LOCAL_BIN" \
          && cp "$src/whisper.cpp/build/bin/whisper-cli" "$LOCAL_BIN/whisper-cli" \
          && echo "   whisper-cli -> $LOCAL_BIN/whisper-cli" \
          || echo "   (falha ao compilar o whisper.cpp; instale o whisper-cli manualmente)"
      fi
      rm -rf "$src"
    else
      echo "   (para o ditado, instale git + cmake + compilador C++ e rode de novo, ou instale o whisper-cli manualmente)"
      [ "$DRY_RUN" = 1 ] || apt_install build-essential cmake git || true
    fi
  fi

  # modelo multilíngue base (~148 MB) em ~/.local/share/whisper
  if [ -f "$WHISPER_MODEL" ]; then
    echo "   modelo: ok ($WHISPER_MODEL)"
  else
    run mkdir -p "$WHISPER_MODEL_DIR"
    if have curl; then run curl -fL --retry 3 -o "$WHISPER_MODEL" "$WHISPER_MODEL_URL"
    elif have wget; then run wget -O "$WHISPER_MODEL" "$WHISPER_MODEL_URL"
    else echo "   (sem curl/wget: baixe $WHISPER_MODEL_URL para $WHISPER_MODEL)"; fi
  fi

  case ":$PATH:" in *":$LOCAL_BIN:"*) : ;; *) echo "   dica: garanta que $LOCAL_BIN está no PATH (para o whisper-cli ser encontrado)";; esac
}

# --- localizar o install.sh do frinus-mcp (reaproveita toda a lógica de cadastro de conta) --------------------
if [ -z "$MCP_INSTALL" ]; then
  for cand in "${FRINUS_MCP_INSTALL:-}" "$root/../frinus-mcp/install/install.sh" "$root/vendor/frinus-mcp/install/install.sh"; do
    [ -n "$cand" ] && [ -f "$cand" ] && { MCP_INSTALL="$cand"; break; }
  done
fi
MCP_URL="https://raw.githubusercontent.com/frinus-ai/frinus-mcp/client-installer-v10/install/install.sh"

# --- 1) + 2) pré-requisitos + cadastro de UMA conta ----------------------------------------------------------
say "Cadastro da conta Frinus (as demais entram depois pela interface)"
[ -n "$ALIAS" ] || ALIAS="$(ask 'Apelido desta conta (ex.: monetizze):')"
ALIAS="$(printf '%s' "$ALIAS" | tr '[:upper:]' '[:lower:]' | sed -E 's/^\.?claude[-_.]?//; s/[^a-z0-9_-]//g')"
[ -n "$ALIAS" ] || { echo "install: apelido inválido." >&2; exit 2; }
CFG="$HOME/.claude-$ALIAS"
echo "   conta -> $CFG"

if [ "$DRY_RUN" = 1 ]; then
  if [ -n "$MCP_INSTALL" ]; then
    echo "  + rodaria: CLAUDE_CONFIG_DIR=$CFG FRINUS_DEFER_LOGIN=1 bash $MCP_INSTALL"
  else
    echo "  + rodaria: curl -fsSL $MCP_URL | CLAUDE_CONFIG_DIR=$CFG FRINUS_DEFER_LOGIN=1 bash"
  fi
else
  # O instalador do frinus-mcp pede a chave escondida (não aparece na tela/log) e respeita CLAUDE_CONFIG_DIR,
  # instalando a conta em ~/.claude-<apelido>. FRINUS_DEFER_LOGIN=1: o login do Claude fica para o 1º uso.
  if [ -n "$MCP_INSTALL" ]; then
    CLAUDE_CONFIG_DIR="$CFG" FRINUS_DEFER_LOGIN=1 bash "$MCP_INSTALL"
  elif command -v curl >/dev/null 2>&1; then
    curl -fsSL "$MCP_URL" | CLAUDE_CONFIG_DIR="$CFG" FRINUS_DEFER_LOGIN=1 bash
  else
    echo "install: não achei o install.sh do frinus-mcp nem o curl. Use --mcp-install <caminho>." >&2
    exit 1
  fi
fi

# --- 3) interface gráfica (OPCIONAL) -------------------------------------------------------------------------
if [ -z "$GUI" ]; then
  resp="$(ask 'Instalar a interface gráfica Frinus Office? Se sim, já vem tudo pronto e ativado. [s/N]:')"
  case "$resp" in [sSyY]*) GUI=1 ;; *) GUI=0 ;; esac
fi

if [ "$GUI" = 1 ]; then
  # Ditado por voz: dependências locais (best-effort, nunca aborta a instalação).
  if [ "$DICTATION" = 1 ]; then
    set +e
    install_dictation
    set -e
  fi
  say "Interface gráfica: instalando e ATIVANDO tudo (nada a configurar à mão)"
  # install-office.sh já faz: build + FRINUS_ONLY mod:install (mod/plugins + uso em TODAS as contas Frinus) +
  # serviço systemd --user na 4748 + atalho. Com o uso lido de ~/.habblaud/usage (office.env), o cartão de cada
  # conta mostra o consumo sem "Como ativar".
  if [ "$DRY_RUN" = 1 ]; then
    run bash "$here/bin/install-office.sh" --dry-run --service "$SERVICE_NAME"
  else
    bash "$here/bin/install-office.sh" --service "$SERVICE_NAME"
  fi
  say "Pronto! A interface sobe sozinha e abre em http://127.0.0.1:4748 — tudo já ativado."
else
  say "Pronto! Só o Frinus no terminal."
  echo "   Abra um terminal novo e digite:  frinus"
  echo "   (A interface gráfica pode ser instalada depois com:  $here/install.sh --gui)"
fi

[ "$DRY_RUN" = 1 ] && echo "   (dry-run — nada foi alterado)"
exit 0
