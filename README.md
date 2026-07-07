# SyncTeam

Colaboração de código em tempo real para times Roblox: vários desenvolvedores usando **VS Code ao mesmo tempo**, com o **Roblox Studio (Team Create) como autoridade** — sem servidor externo, sem fork do Rojo.

## O problema

O Rojo sincroniza numa direção só (arquivos → Studio). Com dois ou mais devs, cada `rojo serve` local sobrescreve o que o outro dev fez, e o time acaba preso a rodízio de quem pode codar ou a merges manuais constantes. Manter um fork do Rojo para resolver isso quebra a cada atualização upstream.

## A solução

- Um **plugin do Studio** e uma **extensão do VS Code** por desenvolvedor.
- A extensão hospeda um WebSocket em localhost; o plugin conecta nele.
- O **Team Create replica** tanto o código (`Source`) quanto os metadados de colaboração (sessões, presença, cursores, leases) entre os Studios do time.
- Fluxo **bidirecional em tempo real**: o que qualquer pessoa edita (no VS Code ou no Studio) aparece para todos, em segundo plano.
- **Lease por arquivo**: quem está editando um script é dono temporário dele; os outros veem o arquivo somente-leitura com o cursor e o nome de quem edita. Nada de sobrescrita acidental.
- **Formato 100% compatível com Rojo** (`default.project.json`, `src/server|client|shared`, `*.server.luau`, `init.*`): dá para migrar um projeto Rojo existente para o SyncTeam — e voltar — a qualquer momento.

## Estado atual

Projeto em fase inicial. O marco atual é o **M0**: validar que `Source` escrito por plugin replica entre dois Studios via Team Create. Ver [docs/MILESTONES.md](docs/MILESTONES.md) e [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md).
