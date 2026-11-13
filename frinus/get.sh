#!/usr/bin/env bash
# Frinus Córtex — instalador de 1 comando (Linux, WSL e macOS).
#
#   curl -fsSL https://github.com/frinus-ai/frinus-cortex/releases/latest/download/install.sh | bash
#
# Publicado em cada release como "install.sh" (fonte: frinus/get.sh no repositório). Faz:
#   1) baixa a versão PRONTA (já compilada) do Frinus Córtex para este sistema, confere o SHA-256 e coloca em
#      ~/.local/share/frinus-office (troca atômica: numa atualização, a versão anterior só sai depois que a nova
#      está completa; contas, conversas e configurações ficam em outras pastas e não são tocadas);
#   2) chama o instalador de dentro da versão (frinus/install.sh --gui), que instala Node e Claude Code se
#      faltarem, PEDE A CHAVE do Frinus (digitada escondida), liga a memória, instala o escritório, o início
#      automático e o atalho, e abre no navegador.
#
# Rodar de novo = atualizar/reparar. Opções (repassadas ao instalador): --dictation, --alias <apelido>, --dry-run.
# Variáveis: FRINUS_OFFICE_VERSION=v0.1.0 (fixa uma versão), FRINUS_API_KEY (pula a pergunta da chave),
#            FRINUS_OFFICE_DIR (pasta de instalação).
set -euo pipefail

REPO="frinus-ai/frinus-cortex"
APP_DIR="${FRINUS_OFFICE_DIR:-$HOME/.local/share/frinus-office}"
VERSION="${FRINUS_OFFICE_VERSION:-latest}"

ROXO=$'\033[1;35m'; VERM=$'\033[1;31m'; FIM=$'\033[0m'
say()  { printf '\n%s==>%s %s\n' "$ROXO" "$FIM" "$*"; }
fail() { printf '\n%sErro:%s %s\n' "$VERM" "$FIM" "$1" >&2; [ -n "${2:-}" ] && printf '%s\n' "$2" >&2; exit 1; }

DRY_RUN=0
for a in "$@"; do [ "$a" = --dry-run ] && DRY_RUN=1; done

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
asset="frinus-office-${os}-${arch}.tar.gz"
if [ -n "${FRINUS_OFFICE_BASE_URL:-}" ]; then
  base="$FRINUS_OFFICE_BASE_URL"     # testes: servidor local com os mesmos assets da release
elif [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

say "Frinus Córtex — baixando a versão pronta ($os-$arch, $VERSION)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fL --retry 3 --progress-bar -o "$tmp/$asset" "$base/$asset" \
  || fail "Não consegui baixar o Frinus Córtex." "Verifique sua internet e rode o mesmo comando de novo."
curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" \
  || fail "Não consegui baixar a verificação do arquivo (SHA256SUMS)."

expected="$(awk -v f="$asset" '$2==f || $2=="*"f {print $1}' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || fail "A verificação não lista $asset."
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
else got="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"; fi
[ "$got" = "$expected" ] || fail "O arquivo baixado está corrompido (SHA-256 não confere)." "Rode o comando de novo."
echo "   verificado (SHA-256 ok)"

mkdir -p "$tmp/new"
tar -xzf "$tmp/$asset" -C "$tmp/new"
[ -f "$tmp/new/frinus/install.sh" ] && [ -f "$tmp/new/dist/server/index.js" ] || fail "Pacote incompleto."

if [ "$DRY_RUN" = 1 ]; then
  say "dry-run: instalaria $(cat "$tmp/new/.release" 2>/dev/null) em $APP_DIR"
  bash "$tmp/new/frinus/install.sh" --gui "$@"
  exit 0
fi

# Troca atômica: a pasta antiga só sai depois que a nova está no lugar.
mkdir -p "$(dirname "$APP_DIR")"
rm -rf "$APP_DIR.new" "$APP_DIR.old"
mv "$tmp/new" "$APP_DIR.new"
[ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.old"
mv "$APP_DIR.new" "$APP_DIR"
rm -rf "$APP_DIR.old"
echo "   instalado em $APP_DIR ($(cat "$APP_DIR/.release" 2>/dev/null))"

exec bash "$APP_DIR/frinus/install.sh" --gui "$@"
