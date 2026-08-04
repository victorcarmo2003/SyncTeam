# syncteam-cli

CLI standalone do SyncTeam, distribuído via [Rokit](https://github.com/rojo-rbx/rokit)
(mesmo mecanismo que já instala `rojo`/`selene`/`stylua`/`lune` neste
projeto — ver `rokit.toml` na raiz). Binário final chamado `syncteam`.
Projeto TypeScript independente, **não** depende de `vscode-extension/` —
roda em [Bun](https://bun.sh) (runtime + bundler + compilador para
executável nativo via `bun build --compile`), não Node puro.

## Comandos

- `syncteam plugin install` — localiza a pasta de Plugins do Roblox Studio
  local (Windows e macOS; sem suporte Linux, o Studio não roda lá) e escreve
  o `.rbxm` do plugin SyncTeam embutido no próprio binário (`SyncTeam.rbxm`,
  mesmo nome de arquivo usado por `Tools/build-and-deploy-plugin.sh`).
  Delete+copy quando já existe uma instalação anterior (força o
  auto-refresh do Studio, mesmo padrão do script de deploy manual).
- `syncteam extension install` — instala a extensão SyncTeam no VS Code
  local. O `.vsix` (`syncteam.vsix`) é embutido no binário do mesmo jeito que
  o `.rbxm` (`with { type: "file" }`); em runtime é escrito num arquivo
  temporário e instalado via `code --install-extension <caminho> --force`
  (subprocess) — o mesmo comando que um usuário rodaria manualmente. Exige
  `code` no PATH (VS Code: Command Palette → "Shell Command: Install 'code'
  command in PATH"); erro claro se `code` não for encontrado (ENOENT).
- `syncteam port <PORTA>` — persiste a porta usada por `start`/`stop` em
  `~/.syncteam/config.json` (ver "Config/estado do CLI" abaixo). Valida
  inteiro entre 1 e 65535 (reusa `parsePortInput`/`MIN_PORT`/`MAX_PORT` de
  `vscode-extension/src/util/port.ts`, cross-pacote — ver seção de reuso
  abaixo); erro claro se inválido, nada é escrito.
- `syncteam start [--dir <pasta>]` — sobe o MESMO motor de sincronização de
  produção (`SyncServer` + `SyncTeamService` + `SyncBridge` + `NodeDiskIO`,
  todos importados diretamente de `vscode-extension/src/`) em segundo plano,
  como processo destacado (daemon). Default: diretório atual (precisa ter
  `default.project.json`). Ver "`start`/`stop`: como o daemon funciona"
  abaixo para o design completo (2 processos, resolução de porta
  interativa, self-invocation).
  **Achado real (2026-08-03, ver DECISIONS.md "16ª rodada"): não rode isto
  ao mesmo tempo que a extensão VS Code está sincronizando a MESMA pasta
  aberta num editor.** `NodeDiskIO` escreve via `node:fs` puro, sem passar
  por `vscode.workspace.fs` (o que `VscodeDiskIO`, usado pela extensão,
  faz) — o VS Code não fica sabendo que o arquivo mudou em disco, e o
  próximo save falha com "The content of the file is newer". Use `start`
  só quando NÃO tiver essa pasta aberta simultaneamente num editor VS
  Code que já está sincronizando ela (CI, outro editor, automação sem
  VS Code).
- `syncteam stop` — encerra o daemon subido por `start` (lê
  `~/.syncteam/syncteam.pid`, `SIGTERM` gracioso escalando para `SIGKILL`
  após 5s se necessário).

## Por que Bun, não Node+pkg/nexe

Ver `.claude/research/2026-08-02-rokit-artifact-format-rojo-plugin-distribution.md`
(Rokit exige executável nativo PE/ELF/Mach-O real) e
`docs/DECISIONS.md` "9ª rodada" (spike que confirmou `bun build --compile`
gerando um binário aceito pelo Rokit de ponta a ponta, contra um repo de
teste real). Trade-off aceito: o binário final tem o runtime Bun inteiro
embutido, ~110-120MB por plataforma (bem mais que os binários Rust do
ecossistema, que ficam na casa de poucos MB) — ver seção "Tamanho" abaixo.

## Como o `.rbxm` é embutido

Via import attribute nativo do Bun `with { type: "file" }`
(`src/index.ts`), confirmado em
`.claude/research/2026-08-03-bun-compile-embed-binary-file-rbxm.md`: o
import devolve uma string de path (real em dev, virtual `/$bunfs/...`
dentro do binário compilado) e `Bun.file(path).bytes()` lê os bytes de
volta — mesma API dentro e fora do executável.

**O `.rbxm` NÃO é commitado** (`*.rbxm` está no `.gitignore` da raiz) — é
gerado como parte do processo de BUILD do CLI, nunca pedido ao usuário final
ter `rojo`/`wally` instalados. Isso significa que `src/index.ts` só
funciona (`bun run`, type-check à parte — ver nota abaixo) depois de rodar:

```sh
bun run build:plugin-asset
```

Esse script (`scripts/build-plugin-asset.ts`) roda `wally install` +
`rojo build` contra `../plugin/` (mesmo entry point e mesma dependência
prévia que `Tools/build-and-deploy-plugin.sh` já usa para o deploy manual em
Studio real) e escreve o resultado em `src/assets/SyncTeam.rbxm`, validando
a assinatura binária (`<roblox!`) antes de terminar. Localiza `rojo`/`wally`
primeiro em `~/.rokit/tool-storage/` (qualquer autor, pega a versão mais
alta — `scripts/lib/rokitTools.ts`), com fallback para o PATH do sistema.

O mesmo padrão vale para `src/assets/syncteam.vsix` (a extensão VS Code,
usada por `syncteam extension install`): `scripts/build-extension-asset.ts`
roda `npm run build` (esbuild) + `npx --yes @vscode/vsce package
--no-dependencies` dentro de `../vscode-extension/`, depois copia o `.vsix`
gerado (nome `<name>-<version>.vsix`, convenção do vsce) para o nome FIXO
`syncteam.vsix` (independente da versão da extensão, para o import não
precisar mudar a cada bump). `src/types/vsix.d.ts` é o mesmo tipo de
declaração ambiente que `rbxm.d.ts` já usa.

```sh
bun run build:plugin-asset      # só o .rbxm
bun run build:extension-asset   # só o .vsix
bun run build:assets            # os dois (é o que compile:*/package:* já chamam)
```

**Nota sobre type-check sem o `.rbxm` gerado**: `tsc --noEmit` (`bun run
lint`) funciona mesmo em um clone limpo, mesmo sem `.rbxm` no disco —
`src/types/rbxm.d.ts` declara `declare module "*.rbxm"` como um módulo
ambiente (`export default: string`), que o TypeScript resolve por padrão de
nome, não por arquivo físico. Só `bun run`/`bun build --compile` de verdade
exigem o arquivo físico (é ele quem embute os bytes).

## Config/estado do CLI (`~/.syncteam/`)

`syncteam` roda sem VS Code aberto — não pode reusar `.vscode/settings.json`
nem `ExtensionContext.globalStorageUri` (esse é o mecanismo que a extensão
usa para o próprio lockfile de posse de porta). Local escolhido (decisão
desta tarefa, cross-platform, sem dependência nova tipo `env-paths`):
`~/.syncteam/` via `os.homedir()` (`src/config/paths.ts`), mesmo padrão de
"pasta pontuada na home" de dezenas de outras CLIs (`.aws`, `.docker`,
`.rokit` — este último já usado por `scripts/lib/rokitTools.ts`):

| Arquivo/pasta | Conteúdo | Escrito por |
|---|---|---|
| `~/.syncteam/config.json` | `{ "port": N }` | `syncteam port` |
| `~/.syncteam/syncteam.pid` | `{ "pid", "port", "projectDir" }` do daemon vivo | `syncteam start` / removido por `syncteam stop` |
| `~/.syncteam/daemon.log` | stdout/stderr do daemon (redirecionado no spawn) | `syncteam start` |
| `~/.syncteam/port-locks/port-<N>.json` | mesmo lockfile de posse de porta da extensão (`PortOwnership.ts::PortLockInfo`), reusado sem alteração | `SyncServer` (via `portLockDir`), tanto o probe temporário quanto o daemon |

## `start`/`stop`: como o daemon funciona

`syncteam start` sobe a composição real de produção
(`SyncServer`+`SyncTeamService`+`SyncBridge`+`NodeDiskIO`, os mesmos
arquivos-fonte de `vscode-extension/src/sync/`, importados por caminho
relativo cross-pacote — **porte, não reinvenção**, mesmo espírito de
`vscode-extension/tools/run-node-harness.ts`, que foi o modelo direto para
`src/daemon/engine.ts`) em segundo plano, sem travar o terminal. Isso exige
2 processos porque a resolução de porta ocupada é INTERATIVA (diálogo Y/N,
pedido explícito da tarefa), e um processo destacado não tem terminal:

1. **Processo em foreground** (`src/commands/start.ts`): resolve qualquer
   conflito de porta de forma interativa usando um `SyncServer` TEMPORÁRIO
   com o MESMO mecanismo de "posse de porta" da extensão
   (`vscode-extension/src/sync/PortOwnership.ts::attemptPortReclaim`,
   reusado sem alteração — só a UI de confirmação muda,
   `src/prompt/confirmPrompt.ts` faz um prompt real `[s/N]` via
   `readline/promises` em vez do modal do VS Code). Assim que confirma que
   dá para abrir a porta (a configurada, ou uma alternativa de fallback
   automático se o usuário recusar matar o processo ocupante), o servidor
   temporário é parado (`server.stop()`), liberando a porta de novo.
2. **Processo destacado** (`detached: true`, stdio redirecionado para
   `~/.syncteam/daemon.log`): o PRÓPRIO binário do CLI reinvocado com a
   flag interna `start --daemon-child` (nunca chamada por um humano
   diretamente) — dispara `src/daemon/engine.ts::runDaemonChild`, que liga
   o motor real na porta já resolvida, **sem** hook interativo
   (`portFallbackAttempts: 0` — se a porta já resolvida no passo 1 não
   estiver mais livre por alguma corrida rara, falha rápido e claro em vez
   de escolher silenciosamente outra porta que o processo pai não saberia
   reportar).
3. O processo em foreground espera a confirmação de que o daemon abriu a
   porta de fato — lê o MESMO lockfile de posse de porta (`readPortLock`),
   conferindo que o PID registrado é o do processo que ele acabou de
   spawnar — antes de escrever `~/.syncteam/syncteam.pid` e retornar
   sucesso.

`syncteam stop` lê o PID file, manda `SIGTERM` (o daemon trata graciosamente
via `service.stop()`, mesmo padrão de `run-node-harness.ts`), espera até 5s
escalando para `SIGKILL` se necessário, remove o PID file. PID file
apontando para um processo já morto (crash, kill externo) é tratado como
obstáculo recuperável (`.claude/rules/authority.md`): loga a decisão e
limpa, sem travar `start`/`stop` seguinte.

### Achado real: como reinvocar o próprio binário (self-invocation)

`src/daemon/selfInvocation.ts` decide o comando exato para spawnar o passo
2 acima. Isso NÃO foi trivial — duas tentativas anteriores nesta mesma
tarefa falharam na prática (testado ao vivo com um probe dedicado,
`scripts/debug-argv-probe.ts`, já removido — não documentado em
`.claude/research/` antes, achado de runtime confirmado diretamente):

| Campo | `bun run src/index.ts` (interpretado) | binário compilado (`bun build --compile`) |
|---|---|---|
| `process.execPath` | caminho REAL do `bun.exe` | caminho REAL do próprio executável compilado |
| `process.argv[0]` | **igual a `execPath`** | **literal `"bun"`** (placeholder, não é um path) |
| `process.argv[1]` | caminho REAL do script (`src/index.ts`) | caminho VIRTUAL dentro do bunfs (`B:/~BUN/root/<nome>.exe`) |

Comparar `argv[1]` contra `import.meta.url`/`fileURLToPath` (1ª tentativa) ou
adicionar um `existsSync` sobre esse caminho (2ª tentativa) **não
funcionam** — os dois campos batem em AMBOS os modos (o caminho virtual do
binário compilado é auto-referencial por construção) e `existsSync` também
retorna `true` para ele (o `fs` do Bun reconhece/virtualiza esses
caminhos). Confirmado ao vivo: com essas heurísticas, `syncteam.exe start`
compilado tentava reinvocar a si mesmo passando o caminho virtual como
ARGUMENTO REAL (`syncteam.exe "B:/~BUN/root/syncteam.exe" start
--daemon-child`), que o dispatcher não reconhecia — o daemon morria com
"comando desconhecido" e `start` reportava falha.

**Sinal que realmente funciona**: comparar `process.execPath` contra
`process.argv[0]` — só batem em modo interpretado. Quando batem, `argv[1]`
é o script real e precisa ser repassado ao processo filho; quando não
batem (binário compilado), nenhum argumento de caminho é repassado, só os
extras (`"start"`, `"--daemon-child"`) — e `execPath` (não `argv[0]`, que é
só o placeholder `"bun"`) é o comando de verdade a spawnar.

`[Verificado no Windows]` (Bun 1.3.13, `bun run test`/binário compilado
real, ver seção de verificação abaixo) — `[Hipótese razoável, não testada]`
em macOS/Linux (mecanismo de compilação do Bun é o mesmo cross-platform,
mas não exercitado fora desta máquina).

## Módulos reusados de `vscode-extension/src/` (cross-pacote, não reinventados)

`cli/` não depende de `vscode-extension/` como pacote instalado
(npm/bun) — mas os dois vivem no mesmo repositório, e vários módulos de
`vscode-extension/src/` são **zero-dependência de `vscode`** por design
(regra já registrada no próprio projeto: só `extension.ts`, `ui/*.ts`,
`VscodeDiskIO.ts`, `vscodeLogger.ts` importam `vscode`). `cli/` importa
esses diretamente por caminho relativo (`../../vscode-extension/src/...`),
sem duplicar lógica:

- `sync/SyncServer.ts`, `sync/SyncTeamService.ts`, `sync/NodeDiskIO.ts`,
  `mapping/projectMapping.ts`, `util/logger.ts` (via `daemon/engine.ts`) —
  o motor de sincronização inteiro.
- `sync/PortOwnership.ts` (`attemptPortReclaim`/`readPortLock`/
  `isProcessAlive`) — via `commands/start.ts`/`commands/stop.ts`.
- `util/port.ts` (`parsePortInput`/`MIN_PORT`/`MAX_PORT`) — via
  `config/cliConfig.ts`/`commands/port.ts`.

**Atrito real encontrado**: `cli/tsconfig.json` tinha `noUncheckedIndexedAccess:
true` (mais estrito que `vscode-extension/tsconfig.json`, que NÃO usa essa
flag) — como `tsc --noEmit` do CLI type-checa esses arquivos importados sob
as PRÓPRIAS opções do compilador do CLI (não as de `vscode-extension`), isso
gerava ~8 erros de "possibly undefined" em código já validado/testado do
outro pacote. Removida do `tsconfig.json` do CLI para alinhar com a
baseline de estrito já usada por `vscode-extension` (que também roda sob
`"strict": true`, só sem essa flag extra) — decisão registrada aqui em vez
de silenciosa.

## Build cross-platform

```sh
bun run compile:win-x64       # bun-windows-x64      -> dist/staging/windows-x86_64/syncteam.exe
bun run compile:macos-x64     # bun-darwin-x64        -> dist/staging/macos-x86_64/syncteam
bun run compile:macos-arm64   # bun-darwin-arm64      -> dist/staging/macos-aarch64/syncteam

bun run package:win-x64       # compila + zip -> dist/syncteam-windows-x86_64.zip
bun run package:macos-x64     # compila + zip -> dist/syncteam-macos-x86_64.zip
bun run package:macos-arm64   # compila + zip -> dist/syncteam-macos-aarch64.zip
bun run package:all           # os 3 de uma vez
```

Cada `compile:*`/`package:*` já roda `build:assets` antes (o `.rbxm` E o
`.vsix` embutidos precisam estar frescos a cada build). Targets confirmados via `bun
build --compile --target=<val> --help` local (Bun 1.3.13) — não documentados
explicitamente na saída de `--help`, confirmados por tentativa real:
`bun-windows-x64`, `bun-windows-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`,
`bun-linux-x64`, `bun-linux-arm64` (e variantes `-baseline`). Só os 3
primeiros (Windows x64, macOS x64, macOS arm64) importam aqui — sem suporte
Linux (Studio não roda lá).

Nomes de asset seguem a convenção que o Rokit reconhece por substring de
SO/arch (`.claude/research/2026-08-02-rokit-artifact-format-rojo-plugin-distribution.md`,
exemplos reais do ecossistema: `stylua-linux-x86_64-musl`,
`rojo-...-win64`): `syncteam-windows-x86_64.zip`,
`syncteam-macos-x86_64.zip`, `syncteam-macos-aarch64.zip`. Zip via `adm-zip`
(devDependency só do script de build — não é código enviado no binário
final) em vez de `zip`/`tar`/`Compress-Archive` nativos do SO, porque
nenhuma ferramenta de zip real está disponível de forma uniforme nas três
plataformas neste ambiente (GNU `tar -a` no Windows/git-bash, por exemplo,
**não** gera um `.zip` de verdade apesar da extensão — só renomeia um `.tar`,
achado durante esta tarefa).

## O que foi testado de verdade nesta máquina (Windows) vs. só assumido

- **`bun run build:plugin-asset`**: `[Verificado]` — rodado de verdade,
  gerou `SyncTeam.rbxm` (194540 bytes) via `rojo build` 7.7.0 real.
- **`bun run compile:win-x64`**: `[Verificado]` — binário `.exe` compilado
  (~117MB), confirmado `PE32+ executable ... x86-64` via `file`.
- **`syncteam.exe plugin install` executado de verdade** (com `LOCALAPPDATA`
  redirecionado para um diretório temporário, para não tocar a instalação
  real do usuário durante a verificação — ver `scripts/verify-embed-hash.ts`):
  `[Verificado]` — instalou o arquivo, e o **hash SHA-256 do `.rbxm` escrito
  bateu byte-a-byte com o `.rbxm` gerado direto por `rojo build`**
  (`3a7daad...f2fb104` nos dois lados). Essa era a ressalva que a pesquisa do
  Bun deixou em aberto ("vale validar com um teste real") — agora
  `[Verificado]`.
- **`bun run compile:macos-x64` / `compile:macos-arm64`**: `[Verificado]`
  SÓ até "compila e gera um Mach-O válido" — confirmado via `file`:
  `Mach-O 64-bit x86_64 executable` e `Mach-O 64-bit arm64 executable`
  respectivamente. **NÃO executados** — esta máquina é Windows, não dá para
  rodar um binário Mach-O aqui. `syncteam plugin install` nunca foi
  exercitado de fato num macOS real (nem o caminho `~/Documents/Roblox/Plugins`
  — ver confirmação por fonte de terceiros abaixo —, nem o embed do `.rbxm`
  dentro do Mach-O). Fica `[Hipótese confirmada por fonte de terceiros, sem
  execução real]` até alguém rodar numa máquina macOS real.
- **Zip dos 3 targets** (`bun run scripts/zip-release.ts <target>`):
  `[Verificado]` — os 3 `.zip` foram gerados localmente em `dist/`
  (`syncteam-windows-x86_64.zip` 43.8MB, `syncteam-macos-x86_64.zip` 26.2MB,
  `syncteam-macos-aarch64.zip` 24.0MB). **Nada foi publicado** — sem `gh
  release create`, sem push. Ficam só como artefato local até decisão
  explícita do usuário de publicar.
- **`bun run build:extension-asset`**: `[Verificado]` — rodado de verdade,
  gerou `syncteam.vsix` via `npm run build` + `vsce package` reais.
- **`syncteam port <N>`**: `[Verificado]` — persiste em
  `~/.syncteam/config.json` de verdade, lido de volta corretamente; porta
  inválida (não numérica, fora de 1-65535) rejeitada com mensagem clara,
  nada escrito.
- **`syncteam start`/`syncteam stop`, incluindo o binário COMPILADO
  (`.exe`) de verdade**: `[Verificado]` — ciclo completo executado ao vivo
  nesta máquina: `start` sobe um daemon real (processo destacado
  sobrevivendo ao processo pai), `netstat`/`Get-Process` confirmam o PID e a
  porta realmente ouvindo, `~/.syncteam/syncteam.pid` e
  `~/.syncteam/port-locks/port-<N>.json` escritos com o PID correto,
  `daemon.log` recebe as linhas do motor real; `stop` encerra o processo de
  verdade (`Get-Process` confirma que sumiu) e remove o PID file. PID file
  órfão (processo morto) tratado corretamente (log + limpeza + segue com um
  novo `start`); segundo `start` com daemon já vivo é recusado.
  **Nota Windows**: `SIGTERM` externo força término imediato (mesmo
  comportamento já documentado em `PortOwnership.ts`) — o handler gracioso
  do daemon não chega a rodar, então o lockfile de posse de porta fica
  órfão até o PRÓXIMO bind bem-sucedido nessa porta sobrescrevê-lo
  (confirmado ao vivo: um `start` seguinte na MESMA porta funciona
  normalmente apesar do lockfile órfão). Em POSIX (não testado nesta
  máquina), o `SIGTERM` deveria disparar o handler gracioso de verdade.
- **`syncteam start` com a porta configurada OCUPADA (diálogo Y/N)**:
  `[Verificado]` — testado com um processo Node SEPARADO ocupando a porta
  (nunca o próprio processo de teste, para não arriscar suicídio do runner):
  confirmar (`s`) encerra o processo ocupante e reaproveita a MESMA porta
  configurada; recusar (`N`) preserva o processo ocupante e cai no fallback
  automático (porta alternativa) — em ambos os casos `confirmKill` foi
  chamado de fato (prova de que o diálogo realmente aparece antes de
  qualquer decisão).
- **`syncteam extension install`**: `[Verificado]` — `code
  --install-extension` real, confirmado via `code --list-extensions
  --show-versions` mostrando `dev-hakor.syncteam@0.1.0` instalado.

## Pasta de Plugins do Studio por SO (`src/plugin/studioPluginsDir.ts`)

- **Windows**: `%LOCALAPPDATA%\Roblox\Plugins` — `[Verificado]`, mesma pasta
  usada por `Tools/build-and-deploy-plugin.sh`.
- **macOS**: `~/Documents/Roblox/Plugins` — **`[Hipótese confirmada por
  fonte de terceiros confiável, sem doc oficial]`**. Sem confirmação em doc
  oficial da Roblox nem post de staff no DevForum, mas bate com o
  código-fonte real de `Kampfkarren/roblox-install` (mesmo mecanismo que o
  próprio Rojo usa para localizar/instalar seu plugin,
  `RobloxStudio::locate()` → `dirs::document_dir().join("Roblox").join("Plugins")`)
  — ver `.claude/research/2026-08-03-macos-studio-plugins-folder-path.md`.
  Só falta execução real numa máquina macOS pra promover a `[Verificado]`
  puro.
- **Linux**: lança `UnsupportedPlatformError` explicitamente (mensagem clara,
  não um erro genérico) — Roblox Studio não roda lá.

## Tamanho do binário

~110-120MB por plataforma (runtime Bun completo embutido — mesmo trade-off
já documentado no spike de `docs/DECISIONS.md` "9ª rodada", ~112MB lá
também). Aceito pelo usuário como trade-off consciente de usar TypeScript em
vez de Rust (ninguém no time mantém Rust hoje).

## Testes e lint

```sh
bun install
bun run lint    # tsc --noEmit
bun run test    # vitest run
```

52 testes. A maioria é lógica pura com IO fake (`test/studioPluginsDir.test.ts`,
`test/pluginInstall.test.ts`, `test/extensionInstall.test.ts`,
`test/rokitTools.test.ts`, `test/paths.test.ts`, `test/cliConfig.test.ts`,
`test/port.test.ts`, `test/pidFile.test.ts`, `test/selfInvocation.test.ts`)
— nenhum teste toca `Bun.file`/binário compilado de verdade (isso é o papel
de `scripts/verify-embed-hash.ts`, rodado manualmente após um build real,
não como parte da suíte automática).

`test/startStop.test.ts` (4) e `test/startPortConflict.test.ts` (2) são
diferentes — **testes de ponta a ponta REAIS**, mesma filosofia de nunca
mockar fs/child_process/net/ws já usada em `vscode-extension/`: sobem um
daemon de verdade (processo `bun` real, via `daemon/selfInvocation.ts`),
confirmam PID/porta/lockfile reais, e o encerram de verdade — incluindo o
fluxo interativo de posse de porta (`confirmKill` chamado de fato, com um
processo Node SEPARADO ocupando a porta para poder testar o caminho de
"matar o processo" com segurança, sem arriscar o processo do próprio
teste). Achado real que motivou um ajuste de teste: `bun run test` executa
`vitest`, mas o WORKER que roda cada arquivo é um processo NODE (`process.execPath`
dentro de um teste aponta para `node.exe`, não `bun.exe`, mesmo a suíte
lançada via `bun run test`) — os testes resolvem o `bun.exe` real
explicitamente (`~/.bun/bin/bun.exe`) em vez de reusar `process.execPath`,
para exercitar a MESMA auto-reinvocação que a produção usa.

## Não incluído nesta versão

- Publicação de uma versão NOVA do release/CLI com os comandos
  `port`/`start`/`stop`/`extension install` (o v0.1.0 já publicado, ver
  `docs/DECISIONS.md` "11ª rodada", só tinha `plugin install`) — decisão
  explícita do usuário, fica para depois. `rokit.toml` da raiz não foi
  tocado nesta tarefa.
- Assinatura de código (Windows SmartScreen/macOS Gatekeeper vão reclamar de
  um binário não assinado — fora de escopo desta tarefa).
- `syncteam start`/`stop` em macOS/Linux: mecanismo (SIGTERM
  gracioso/lockfile/self-invocation) deveria funcionar igual por construção
  (mesma composição de módulos, mesmo Bun), mas **só foi exercitado de
  verdade no Windows** nesta tarefa — fica `[Hipótese razoável, não
  testada]` para os outros SOs até alguém rodar lá.
- `syncteam start` sem argumento algum de "porta candidata alternativa
  manual" (ex.: `--port`) — usa sempre o que está em
  `~/.syncteam/config.json` (default 1400), configurável só via `syncteam
  port`.
