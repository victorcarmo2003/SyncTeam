# Tools/ — testes autônomos do SyncTeam (sem intervenção do usuário)

Esta pasta reúne o que a IA (Claude Code) precisa para testar o SyncTeam
sozinha contra os 2 Studios reais que o usuário já deixa abertos (mesma
máquina, 2 contas Roblox via "Add Account", mesma pasta de Plugins) —
sem depender do usuário copiar/colar o Output do Studio nem clicar em nada,
depois da configuração inicial de portas (uma vez só, ver "Setup inicial").

Contexto do porquê disso existir: `docs/PROJECT_STATUS.md` (buscar
"autônomo"/"Tools/") e `docs/DECISIONS.md` (entradas 2026-07-07 sobre o
split-brain do M3.1, achadas justamente num teste manual que motivou essa
automação).

## Peça-chave: log do Studio sem copiar/colar

O plugin (`plugin/src/Logger.luau`) encaminha TODO log que hoje vai pro
`print()`/Output do Studio também como mensagem WebSocket espontânea
`{kind: "log", text: "<mesmo texto do Output>"}` pela MESMA conexão que já
existe com o harness/extensão local (nenhuma conexão nova, nenhum limite
extra de `WebStreamClient`). O harness (`vscode-extension/tools/run-node-harness.ts`)
grava isso — junto com os próprios logs do harness (ex.: "Studio → disco:
...") — num arquivo texto, um por porta/Studio, quando a env var
`SYNCTEAM_LOG_FILE` está setada. Isso resolve o problema citado pelo
usuário de "o MCP do Roblox pode bugar ou só apontar 1 Studio dos 2" —
não dependemos do MCP pra observabilidade, cada Studio já fala com seu
próprio harness local e cada harness grava seu próprio arquivo.

**Formato exato da linha gravada** (confirmado por smoke test real do
`extension-dev`, 2026-07-07):
```
[SyncTeam harness] <timestamp ISO> [studio] [SyncTeam HH:MM:SS] <mensagem original do plugin>
[SyncTeam harness] <timestamp ISO> <mensagem própria do harness, ex.: "Studio → disco: ...">
```
Linhas que vieram do plugin sempre têm a tag `[studio]` logo após o
timestamp do harness — `grep '\[studio\]' Tools/logs/studio-34980.log`
isola só o que aconteceu dentro daquele Studio; `grep -v '\[studio\]'`
isola só o próprio harness (sincronização Studio↔disco, conexão/desconexão
etc.). Linhas de warn/error do harness levam `WARN `/`ERROR ` extra logo
depois do timestamp. Detalhes de implementação:
`.claude/agent-memory/luau-dev.md` (`plugin/src/Logger.luau`) e
`.claude/agent-memory/extension-dev.md` (`createFileLogger`/`createTeeLogger`
em `vscode-extension/src/util/logger.ts`, roteamento em
`SyncTeamService.routeSpontaneous`, env var `SYNCTEAM_LOG_FILE` lida em
`run-node-harness.ts`).

## MCP do Roblox Studio

Já configurado (`claude mcp add ... Roblox_Studio`, ver comando em
`docs/DECISIONS.md`/histórico do chat) e a conexão do processo MCP está OK
(`claude mcp list` mostra "✔ Connected"), mas **as ferramentas dele não
apareceram disponíveis na sessão em que foi adicionado** — pelo padrão
observado, MCP adicionado a meio de sessão só populam a lista de tools
depois de reiniciar o Claude Code. Se uma sessão nova ainda não vir com
`mcp__Roblox_Studio__*` disponível via `ToolSearch`, é só isso, não é bug —
tente de novo depois de um restart. Mesmo quando disponível, o usuário já
avisou que pode só enxergar 1 dos 2 Studios — trate o MCP como
complementar (ex.: rodar um comando pontual dentro do Studio), não como o
canal principal de observação, que é o log em arquivo descrito acima.

## Setup inicial (uma vez por sessão de Studios, ação do usuário)

Os dois Studios compartilham a MESMA pasta de Plugins (mesma máquina, 2
contas via "Add Account") — então os dois carregam o MESMO arquivo de
plugin e por padrão os dois tentam a MESMA porta (34980). Para simular 2
devs de verdade (cada Studio falando com seu próprio harness/porta), UM dos
dois Studios precisa clicar o botão de toolbar **"SyncTeam: Alternar porta
(34980/34981)"** (adicionado no M3.1, só existe dentro do próprio script do
plugin — `plugin:SetSetting` não é chamável pelo Command Bar, já
confirmado em teste real). Isso só precisa ser refeito se os dois Studios
acabarem na mesma porta de novo (ex.: os dois clicaram o botão um número
ímpar de vezes juntos) — dá pra confirmar pelos logs de conexão em cada
harness (ver abaixo).

