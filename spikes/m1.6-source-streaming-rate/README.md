# Spike M1.6 — Taxa de streaming de Source (handoff quase-instantâneo)

Pergunta: dá para substituir o lease exclusivo atual (dono muda só em
save/pausa, expira 8s sem Pulse) por um **handoff quase-instantâneo**, com
streaming em tempo real do Source do dono atual (read-only) para o outro dev
ver aparecendo, escrevendo via `ScriptEditorService:UpdateSourceAsync` em
taxa fixa? O usuário pediu para testar 15Hz/30Hz/60Hz — este spike testa
2/5/15/30/60Hz para ter pontos de comparação abaixo da faixa também.

Contexto já levantado, não repetir pesquisa antes de mexer aqui:
`.claude/research/2026-08-02-realtime-source-streaming-team-create.md` —
não existe patch incremental (sempre reescreve a string inteira), não existe
rate-limit numérico documentado pela Roblox, mas o Rojo
(`rojo-rbx/rojo#1273`) já tentou sync automático "enquanto digita" e
reverteu por causar "repeated writes/server echoes" e cursor pulando no
Script Editor.

## O que este spike mede

1. **Latência/perda de replicação em taxa fixa** — Studio A escreve um
   contador incremental na `Source` de um script de teste a 2/5/15/30/60Hz
   (~12s cada), Studio B observa via sinal (`GetPropertyChangedSignal`) E
   via polling fino (50ms). Quantos valores intermediários o lado B
   efetivamente viu vs quantos foram escritos, e latência ponta-a-ponta.
2. **Cursor-jump/echo com o editor nativo aberto no mesmo Script** — reproduz
   o sintoma relatado pelo Rojo. **Este item é 100% manual** (ver seção
   própria abaixo) — não há API para abrir o Script Editor nativo de um
   Studio remotamente, então não dá para automatizar.
3. **Fora de escopo**: Live Scripting Beta (feature opcional, exigiria ligar
   manualmente nos 2 Studios — não testado aqui).

## Como a latência é medida (leia antes de interpretar os números)

Deliberadamente **não** usa nenhum timestamp gerado dentro do Studio
(`DateTime.now()`/`UnixTimestampMillis` nunca foram confirmados em
`.claude/research/` — a regra do projeto proíbe codar sobre hipótese de
API). Em vez disso, cada Studio manda só um número de sequência (`n`) e a
taxa (`rateHz`) por WebSocket para `control-server.mjs` (Node, roda uma vez
na máquina local), e é **o servidor Node** — relógio único, comparável
entre os 2 Studios porque os dois rodam na mesma máquina e falam com o
mesmo processo — quem carimba o instante de **recebimento** de cada evento
`write`/`observed`.

Consequência: a latência calculada inclui o hop WS Studio→servidor dos dois
lados (viés pequeno e aproximadamente constante, não é a latência pura do
Team Create) — mas é suficiente para **comparar taxas entre si**, que é o
objetivo real aqui. Se um número absoluto de latência pura do Team Create
for necessário no futuro, isso exigiria confirmar `DateTime.UnixTimestampMillis`
via `researcher` primeiro.

## Pré-requisitos

Os 2 Studios reais já abertos, Team Create ativo, mesma place — reaproveita
exatamente o "Setup inicial" já documentado em `Tools/README.md` (2 contas
Roblox na mesma máquina, mesma pasta de Plugins). Node.js instalado.

## Roteiro

1. **Instalar dependências e subir o control-server** (uma vez, fica
   rodando):
   ```
   cd spikes/m1.6-source-streaming-rate
   npm install
   node control-server.mjs
   ```
   Espera-se: `[rate-spike-server] ouvindo em ws://127.0.0.1:35990` e
   `[rate-spike-server] gravando em ./logs/rate-spike-<timestamp>.jsonl`.

2. **Copiar `SyncTeamRateSpike.lua`** para a pasta de plugins locais do
   Studio (mesmo caminho do spike M0):
   `%LOCALAPPDATA%\Roblox\Plugins`. Como os 2 Studios compartilham a mesma
   pasta, os dois carregam o mesmo arquivo automaticamente — cada um decide
   o papel pelo botão clicado (ver passo 3), não pelo arquivo.

