# SyncTeam

Colaboração de código em tempo real para times Roblox: vários desenvolvedores usando **VS Code ao mesmo tempo**, com o **Roblox Studio (Team Create) como autoridade** — sem servidor externo, sem fork do Rojo.

## O problema

O Rojo sincroniza numa direção só (arquivos → Studio). Com dois ou mais devs, cada `rojo serve` local sobrescreve o que o outro dev fez. O SyncTeam resolve isso usando o próprio Team Create como transporte bidirecional.

## Como funciona

- Um **plugin do Studio** e uma **extensão do VS Code** por desenvolvedor.
- A extensão hospeda um WebSocket em `localhost`; o plugin conecta nele.
- O **Team Create replica** código (`Source`) e metadados de colaboração (sessões, presença, cursores, leases) entre os Studios do time.
- Fluxo **bidirecional em tempo real**: o que qualquer pessoa edita (VS Code ou Studio) aparece pra todos.
- **Lease por arquivo**: quem está editando um script é dono temporário dele; os outros veem somente-leitura com aviso e cursor de quem edita.
- **Formato 100% compatível com Rojo** (`default.project.json`, `src/server|client|shared`, `*.server.luau`, `init.*`): dá pra migrar um projeto Rojo pro SyncTeam — e voltar — a qualquer momento.

## Instalação

**1. Extensão do VS Code** — abra o projeto no VS Code e instale o `.vsix`:

```sh
code --install-extension syncteam.vsix --force
```

Sem `.vsix` em mãos? Builda a partir do código:

```sh
cd vscode-extension
npm install
npm run build
npx vsce package --no-dependencies -o syncteam.vsix
code --install-extension syncteam.vsix --force
```

**2. Plugin do Roblox Studio** — pegue `dist-plugin/SyncTeam.rbxmx` e arraste pra pasta de Plugins do Studio (`%LOCALAPPDATA%\Roblox\Plugins` no Windows). Ou builde na hora:

```sh
bash Tools/build-and-deploy-plugin.sh   # ou .ps1 no PowerShell
```

**3. Conectar** — abra o Studio no mesmo `place` do time (Team Create) e clique no botão **SyncTeam** na toolbar do plugin, depois em **CONNECT** no painel (autostart vem desligado por padrão — conexão é sempre manual). A extensão sobe o servidor sozinha ao abrir o workspace, na porta configurada em `syncteam.port` (default `1400`).

## Estado atual

M0–M3 (replicação de `Source`, sincronização estrutural, leases/eleição de líder) **verificados com Studios reais**. M4/M4.5 (presença, painel do plugin, UX de lease) implementados. Ver [docs/MILESTONES.md](docs/MILESTONES.md) e [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) para detalhe e o que ainda é `[Hipótese]`.
