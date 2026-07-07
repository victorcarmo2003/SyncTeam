# Arquitetura do SyncTeam

Este documento descreve a arquitetura-alvo. Afirmações são marcadas como
`[Verificado]`, `[Hipótese]` ou `[Decisão pendente]`. Só promova a
`[Verificado]` após teste real.

## Topologia

```
Dev A                                              Dev B
VS Code + extensão SyncTeam                        VS Code + extensão SyncTeam
(servidor WebSocket em localhost)                  (idem)
        ▲                                                ▲
        ▼ WebStreamClient (cliente)                      ▼
Studio A + plugin SyncTeam ◄──── Team Create ────► Studio B + plugin SyncTeam
                            replicação nativa Roblox:
                            • Source dos scripts  [Hipótese — spike M0]
                            • TestService.SyncTeam (metadados)  [Verificado no RojoCoop]
```

Cada desenvolvedor roda o par completo (Studio + VS Code) na própria máquina.
Não existe servidor central: o Team Create é o único canal entre máquinas.

## Componentes

### 1. Extensão VS Code (TypeScript)

- Hospeda o servidor WebSocket local (porta configurável, descoberta automática).
- Dona do disco: lê/escreve arquivos seguindo as convenções do Rojo, guiada pelo
  `default.project.json` do projeto.
- Observa edições do usuário (documento + save) e envia patches de Source ao plugin.
- Aplica patches vindos do plugin (edições de outros devs ou feitas no Studio)
  nos arquivos locais, inclusive create/rename/move/delete.
- UI de colaboração: cursores/seleções coloridos com nome, badge ● no explorer,
  tree view de colaboradores, status bar, arquivo somente-leitura quando o lease
  é de outra pessoa.
- Base a portar: `RojoCoop/vscode-extension/src/` (presence, lease, ui, mapping).

### 2. Plugin Studio (Luau)

- Cliente WebSocket do endpoint local (`HttpService:CreateWebStreamClient`).
  `[Verificado no RojoCoop]` round-trip real; limite de 6 clientes por Studio.
- Escreve Source no DataModel (`ScriptEditorService:UpdateSourceAsync`,
  fallback `.Source`) e observa mudanças de Source — tanto locais quanto
  replicadas pelo Team Create.
- Mantém o plano de controle em `TestService.SyncTeam` (ver §Esquema).
- Participa da eleição de líder; o líder processa intents e concede leases.
- Mapeia Instance ↔ caminho de arquivo usando o mesmo modelo do project.json.

### 3. Plano de controle: `TestService.SyncTeam`

Adaptação direta do esquema v2 do ModuxSync (`[Verificado]` em 2 Studios):

```
TestService.SyncTeam/
├── SchemaVersion: IntValue
├── LeaderClientId: StringValue
├── LeaderTerm: IntValue
├── NextJoinSequence: IntValue
├── NextLeaseRequestSequence: IntValue
├── Sessions/<clientId>/
│   ├── ClientId, UserId, Username, JoinSequence, Pulse, ObservedRole
│   ├── Presence/ (arquivo ativo, cursor, seleção)   ← novo no SyncTeam
│   └── LeaseIntents/<intentId>/ (IntentId, Pulse, Active, WriteGeneration,
│       RequestSequence, ScriptKey, ScriptRef: ObjectValue)
├── Scripts/<scriptKey UUID>/ (CanonicalPath, CreatedTerm,
│   InstanceRef: ObjectValue → Instance do script)
└── Leases/<scriptKey>/ (OwnerClientId, LeaseId, LeaderTerm,
    RequestSequence, ScriptRef)
```

Constantes de tempo validadas: pulso 2s, sessão obsoleta após 8s, limpeza de
órfãos após 20s, promoção de líder exige duas observações consecutivas.

Diferenças em relação ao ModuxSync:
- Leases são **autoritativas** desde o início (lá eram "shadow", só observação).
- Presença (cursor/arquivo ativo) trafega pelos metadados do Team Create, não
  por WebSocket de servidor — `[Hipótese]` latência aceitável; medir no M0/M3.

## Fluxos

### Edição no VS Code (dono do lease)

1. Extensão detecta mudança no buffer (debounce curto).
2. Envia `{scriptKey, novaSource, generation}` ao plugin via WS local.
3. Plugin confirma lease local e escreve a Source no DataModel.
4. Team Create replica aos demais Studios.
5. Plugins remotos detectam a mudança (`GetPropertyChangedSignal("Source")`
   `[Hipótese — spike M0]`) e enviam a nova Source às suas extensões.
6. Extensões remotas gravam o arquivo no disco; VS Code recarrega o buffer.

### Edição direta no Studio

Mesmo fluxo a partir do passo 3 — o plugin local trata edição no editor do
Studio como qualquer outra escrita, exigindo lease do usuário local.

### Conexão inicial (Studio autoritário)

1. Plugin enumera os scripts sob os pontos de montagem do project.json.
2. Extensão serializa para o disco no formato Rojo (regras de nomenclatura
   `init.*`, `*.server.luau`, `*.client.luau`; lógica validada no RojoCoop,
   a reescrever em TypeScript).
3. Diferenças disco→Studio existentes são mostradas antes de sobrescrever
   (UX "Connect/Override" herdada da decisão do RojoCoop).

### Lease por arquivo

- Editar um arquivo cria/renova um *intent*; o líder concede o lease se o
  script não tem dono (sem preempção; desempate por RequestSequence →
  JoinSequence → clientId — algoritmo `[Verificado]` no RojoCoop).
- Sem dono ≠ bloqueado: arquivo sem lease é editável por qualquer um; o
  primeiro write pede o lease.
- Lease expira após inatividade (intent some 8s após o último write) ou
  desconexão do dono.
- No VS Code, arquivo com lease alheio fica somente-leitura com aviso de quem
  edita; no Studio, o plugin recusa o write e notifica.

## Riscos abertos

- `[Hipótese central — M0]` Source escrito por plugin replica via Team Create
  em tempo útil e dispara sinal observável no Studio remoto. O modo
  Drafts/Collaborative Editing pode reter edições por usuário — testar com
  drafts ligado e desligado. Plano B se falhar: trafegar conteúdo em
  `StringValue` nos metadados (atenção a limites de tamanho).
- `[Hipótese]` Escrita de Source por plugin coexiste com o editor de script
  aberto no Studio remoto sem corromper/perder edição.
- `[Hipótese]` Latência e rate limits do Team Create suportam digitação
  contínua com debounce (~alguns writes/s por script).
- `[Decisão pendente]` Frequência exata do debounce VS Code→Studio.
- `[Decisão pendente]` Como autenticar/associar a extensão VS Code ao usuário
  do Studio local (herdada do RojoCoop; no local-only o risco é baixo).