## Fluxo de teste autônomo (o que a IA faz sozinha depois do setup)

1. **Build + deploy do plugin** (sempre que o código Luau mudar):
   ```
   Tools/build-and-deploy-plugin.sh
   ```
   Builda via `rojo build` e copia (delete+copy, força auto-refresh) para
   `%LOCALAPPDATA%\Roblox\Plugins\SyncTeam.rbxm`. Os Studios abertos
   recarregam sozinhos (auto-start já embutido no plugin).

2. **Subir os dois harnesses** (uma vez, ficam rodando; rode cada um com
   `Bash(..., run_in_background: true)` — são processos de servidor, não
   terminam sozinhos):
   ```
   Tools/start-harness.sh 34980 spikes/m1-test-project
   Tools/start-harness.sh 34981 spikes/m1-test-project-b
   ```
   Cada um builda a extensão (esbuild) e sobe o harness Node real
   (`SyncServer`+`SyncTeamService`+`SyncBridge`, os mesmos módulos de
   produção, só com `NodeDiskIO` em vez de `VscodeDiskIO` — ver
   `vscode-extension/tools/run-node-harness.ts`). Log combinado
   (harness + Studio encaminhado) em `Tools/logs/studio-<porta>.log`.

3. **Ler os logs sozinho** — use a ferramenta de leitura de arquivo
   diretamente em `Tools/logs/studio-34980.log` / `studio-34981.log`, ou
   rode:
   ```
   Tools/check-leader-convergence.sh
   ```
   para uma checagem rápida de convergência de líder (grep das últimas
   linhas de anúncio/observação de liderança nos dois arquivos).

4. **Disparar uma "edição de dev"** sem precisar de VS Code de verdade:
   edite diretamente um arquivo sob `spikes/m1-test-project/src/...` (afeta
   o Studio conectado no harness A/34980) ou
   `spikes/m1-test-project-b/src/...` (Studio no harness B/34981) — o
   `NodeDiskIO.watch` do harness detecta a mudança e manda `writeSource`
   pro plugin automaticamente, exatamente como a extensão real faria.
   **Importante**: os dois projetos de teste usam os MESMOS pontos de
   montagem (`ReplicatedStorage/Shared`, `ServerScriptService/Server`,
   `StarterPlayer/StarterPlayerScripts/Client` — ver os dois
   `default.project.json`), e como os 2 Studios estão na MESMA place via
   Team Create, editar o "mesmo" caminho relativo (ex.:
   `src/server/Renamed.server.luau`) nas duas pastas atinge o MESMO script
   replicado (mesmo uuid) — é assim que dá pra testar rejeição de lease
   (M3.2) sem VS Code nenhum aberto: edite dos dois lados e leia nos logs
   quem foi aceito/negado.

5. **Repetir 1-4** conforme o código for mudando, sem precisar do usuário
   até ter um resultado (bom ou ruim) que valha a pena reportar.

## Limitações conhecidas (não são bugs, são o design do M1)

- Cada harness só aceita 1 plugin conectado por vez (mensagem
  "SyncTeam M1 suporta apenas 1 plugin conectado por vez" no log) — é
  proposital, simula "1 dev = 1 extensão". Se os dois Studios acabarem
  mirando a mesma porta, um dos dois vai ficar preso em loop de reconexão
  rejeitada — sinal de que o setup inicial (ver acima) precisa ser
  refeito.
- O harness não sobrevive a `Ctrl+C`/fechar o terminal — se eu (a IA)
  precisar reiniciar um harness, mate o processo anterior antes (ver PID
  seria seu próprio controle de processo em background — use `TaskOutput`/
  o mecanismo de tarefas em background do próprio Claude Code, não há
  script de "stop" aqui porque cada sessão já rastreia seus próprios
  processos em background nativamente).
- Falha de eleição/lease encontrada durante testes autônomos: documentar
  em `docs/DECISIONS.md` (mesmo padrão já usado, ex.: entrada do
  split-brain de 2026-07-07) e `docs/PROJECT_STATUS.md`, igual a qualquer
  outro achado de teste real — a automação muda COMO o teste é feito, não
  a disciplina de registrar resultado (`.claude/rules/workflow.md`).
