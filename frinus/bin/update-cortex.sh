#!/usr/bin/env bash
# update-cortex.sh — atualiza SÓ a interface do Frinus Córtex, sem recadastrar conta nem pedir chave.
#
# É o motor do botão "Atualizar Córtex" (server/updates/apply.ts, disparado destacado por systemd-run --user /
# launchctl). Faz o mesmo download verificado do get.sh — baixa a versão PRONTA da release, confere o SHA-256 e
# troca a pasta de instalação de forma atômica — mas no fim roda o install-cortex.sh (reinstala + reinicia o
# serviço), NÃO o install.sh --gui. Assim não há etapa de conta nem pergunta de chave: é 100% não-interativo,
# próprio para rodar sem terminal.
#
# Seguro por construção: só troca a pasta DEPOIS de baixar e conferir o pacote. Se o download/SHA falhar, `set -e`
# aborta antes da troca e a instalação em uso fica intacta.
#
#   bash update-cortex.sh [--service <nome>] [--dry-run]
#
# Variáveis: FRINUS_CORTEX_VERSION=v0.2.5 (fixa a versão; padrão latest), FRINUS_CORTEX_DIR (pasta de instalação;
#            padrão: a própria raiz deste script), FRINUS_CORTEX_BASE_URL (testes). Nomes FRINUS_OFFICE_* = legado.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # .../frinus/bin
self_root="$(cd "$here/../.." && pwd)"                 # .../frinus-cortex (instalação em uso)

REPO="frinus-ai/frinus-cortex"
APP_DIR="${FRINUS_CORTEX_DIR:-${FRINUS_OFFICE_DIR:-$self_root}}"
VERSION="${FRINUS_CORTEX_VERSION:-${FRINUS_OFFICE_VERSION:-latest}}"
SERVICE_NAME=frinus-cortex
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --service) SERVICE_NAME="${2:?--service precisa de um nome}"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    *) ;;  # ignora o que não conhece (robusto a flags extras)
  esac
  shift
done

ROXO=$'\033[1;35m'; VERM=$'\033[1;31m'; FIM=$'\033[0m'
say()  { printf '\n%s==>%s %s\n' "$ROXO" "$FIM" "$*"; }
fail() { printf '\n%sErro:%s %s\n' "$VERM" "$FIM" "$1" >&2; [ -n "${2:-}" ] && printf '%s\n' "$2" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "Preciso do 'curl'." "Ubuntu/WSL: sudo apt-get install -y curl"
command -v tar  >/dev/null 2>&1 || fail "Preciso do 'tar'."

case "$(uname -s)" in
  Linux)  os=linux ;;
  Darwin) os=darwin ;;
  *) fail "Sistema não suportado: $(uname -s)." "No Windows, use o instalador Instalar-Frinus-Cortex.cmd." ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) fail "Processador não suportado: $(uname -m)." ;;
esac
asset="frinus-cortex-${os}-${arch}.tar.gz"
if [ -n "${FRINUS_CORTEX_BASE_URL:-${FRINUS_OFFICE_BASE_URL:-}}" ]; then
  base="${FRINUS_CORTEX_BASE_URL:-$FRINUS_OFFICE_BASE_URL}"     # testes: servidor local com os mesmos assets da release
elif [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

say "Frinus Córtex — baixando a versão pronta ($os-$arch, $VERSION)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fL --retry 3 --progress-bar -o "$tmp/$asset" "$base/$asset" \
  || fail "Não consegui baixar o Frinus Córtex." "Verifique sua internet e rode de novo."
curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" \
  || fail "Não consegui baixar a verificação do arquivo (SHA256SUMS)."

expected="$(awk -v f="$asset" '$2==f || $2=="*"f {print $1}' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || fail "A verificação não lista $asset."
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
else got="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"; fi
[ "$got" = "$expected" ] || fail "O arquivo baixado está corrompido (SHA-256 não confere)." "Rode de novo."
echo "   verificado (SHA-256 ok)"

mkdir -p "$tmp/new"
tar -xzf "$tmp/$asset" -C "$tmp/new"
[ -f "$tmp/new/frinus/bin/install-cortex.sh" ] && [ -f "$tmp/new/dist/server/index.js" ] || fail "Pacote incompleto."

if [ "$DRY_RUN" = 1 ]; then
  say "dry-run: instalaria $(cat "$tmp/new/.release" 2>/dev/null) em $APP_DIR (serviço $SERVICE_NAME) — nada alterado."
  exit 0
fi

# Troca atômica: a pasta antiga só sai depois que a nova está no lugar. Contas, conversas e configurações ficam em
# outras pastas (~/.frinus-cortex, ~/.config/frinus-cortex) e não são tocadas.
mkdir -p "$(dirname "$APP_DIR")"
rm -rf "$APP_DIR.new" "$APP_DIR.old"
mv "$tmp/new" "$APP_DIR.new"
[ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.old"
mv "$APP_DIR.new" "$APP_DIR"
rm -rf "$APP_DIR.old"
echo "   instalado em $APP_DIR ($(cat "$APP_DIR/.release" 2>/dev/null))"

# Reinstala a partir da versão nova (já compilada: install-cortex.sh pula o build) e REINICIA o serviço. Sem etapa
# de conta/chave — só a interface. O install-cortex.sh é o da versão NOVA (pasta recém-trocada).
say "Reinstalando e reiniciando o serviço ($SERVICE_NAME)"
exec bash "$APP_DIR/frinus/bin/install-cortex.sh" --service "$SERVICE_NAME"
