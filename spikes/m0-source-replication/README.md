# Spike M0 — Replicação de Source via Team Create

Valida a hipótese central do SyncTeam antes de construir qualquer produto:
**Source escrito por plugin em um Studio replica para outro Studio via Team
Create, de forma observável e em tempo útil?**

O RojoCoop validou metadados (Values/ObjectValues) via Team Create, mas nunca
conteúdo de script. O risco conhecido é o **Drafts Mode** (Collaborative
Editing) reter edições de script por usuário.

## Instalação (nas duas máquinas)

1. Copie `SyncTeamM0.lua` para a pasta de plugins locais do Studio:
   `%LOCALAPPDATA%\Roblox\Plugins` (ou Studio → aba Plugins → Plugins Folder).
2. Abra um place de teste **com Team Create ativado** nas duas máquinas
   (contas diferentes).
3. A toolbar "SyncTeam M0" aparece com 4 botões: Escritor, Observador,
   WS local, Parar.

## Roteiro — replicação de Source

Papéis: **Studio A = Escritor** (escreve counter na Source a cada 3s),
**Studio B = Observador** (mede a chegada).

Para cada cenário abaixo: A clica `M0: Escritor`, B clica `M0: Observador`,
deixar rodando ~1 minuto observando o Output de B, depois `M0: Parar` nos dois.

| # | Drafts Mode | Alvo no editor de B | Resultado (preencher) |
|---|---|---|---|
| 1 | desligado | fechado | |
| 2 | desligado | **aberto** | |
| 3 | ligado | fechado | |
| 4 | ligado | **aberto** | |

Drafts Mode: Game Settings → Options → Enable Drafts Mode (exige reabrir a
sessão ao mudar).

### Como ler o Output do Observador

- `METADADOS counter=N chegaram` — o IntValue replicou (canal já validado; é a
  referência de tempo).
- `SOURCE counter=N chegou via sinal, X.XXs após os metadados` — **melhor
  caso**: a Source replicou e `GetPropertyChangedSignal("Source")` disparou.
- `SOURCE counter=N chegou via polling ...` — a Source replicou mas o sinal
  **não** disparou → o produto precisará de polling leve.
- Só `METADADOS`, nunca `SOURCE` — a Source **não** replicou (provável drafts)
  → plano B (conteúdo via StringValue) entra em avaliação.
- `atenção: GetEditorSource ainda mostra counter=...` — o editor aberto não
  acompanhou a propriedade; anotar (afeta o cenário "arquivo aberto no Studio
  remoto").

### Critérios go/no-go (M0)

- **Go**: cenário 1 funciona com latência de poucos segundos (sinal ou
  polling), e cenário 2 não corrompe/perde conteúdo.
- **No-go**: Source nunca replica em nenhuma configuração → reavaliar
  arquitetura (conteúdo via metadados) antes do M1.

## Roteiro — transporte WebSocket local (1 máquina)

1. Nesta pasta: `npm install` e `node ws-echo-server.mjs`.
2. No Studio, clique `M0: WS local`. Aceite o prompt de permissão de rede do
   plugin se aparecer.
3. Esperado no Output: `WS probe enviado` seguido de `WS recebeu eco: ...`.
   Se o Send falhar por conexão ainda não aberta, clique de novo.

## Registro de resultados

Cole os logs relevantes do Output e a tabela preenchida em
[docs/PROJECT_STATUS.md](../../docs/PROJECT_STATUS.md) e registre o go/no-go em
[docs/DECISIONS.md](../../docs/DECISIONS.md).
