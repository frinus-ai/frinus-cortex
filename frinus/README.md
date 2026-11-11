# Frinus Office — perfil local-cliente (POC)

Fork do [Habblaud](https://github.com/marmottajr/habblaud) (MIT, autor Márcio Junior)
como interface visual do cliente Frinus, no lugar do terminal. Esta pasta reúne só o
que é próprio do Frinus; o resto do código é o Habblaud.

## Como rodar

```bash
npm ci            # uma vez
npm run build     # compila client + server (dist/)
frinus/bin/frinus-office   # sobe em http://127.0.0.1:4748
```

## O que o perfil faz (`office.env`)

- **Loopback only**: `HABBLAUD_HOST=127.0.0.1`, porta `4748` (não colide com o
  Habblaud de produção na 4747).
- **Novo agente + janela do agente** ligados (`HABBLAUD_PTY=1`), só por serem bind local.
- **World** desligado (`HABBLAUD_WORLD=0`) e **auto-update** desligado
  (`HABBLAUD_UPDATE_CHECK=0`); sem `HABBLAUD_REMOTE_*`.
- **Lançador Frinus**: `HABBLAUD_CLAUDE_BIN=frinus/bin/frinus-claude`, que roda
  `claude --agent frinus "$@"` — todo "Novo agente" nasce como o orquestrador com memória.
- **Conta isolada**: observa e usa só `~/.claude-rdx`
  (`HABBLAUD_CLAUDE_DIRS` + `FRINUS_OFFICE_CLAUDE_DIR` → `CLAUDE_CONFIG_DIR`).
- **Estado separado** do Habblaud de produção: `HABBLAUD_DATA_DIR=~/.frinus-office`
  (o Habblaud padrão usa `~/.habblaud`).

## Pasta de trabalho padrão (~/Frinus)

Não há variável de ambiente para forçar a pasta inicial do "Novo agente". O cliente
hoje escolhe a pasta no cartão de Novo agente, e o navegador lembra a última em
`localStorage` (`habblaud.spawn.folder`) + oferece as pastas recentes de
`GET /api/spawn/folders`. `frinus-office` cria `~/Frinus`, mas para que ela venha
**pré-selecionada** é preciso uma mudança de cliente em `client/src/ui/spawn.ts`:
semear `this.selected`/`this.folder.value` com `~/Frinus` quando não houver última
pasta salva (hoje o `placeholder` é fixo `/Users/voce/projeto`, l.142; o valor inicial
sai de `LAST_FOLDER_KEY`, l.23). Fica para o Item 3 (tema) ou uma tarefa à parte.

## Limitação conhecida — mod/plugins apontam para a 4747

O mod por conta (`npm run mod:install`, plugins `habblaud-mensagens` /
`habblaud-permissoes`) é instalado nas contas `~/.claude*` e é o que faz os cartões de
**mensagem** e de **permissão** chegarem ao escritório. Esse mod descobre o endereço do
Habblaud a partir da **porta fixa 4747** (o serviço systemd de produção): os hooks
instalados nas contas falam com `127.0.0.1:4747`, não com a 4748 deste escritório.

Consequência na POC: abrir pela 4748 mostra o escritório, o "Novo agente" e a janela do
agente (PTY) funcionam, mas **mensagem/permissão pela 4748 podem não funcionar**, porque
o hook entrega esses eventos à 4747.

O que seria preciso (fora do escopo do Item 1/2): tornar a porta do mod configurável por
conta — um env/arquivo lido pelos hooks (ex.: `HABBLAUD_URL`/`HABBLAUD_PORT` por conta,
ou um `~/.claude-rdx`-scoped config) — e reinstalar o mod apontando para a 4748. Confirmar
em `scripts/mod-install.ts` e nos plugins em `mod/` como a porta é resolvida hoje.
⚠️ NÃO rodar `npm run mod:install` aqui: ele mexe nas contas `~/.claude*` usadas ao vivo.
