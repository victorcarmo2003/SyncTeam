# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é o SyncTeam

Plugin de Roblox Studio + extensão VS Code que permitem que **vários desenvolvedores editem código Luau no VS Code ao mesmo tempo**, usando o **Team Create do Roblox como transporte e autoridade** — sem servidor externo e sem fork do Rojo. Resolve o problema do fluxo unidirecional do Rojo (VS Code → Roblox), em que um dev sobrescreve o código do outro.

## Arquitetura (visão geral)

```
Dev A                                              Dev B
VS Code + extensão SyncTeam                        VS Code + extensão SyncTeam
(hospeda WebSocket em localhost)                   (idem)
        ▲                                                ▲
        ▼ HttpService:CreateWebStreamClient              ▼
Studio A + plugin SyncTeam ◄──── Team Create ────► Studio B + plugin SyncTeam
                            (replicação nativa Roblox:
                             Source + TestService.SyncTeam)
```

- **Fluxo de uma edição**: dev digita no VS Code → extensão envia ao plugin via WebSocket local → plugin escreve `Source` no DataModel → Team Create replica ao Studio do outro dev → plugin do outro dev detecta e grava no disco → arquivo atualiza no VS Code dele.
- **Não existe servidor externo.** A extensão VS Code hospeda um servidor WebSocket em localhost; o plugin Studio conecta como cliente via `CreateWebStreamClient` (limite documentado: 6 clientes por Studio).
- **Plano de controle** (sessões, heartbeats, eleição de líder, leases, presença/cursores): instâncias de valores (`StringValue`/`IntValue`/`ObjectValue`) sob `TestService.SyncTeam`, replicadas pelo Team Create.
- **Roblox é autoritário**: na conexão inicial, o estado do Studio é puxado para o disco.

## Decisões registradas

Ver [docs/DECISIONS.md](docs/DECISIONS.md). As principais:

- **v1 sincroniza apenas scripts** (Script/LocalScript/ModuleScript): Source, create, rename, move, delete. Nada de propriedades de instâncias não-script.
- **Conflito no mesmo arquivo = lease por arquivo**: quem começa a editar vira dono temporário; o outro vê o arquivo somente-leitura com aviso. Sem preempção; posse expira com inatividade.
- **Compatibilidade total com o formato de projeto Rojo**: mesmo `default.project.json`, mesmas convenções (`*.server.luau`, `*.client.luau`, `init.*`, `src/server|client|shared` + pastas extras do usuário). O time pode alternar Rojo ↔ SyncTeam a qualquer momento.
- **Identidade de script**: UUID + `ObjectValue` apontando para a Instance (sobrevive a rename/move, detecta delete/recreate). Nunca usar path nem attributes como identidade.

## Base de referência: RojoCoop

`c:/Users/hakor/Documents/GitHub/RojoCoop` contém a tentativa anterior (fork do Rojo 7.7.0-rc.1, codinome ModuxSync), **abandonada pelo custo de manter o fork**, mas com componentes validados em dois Studios reais que devem ser portados, não reinventados:

| Componente | Onde está | Status |
|---|---|---|
| Schema de metadados Team Create | `rojo-7.7.0-rc.1/plugin/src/TeamCreateSchema.lua` | Validado (2 Studios) |
| Eleição de líder + heartbeat (2s pulse / 8s stale / 20s cleanup) | `plugin/src/TeamCreateElection.lua` | Validado, inclusive failover forçado |
| Leases determinísticas sem preempção | `plugin/src/TeamCreateShadowLease.lua` | Validado |
| Coordenador (sessões, intents, registry de scripts) | `plugin/src/TeamCreateCoordinator.lua` | Validado |
| Extensão VS Code (cursores, presença, decorações, leases, 33 testes) | `vscode-extension/src/` | Validado |
| Serialização Studio→disco no formato Rojo | Rust (`src/`) — precisa ser reescrita em TypeScript | Lógica validada (261 arquivos corretos) |

O que o RojoCoop **não** validou (e é a hipótese central do SyncTeam): replicação de `Source` via Team Create. É o objetivo do spike M0 em `spikes/m0-source-replication/`.

## Estrutura do repositório

- `docs/` — arquitetura, marcos (M0–M5 com critérios de aceite), status/handoff, decisões.
- `spikes/` — código de validação descartável, um diretório por spike.
- `plugin/` — (a partir do M1) plugin Studio em Luau, buildado com Rojo (`rojo build`) apenas como ferramenta de build.
- `vscode-extension/` — (a partir do M1) extensão em TypeScript.
- `.claude/` — agentes, regras, memória de agentes e resultados de pesquisa (ver abaixo).
- `Tools/` — scripts para eu (a IA) testar sozinha contra os 2 Studios reais que o usuário deixa abertos (build+deploy do plugin, subir harness Node, ler log do Studio sem copiar/colar). Ver [Tools/README.md](Tools/README.md) antes de pedir ao usuário para colar Output — pode já dar pra ler direto.

## Agentes e regras (.claude/) — pedido explícito do usuário

Regras que valem para toda sessão:

@.claude/rules/workflow.md

Regras por stack (carregar quando for tocar na área): [.claude/rules/luau.md](.claude/rules/luau.md) e [.claude/rules/typescript.md](.claude/rules/typescript.md).

**Delegação obrigatória para tarefas não-triviais** — o usuário pediu que a sessão principal NÃO code o que é de agente:

- `researcher` — confirmar API/comportamento externo na web; salva em `.claude/research/`.
- `luau-dev` — plugin Studio, Luau, schema Team Create.
- `extension-dev` — extensão VS Code, TypeScript, harness Node.
- `ui-dev` — tudo que o usuário vê (decorações, painéis, widgets, textos de UI).

Cada agente mantém memória própria em `.claude/agent-memory/<nome>.md`. Antes de codar sobre API nova, os agentes de código consultam `.claude/research/`; sem resposta lá, a tarefa volta ao `researcher`.

## Disciplina de trabalho

- [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) é o handoff vivo: leia ao começar, atualize ao terminar trabalho significativo.
- Marque afirmações como `[Verificado]` / `[Hipótese]` / `[Decisão pendente]` nos docs — só promova a `[Verificado]` após teste real (idealmente em dois Studios).
- Validações que envolvem Team Create exigem dois Studios reais — mas desde 2026-07-07 boa parte do CICLO (build/deploy do plugin, disparar edições, ler o log do Studio) é automatizável sem o usuário via [Tools/README.md](Tools/README.md); só ações físicas dentro do Studio (fechar janela para failover, primeiro setup de porta) ainda exigem o usuário. Continue registrando resultado em docs/DECISIONS.md/PROJECT_STATUS.md como sempre.
- APIs do Studio mudam: confirme disponibilidade de APIs (ex.: `WebStreamClient`, `ScriptEditorService`, `DraftsService`) contra a documentação oficial antes de depender delas.
