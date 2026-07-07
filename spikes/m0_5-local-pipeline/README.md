# Spike M0.5 — Pipeline local com 1 Studio

Valida o pipeline **VS Code A → Studio → VS Code B** numa única máquina: o
harness Node (controlado pelo Claude) simula dois "VS Codes" em duas portas
locais, e o plugin `SyncTeamLab.lua` conecta o Studio às duas.

**O que NÃO valida**: replicação via Team Create entre duas máquinas — isso
continua sendo o spike M0 (`spikes/m0-source-replication/`), a rodar depois
com um colega.

## Papéis

- **Claude** roda o harness (`node server.mjs`) e executa/analisa os cenários.
- **Usuário** instala o plugin e clica um botão. Só isso.

## Passos do usuário

1. Copie `plugin/SyncTeamLab.lua` para `%LOCALAPPDATA%\Roblox\Plugins`
   (ou Studio → aba Plugins → Plugins Folder).
2. Abra qualquer place no Studio (Team Create NÃO é necessário aqui).
3. Confirme com o Claude que o harness está rodando.
4. Clique em **Lab: Conectar** na toolbar "SyncTeam Lab". Aceite o prompt de
   permissão de rede do plugin, se aparecer.
5. Deixe o Studio aberto. Os cenários rodam sozinhos em segundos.

O plugin cria a pasta sandbox `ServerScriptService.SyncTeam_Lab` e só mexe
dentro dela.

## Cenários automáticos (rodam quando A e B conectam)

1. **ping/pong** por canal (RTT do transporte).
2. **A escreve → B observa**: writeSource no canal A cria/edita `FromA`;
   sucesso = canal B recebe `sourceChanged` com conteúdo idêntico (latência
   medida).
3. **B escreve → A observa** (sentido inverso, `FromB`).
4. **Escrita concorrente** no mesmo script (`Contested`) — informativo: mostra
   quem vence sem coordenação (motiva as leases do M3).
5. **listScripts** (inventário do sandbox).

Depois do relatório, o harness fica em **modo observação**: edite qualquer
script dentro de `SyncTeam_Lab` no editor do Studio e o evento
`sourceChanged origin=studio` aparece no log — isso testa a detecção de edição
manual (fluxo Studio → VS Code).

## Injeção manual de comandos (Claude)

Criar um `.json` em `harness/inbox/`:

```json
{ "channel": "A", "message": { "kind": "writeSource", "path": "Foo/Bar", "source": "return 1\n", "className": "ModuleScript" } }
```

Kinds aceitos pelo plugin: `ping`, `writeSource {path, source, className?}`,
`readSource {path}`, `listScripts`. Eventos emitidos pelo plugin: `hello`,
`sourceChanged {path, source, origin}`, `scriptAdded`, `scriptRemoved`,
`writeAck`, `sourceContent`, `scriptList`.

## Critérios de aceite (M0.5)

- Cenários 1–3 PASS com latência local baixa (alvo < 1s por perna).
- Edição manual no Studio gera `sourceChanged origin=studio`.
- Reconexão: derrubar e subir o harness com o Lab ativo reconecta em ~3s.
- Resultado registrado em `docs/PROJECT_STATUS.md`.

## Ponte interativa (bridge-server.mjs)

Enquanto `server.mjs` roda cenários automáticos com dados fake (`FromA`,
`FromB`, `Contested`) para teste automatizado, `bridge-server.mjs` é uma
ponte **viva** para teste manual com dois "devs" de verdade — sem cenários,
sem inbox, só sincronização contínua.

**Como rodar**: na mesma pasta do `server.mjs` (já tem `ws` instalado):

```
node bridge-server.mjs
```

Ele abre os mesmos dois canais WebSocket (34901 = A, 34902 = B) e cria duas
pastas, se não existirem: `spikes/m0_5-local-pipeline/vscode-bridge/workspace-a/`
e `.../vscode-bridge/workspace-b/`.

- **`workspace-a/`** é para o **usuário** abrir no VS Code de verdade e
  editar/salvar arquivos `.lua` manualmente — simula o primeiro dev.
- **`workspace-b/`** é editada pela **IA** (Claude, com as ferramentas normais
  de edição de arquivo) para simular o segundo dev.

Os dois lados devem **convergir** através do plugin já instalado no Studio:
uma edição salva em `workspace-a/Foo.lua` vira `writeSource` no canal A, o
Studio aplica e emite `sourceChanged` (broadcast para os dois canais), e a
ponte grava o novo conteúdo em `workspace-a/Foo.lua` **e** `workspace-b/Foo.lua`
— e vice-versa quando a IA edita em `workspace-b/`. Ao conectar, cada canal
também dispara uma sincronização inicial (`listScripts` + `readSource` por
script) que popula as duas pastas com o estado atual do sandbox.

Não roda cenários, não usa `inbox/`, e não deve substituir `server.mjs` — os
dois arquivos coexistem na mesma pasta `harness/` e não devem rodar ao mesmo
tempo (competiriam pelas mesmas portas 34901/34902).

### Nomenclatura em disco: convenção real do Rojo

A ponte gravava, na primeira versão, sempre `<Nome>.lua` plano com a
`className` adivinhada por regex no nome do arquivo (`inferClassName`) — bom
o bastante para validar o transporte, mas não representa a estrutura real de
um projeto Rojo. Agora `bridge-server.mjs` usa `harness/rojo-path-mapping.mjs`
(módulo puro, testado em `rojo-path-mapping.test.mjs` com `node:test`) para
decidir onde cada script mora: `ModuleScript`/`Script`/`LocalScript` sem
filhos viram arquivo plano (`Nome.luau`, `Nome.server.luau`,
`Nome.client.luau`); com filhos, viram pasta `Nome/` com `Nome/init.luau` (ou
`init.server.luau`/`init.client.luau`) mais os filhos dentro, recursivamente.
A extensão gravada é sempre `.luau`; `.lua` continua sendo aceito na leitura
de um caminho existente.

A ponte mantém `knownClasses` (path → className) a partir do campo `scripts`
de `listScripts` (com fallback para `className="Script"` se esse campo ainda
não existir no plugin) e de todo `scriptAdded`/`sourceChanged` recebido.
Sempre que isso muda de um jeito que pode afetar o layout, o layout inteiro é
recalculado e a diferença é aplicada nas duas pastas — inclusive promovendo
um arquivo plano para pasta+`init.*` (movendo o conteúdo) quando um script
ganha o primeiro filho.
