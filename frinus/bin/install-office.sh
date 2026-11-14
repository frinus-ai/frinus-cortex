#!/usr/bin/env bash
# install-office.sh — shim de compatibilidade (remover na 0.3.0). Só executa o install-cortex.sh.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$here/install-cortex.sh" "$@"