3. **Um clique por Studio** (única interação manual necessária para o item
   1 — mesmo padrão já usado no spike M0, que também exigiu 1 clique por
   papel):
   - **Studio A**: toolbar "SyncTeam RateSpike" → **"RateSpike: Escritor"**.
     A partir daqui ele cicla sozinho pelas 5 taxas (2/5/15/30/60Hz, ~12s
     cada + 1s de folga entre fases) sem mais nenhuma interação — leva
     cerca de 65-70s no total.
   - **Studio B**: toolbar "SyncTeam RateSpike" → **"RateSpike: Observador"**.
     Fica escutando até "RateSpike: Parar" ou o plugin descarregar — não
     precisa ser clicado de novo entre fases.
   - Ordem não importa muito (o observador espera até 60s pelo alvo
     aparecer via replicação caso clique primeiro).

4. **Esperar ~70s**, depois no terminal do control-server: `Ctrl+C` (ou
   deixar rodando, ele aceita rodadas repetidas se quiser comparar
   execuções — cada rodada tende a criar um `.jsonl` novo pelo timestamp no
   nome do arquivo default).

5. **Analisar o resultado**:
   ```
   node analyze-log.mjs ./logs/rate-spike-<timestamp>.jsonl
   ```
   Imprime, por taxa: writes enviados, quantos distintos o observador viu
   via sinal e via poll (com %), e latência min/p50/p95/max de cada via.
   `distintos < enviados` = perda/coalescing real.

6. **Registrar o resultado real** em `docs/DECISIONS.md` (nova entrada,
   preenchendo os números medidos) e atualizar
   `.claude/agent-memory/luau-dev.md` com qualquer pegadinha encontrada.
   Marcar como `[Verificado]` só o que este roteiro realmente mediu.

## Item 2 — cursor-jump com editor nativo aberto (100% manual)

Não automatizável (sem API para controlar o Script Editor de um Studio
remotamente, e "digitar de propósito enquanto o teste roda" exige uma
pessoa física). Roteiro para quem for rodar isso:

1. No **Studio A** (o que vai clicar "RateSpike: Escritor"), **antes** de
   clicar o botão, abra `TestService > SyncTeamRateSpike > Target` no
   Script Editor nativo (duplo clique no Explorer). Deixe a janela do
   editor em foco.
2. Clique "RateSpike: Escritor" e observe o editor aberto durante as fases
   de 15/30/60Hz especialmente (as mais agressivas).
3. Anotar objetivamente: o cursor pula para o fim do texto sozinho? A
   digitação (se você tentar digitar algo no meio do teste) é
   perdida/sobrescrita? Aparece algum erro/toast do Studio (ex.: "Kicked
   from Live Scripting Session", erro de operação ilegal)? A UI trava ou
   fica lenta?
4. Repetir com Live Scripting Beta DESLIGADO (padrão) — não testar ligado
   neste spike (fora de escopo, decisão já registrada acima).

Sem essa observação, o item 2 fica `[Decisão pendente]` — não inventar um
resultado.

## Limitações conhecidas deste spike

- `n` é monotônico crescente ao longo de TODAS as 5 fases (nunca reseta) —
  facilita a correlação na análise, não afeta a medição.
- O alvo (`TestService.SyncTeamRateSpike.Target`) fica fora de qualquer
  watched root da produção (`Config.getWatchedRoots()`: ServerScriptService,
  StarterPlayerScripts, ReplicatedStorage, ReplicatedFirst, ServerStorage,
  StarterGui, Workspace) — deliberado, para o plugin de produção (já
  rodando nos mesmos 2 Studios via `Tools/`) não tentar sincronizar este
  script de teste para o projeto VS Code real.
- Porta do control-server (35990) é distinta da produção (1400/1401) e dos
  harnesses de teste (34980/34981) — sem conflito ao rodar tudo junto.
- Polling do observador (50ms) é só o instrumento de medição deste spike —
  não é uma proposta de mudar `Config.POLL_INTERVAL_SECONDS` (0.5s) de
  produção.
- Código descartável de validação — não é o produto, não portar para
  `plugin/src` sem reavaliar (identidade aqui é por path fixo, não
  UUID+ObjectValue — proibido em produção, aceitável num spike isolado que
  não usa `ScriptRegistry`).
