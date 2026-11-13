# Frinus Córtex — perfil local-cliente (POC)

Fork do [Habblaud](https://github.com/marmottajr/habblaud) (MIT, autor Márcio Junior)
como interface visual do cliente Frinus, no lugar do terminal. Esta pasta reúne só o
que é próprio do Frinus; o resto do código é o Habblaud.

## Como rodar

```bash
npm ci            # uma vez
npm run build     # compila client + server (dist/)
frinus/bin/frinus-office   # sobe em http://127.0.0.1:4748
```

## Instalação de uma vez (Linux / WSL)

```bash
frinus/bin/install-office.sh            # build + mod nas contas Frinus + serviço + atalho
frinus/bin/install-office.sh --dry-run  # mostra tudo o que faria, sem alterar nada
```

O `install-office.sh` é **idempotente** (pode rodar de novo) e faz, nesta ordem:

1. **build** (client + server) em `dist/` — `npm ci` só na primeira vez;
2. **`npm run mod:install`** com `FRINUS_ONLY=1`, ou seja, SÓ nas contas que têm o MCP do Frinus
   (é o que faz os cartões de permissão e mensagem chegarem ao escritório). Pula com um aviso se o
   `claude` não estiver no PATH;
3. **serviço `systemd --user frinus-office`** na porta 4748 (`ExecStart` = `frinus/bin/frinus-office`).
   Não encosta no `habblaud.service` de produção (4747): nome, pasta e porta diferentes;
4. **atalho `.desktop`** ("Frinus Córtex") que sobe o serviço e abre a tela no navegador
   (em WSL, via `wslview`/`powershell.exe`).

Opções: `--skip-build`, `--skip-mod`, `--no-service`, `--no-desktop`, `--service <nome>` (nome
alternativo do serviço, útil para testar sem tocar no `frinus-office` real).

> **WSL:** o serviço systemd `--user` exige systemd ligado (`/etc/wsl.conf` com `[boot] systemd=true`
> e `wsl --shutdown`). Sem ele, o instalador avisa e o escritório pode ser subido à mão com
> `frinus/bin/frinus-office`.

## O que o perfil faz (`office.env`)

- **Loopback only**: `HABBLAUD_HOST=127.0.0.1`, porta `4748` (não colide com o
  Habblaud de produção na 4747).
- **Novo agente + janela do agente** ligados (`HABBLAUD_PTY=1`), só por serem bind local.
- **World** desligado (`HABBLAUD_WORLD=0`) e **auto-update** desligado
  (`HABBLAUD_UPDATE_CHECK=0`); sem `HABBLAUD_REMOTE_*`.
- **Lançador Frinus**: `HABBLAUD_CLAUDE_BIN=frinus/bin/frinus-claude`, que roda
  `claude --agent frinus "$@"` — todo "Novo agente" nasce como o orquestrador com memória.
- **Só contas com Frinus (`FRINUS_ONLY=1`)**: o escritório monitora e exibe SOMENTE as contas do
  Claude Code que têm o MCP do Frinus configurado (`mcpServers` com `frinus-mcp` — por nome do
  servidor, pelo pacote em `command`/`args` ou pela env `FRINUS_API_KEY`; ver
  `hasFrinusMcp` em `server/accounts/detect.ts`). Contas sem Frinus **não aparecem e não são lidas**.
  O filtro vale também para `CLAUDE_CONFIG_DIR` e `HABBLAUD_CLAUDE_DIRS`. Sem segredo é lido: só
  nomes de servidor e nomes de chaves de env, nunca o valor de uma env.
- **Nome amigável automático**: sem `HABBLAUD_ACCOUNTS`, o nome de cada conta vem da **organização**
  do perfil (`oauthAccount.organizationName`, quando significativa e única entre as contas) e, sem
  ela, do **nome da pasta** (`.claude-rdx` → "Rdx", `.claude-supermaxi` → "Supermaxi"). Duas contas
  logadas na mesma organização caem no nome da pasta para não ficarem com o mesmo nome.
- **Multi-conta (padrão)**: o cliente pode ter várias contas. Sem `HABBLAUD_CLAUDE_DIRS`, o escritório
  descobre sozinho as pastas `~/.claude*` (com `projects/` ou `sessions/`). Cada sala/conta abre o
  `frinus` **na sua própria conta**: ao assumir ou abrir "Nova sessão", o Habblaud exporta o
  `CLAUDE_CONFIG_DIR` da conta escolhida (`server/pty/manager.ts`) e o `frinus-claude` respeita
  (não sobrescreve). **Conta única** é só um caso particular: deixar uma só pasta `~/.claude*` ou,
  no limite, definir `FRINUS_OFFICE_CLAUDE_DIR` (fallback usado apenas quando o chamador não
  escolheu conta).
- **Estado separado** do Habblaud de produção: `HABBLAUD_DATA_DIR=~/.frinus-office`
  (o Habblaud padrão usa `~/.habblaud`).

### Ressalva multi-conta — "Novo agente" em segundo plano

O **"Assumir" / "Nova sessão"** no terminal embutido (PTY, `server/pty/manager.ts`) escolhe a
conta certa e exporta o `CLAUDE_CONFIG_DIR` dela — multi-conta funciona por aí. Já o **"Novo
agente"** em segundo plano (`server/spawn/spawn.ts`, `claude --bg`) **não** carrega conta: o
`SpawnRequest` só tem `{folder, prompt}` e o `createCliRunner` roda o `claude` herdando o ambiente
do servidor, sem setar `CLAUDE_CONFIG_DIR`. Hoje, portanto, um "Novo agente" nasce na conta padrão
(`~/.claude`), não na conta da sala. É uma lacuna **do Habblaud** (upstream), não do fork. O que
faltaria: incluir `account` no `SpawnRequest`/`parseSpawn` e, no `createCliRunner`, injetar
`env.CLAUDE_CONFIG_DIR` da conta escolhida (igual ao manager). Fora do escopo desta POC.

## Pasta de trabalho padrão (~/Frinus)

Não há variável de ambiente para forçar a pasta inicial do "Novo agente". O cliente
hoje escolhe a pasta no cartão de Novo agente, e o navegador lembra a última em
`localStorage` (`habblaud.spawn.folder`) + oferece as pastas recentes de
`GET /api/spawn/folders`. `frinus-office` cria `~/Frinus`, mas para que ela venha
**pré-selecionada** é preciso uma mudança de cliente em `client/src/ui/spawn.ts`:
semear `this.selected`/`this.folder.value` com `~/Frinus` quando não houver última
pasta salva (hoje o `placeholder` é fixo `/Users/voce/projeto`, l.142; o valor inicial
sai de `LAST_FOLDER_KEY`, l.23). Fica para o Item 3 (tema) ou uma tarefa à parte.

## Mod e a porta do escritório (permissão e mensagem na 4748)

O mod por conta (`npm run mod:install`, plugins `habblaud-permissoes` / `habblaud-mensagens`) é o
que faz os cartões de **permissão** e **mensagem** chegarem ao escritório. **A porta NÃO é fixa**:
os hooks a descobrem em tempo de execução a partir do ambiente da sessão.

- Precedência no hook de permissão (`mod/habblaud-permissoes/hooks/permission-hook.mjs`):
  `--port` > env `HABBLAUD_PORT` > padrão `4747`. Como plugin do marketplace o comando não passa
  `--port`, então vale o `HABBLAUD_PORT`.
- O plugin de mensagens (`mod/habblaud-mensagens/hooks/register.ts`) lê a porta só de
  `HABBLAUD_PORT` (`$.env.get('HABBLAUD_PORT')`), caindo em `4747`.

O **Frinus Córtex injeta `HABBLAUD_PORT=4748`** em toda sessão que abre: o `office.env` exporta a
variável e o servidor a repassa tanto ao terminal/PTY (`server/pty/manager.ts` — `HABBLAUD_PORT`
não está em `INHERITED_SESSION_VARS`) quanto ao "Novo agente" em segundo plano (`server/spawn/spawn.ts`
roda o `claude` herdando o ambiente do servidor). Logo, as sessões abertas pela 4748 falam com a 4748.

**Coexistência com o Habblaud de produção (4747):** a MESMA instalação do mod serve os dois
escritórios. Uma sessão aberta pelo `habblaud.service` (sem `HABBLAUD_PORT`, ou com 4747) fala com
a 4747; uma sessão aberta pelo Frinus Córtex fala com a 4748. Nada é gravado por conta apontando
para uma porta só — por isso não há conflito e nada precisa ser reinstalado ao alternar.

Instalar o mod nas contas com Frinus: `frinus/bin/install-office.sh` (passo 2, com `FRINUS_ONLY=1`),
ou `FRINUS_ONLY=1 npm run mod:install`. ⚠️ O `mod:install` mexe nas contas `~/.claude*` usadas ao
vivo — use `--dry-run` para conferir antes.
