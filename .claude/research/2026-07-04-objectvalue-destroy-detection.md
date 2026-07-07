# Pesquisa: ObjectValue.Value e detecção de Destroy()

## Pergunta

O plugin SyncTeam detecta "script deletado" checando se `ObjectValue.Value`
(que referencia a Instance do script) virou `nil`. Essa suposição nunca foi
confirmada contra documentação oficial, só contra um mock em teste unitário do
RojoCoop. Perguntas:

1. `ObjectValue.Value` vira `nil` automaticamente e de forma confiável quando
   a Instance referenciada é destruída via `:Destroy()`?
2. Isso muda quando a destruição é replicada via Team Create (remota)?
3. Existe forma mais robusta/documentada de detectar destruição?
4. Pegadinhas conhecidas no DevForum sobre `ObjectValue` + `Destroy()`?

## Resposta objetiva

**Não é confiável — na verdade o comportamento é o oposto do assumido.**
`ObjectValue.Value` **NÃO** vira `nil` automaticamente quando a Instance
referenciada é destruída via `:Destroy()`. Isso é confirmado como
**comportamento intencional** por staff da Roblox em pelo menos dois threads
do DevForum: o `ObjectValue` mantém uma referência "morta" (stale) para a
Instance destruída, e o evento `Changed` **também não dispara** quando o
valor referenciado é destruído. O bug de detecção relatado pelo usuário é
esperado dado esse comportamento documentado pela comunidade/staff — a
implementação atual do plugin (`checkRegistryDrift`/`ScriptRegistry.luau`)
está construída sobre uma premissa falsa e precisa ser corrigida
independente do caso Team Create. Para o caso remoto (pergunta 2), não há
documentação oficial nem relato de DevForum específico sobre replicação via
Team Create de `ObjectValue` apontando para Instance destruída no Studio
remoto — não encontrado, tratar como **hipótese não testada** e validar com
dois Studios reais.

## Detalhes e ressalvas

### 1. `ObjectValue.Value` não zera automaticamente — confirmado como intencional

- Doc oficial de `Instance:Destroy()` (`create.roblox.com/docs/reference/engine/classes/Instance`,
  via mirror `raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/classes/Instance.yaml`):
  Destroy() define `Parent = nil` e **trava** a propriedade `Parent`
  (não pode ser reatribuída). A doc recomenda explicitamente: *"As a best
  practice after calling Destroy() on an object, set any variables
  referencing the object (or its descendants) to nil"* — ou seja, a própria
  Roblox admite que variáveis/referências (incluindo, por extensão,
  `ObjectValue.Value`) **não são limpas automaticamente** pelo engine; é
  responsabilidade do desenvolvedor.
- DevForum, "ObjectValue doesn't automatically clear out non-existent object"
  (`devforum.roblox.com/t/objectvalue-doesnt-automatically-clear-out-non-existent-object/1687465`):
  usuário reporta exatamente esse comportamento (Value mantém referência após
  Destroy). Resposta da comunidade (Forummer) confirma que é **"intended
  behavior"** — ObjectValue mantém referência forte mesmo após destruição; o
  workaround é zerar manualmente o Value quando souber que a Instance foi
  destruída.
- DevForum, "ObjectValue.Changed does not fire when :Destroy() is called on
  the value" (`devforum.roblox.com/t/objectvaluechanged-does-not-fire-when-destroy-is-called-on-the-value/3600077`,
  10/abr/2025): reporta que (a) `Value` continua apontando pro objeto morto e
  (b) `Changed` **não dispara** quando o valor referenciado é destruído
  (só dispara quando o próprio `Value` é reatribuído a outra coisa). Staff
  (WheretIB) respondeu que `Destroy()` não limpa referências de outras
  propriedades por design; a referência fica "morta" mas presente. Sem
  confirmação de bug oficial — staff sugeriu reportar como pedido de melhoria
  de documentação, não como bug de engine.
- DevForum, "Tip: How to tell if ObjectValue.Value has been destroyed/is
  actually nil" (`devforum.roblox.com/t/tip-how-to-tell-if-objectvaluevalue-has-been-destroyedis-actually-nil/1867489`):
  thread inteira parte da premissa (correta, confirmada por vários
  devs) de que instâncias destruídas **não** ficam `nil` automaticamente em
  `ObjectValue.Value`.
- DevForum, "ObjectValue Instance Problems" (`devforum.roblox.com/t/objectvalue-instance-problems-properties-that-hold-an-instance-require-innovation-refpropdescriptor/3084990`,
  resposta staff GroupyClumpy 05/jun/2025): lista limitações adicionais de
  `ObjectValue` (não há como checar se está "vinculado", `Value` pode ficar
  `nil` por atraso de replicação/streaming mesmo com binding válido, cut/paste
  quebra o vínculo) — tudo classificado como "working as intended", não bug.

**Conclusão da pergunta 1**: a suposição do plugin está invertida em relação
ao comportamento real. `ObjectValue.Value` não é um sinal confiável de morte
da Instance — ele continua não-nil (apontando pra uma Instance destruída,
"morta") indefinidamente até alguém zerar manualmente.

### 2. Comportamento sob replicação Team Create (remoto)

Não encontrei documentação oficial nem thread de DevForum tratando
especificamente do cenário "`ObjectValue` sob `TestService`, replicado via
Team Create, apontando para uma Instance destruída no Studio remoto". Os
achados relevantes mas não conclusivos:

- O thread de feedback de documentação "Feedback on ObjectValue"
  (`devforum.roblox.com/t/feedback-on-objectvalue/3979778`, staff
  EndlessSashimi, resolvido 21/out/2025) trata do caso de **StreamingEnabled**
  (não Team Create): confirma que, com streaming, `Value` fica `nil` até a
  Instance referenciada replicar/entrar em stream, e que quando a Instance
  faz stream-out ela é **reparentada para `nil`** (não destruída) — os dois
  comportamentos são de fenômenos de streaming de jogo publicado, não de
  edição colaborativa em Team Create.
  Isso é uma boa evidência que "Instance sai da árvore" pode acontecer sem
  Destroy() de verdade (só stream-out), mas o mecanismo de streaming de jogo
  publicado não corresponde ao ambiente de edição no Studio (Team Create
  edita o DataModel do Studio diretamente, sem streaming client-side).
- Os threads sobre "Destroy() Can Now Replicate to Clients"
  (`devforum.roblox.com/t/destroy-can-now-replicate-to-clients/1694890`) e
  "Instance parameters not guaranteed to be replicated before being
  destroyed" (`devforum.roblox.com/t/instance-parameters-not-guaranteed-to-be-replicated-before-being-destroyed-yet-children-are/2310933`)
  são sobre replicação **servidor → cliente de jogo publicado**
  (`Workspace.ReplicateInstanceDestroySetting`), um sistema diferente do
  Team Create (edição colaborativa entre Studios). Não citam Team Create.

**Conclusão da pergunta 2**: **não encontrado** — trate como lacuna de
documentação. Dado que já é comportamento confirmado que localmente
`ObjectValue.Value` não zera e `Changed` não dispara em Destroy, não há
motivo para esperar que a replicação via Team Create "corrija" isso —
pelo contrário, é razoável hipotetizar que o mesmo problema (ou pior, com
janela de delay de replicação) se repete entre Studios. Isso é
**[Hipótese]**, não **[Verificado]**: precisa de teste real com dois Studios
(destruir a Instance em Studio A, observar `ObjectValue.Value` e `Changed`
sob `TestService.SyncTeam` em Studio B).

### 3. Forma mais robusta de detectar destruição

Nenhum dos quatro candidatos propostos é 100% seguro isoladamente; o padrão
recomendado pela comunidade (thread do item 1, resposta de "Ziffixture",
consistente com o que a doc oficial diz sobre `Destroy()` travar `Parent`)
combina dois:

```lua
local function isDestroyed(instance: Instance): boolean
    if instance.Parent then
        return false
    end
    -- Parent == nil pode significar "destruído" OU "temporariamente
    -- desparentado" (ex.: Instance.new() ainda não parented, ou script
    -- que fez Parent = nil de propósito). O pcall abaixo distingue:
    -- em Instance destruída, Parent fica TRAVADO (doc oficial de Destroy()),
    -- então até reatribuir o MESMO valor lança erro.
    return not pcall(function()
        instance.Parent = instance.Parent
    end)
end
```

- `instance.Parent == nil` sozinho: **necessário, não suficiente** — não
  distingue destruído de "só desparentado".
- `not instance:IsDescendantOf(game)`: mesmo problema — falso positivo para
  Instance válida mas fora da árvore (ex.: guardada numa variável, ainda não
  parented) e falso positivo teórico se o `ObjectValue` de metadados do
  SyncTeam ficar fora de `game` (não é o caso, mas objetos legitimamente
  fora da árvore de jogo dão o mesmo sinal).
- `pcall` tentando reatribuir `Parent`: é o teste mais confiável porque se
  baseia diretamente na garantia documentada oficialmente ("locks the
  Parent property" após Destroy) — erro no pcall = destruída com certeza.
  Sem essa trava, não há erro.
- `Instance.Destroying` (evento oficial, existe e é documentado): **não
  confiável como único caminho**, com múltiplos relatos de DevForum de
  comportamento inconsistente:
  - "Instance.Destroying fires too late" (`devforum.roblox.com/t/instancedestroying-fires-too-late/2842369`)
  - "Instance.Destroying Not Firing When Parent Is Being Destroyed" (`devforum.roblox.com/t/instancedestroying-not-firing-when-parent-is-being-destroyed/3052042`):
    relato de que o evento não dispara em certos cenários de destruição em
    cascata (tool destruído no servidor, script cliente sob a tool não vê o
    evento); sem resposta de staff, sem resolução; thread ainda ativa em
    jun/2026.
  - "Incorrect Behavior of Destroying Event in Example Code" (`devforum.roblox.com/t/incorrect-behavior-of-destroying-event-in-example-code/3219541`):
    reporta que a própria documentação descreve mal o timing do evento
    (Parent já é `nil` no momento do handler mesmo em modo que a doc diz que
    não deveria estar).
  - Além disso, `Workspace.SignalBehavior` (Immediate vs Deferred) muda o
    timing de disparo (ver achado já registrado na memória sobre
    Immediate/Deferred).

**Conclusão da pergunta 3**: combinar **polling periódico** (já é a prática
adotada no projeto para `Source`, ver `.claude/rules/luau.md`) com o teste
`Parent == nil` + `pcall` de reatribuição de `Parent` como confirmação
definitiva. Não depender de `ObjectValue.Value == nil` nem de
`Instance.Destroying`/`Changed` como caminho único — ambos podem não
disparar. `Destroying` pode continuar conectado como fast-path best-effort,
nunca como única fonte de verdade (mesmo padrão já adotado para
`Source.Changed`).

### 4. Pegadinhas conhecidas no DevForum (resumo consolidado)

| Pegadinha | Thread | Staff confirmou? |
|---|---|---|
| `ObjectValue.Value` não zera após Destroy() da Instance referenciada | [1687465](https://devforum.roblox.com/t/objectvalue-doesnt-automatically-clear-out-non-existent-object/1687465) | Sim (Forummer, comunidade) — "intended behavior" |
| `ObjectValue.Changed` não dispara quando o Value referenciado é destruído (só dispara ao reatribuir Value) | [3600077](https://devforum.roblox.com/t/objectvaluechanged-does-not-fire-when-destroy-is-called-on-the-value/3600077) | Sim (WheretIB, staff), sem abertura de bug formal — direcionado a feedback de doc |
| Sem forma nativa de checar se `ObjectValue` está "vinculado"; delay de streaming pode deixar `Value` nil mesmo com binding válido; cut/paste quebra vínculo | [3084990](https://devforum.roblox.com/t/objectvalue-instance-problems-properties-that-hold-an-instance-require-innovation-refpropdescriptor/3084990) | Sim (GroupyClumpy, staff) — "working as intended" |
| `Instance.Destroying` não dispara de forma confiável em certos cenários de destruição em cascata | [3052042](https://devforum.roblox.com/t/instancedestroying-not-firing-when-parent-is-being-destroyed/3052042) | Não — sem resposta de staff, aberto |
| Doc do evento `Destroying` descreve timing incorretamente | [3219541](https://devforum.roblox.com/t/incorrect-behavior-of-destroying-event-in-example-code/3219541) | Não verificado se corrigido |
| Com `StreamingEnabled`, Instance que sai do stream é reparentada pra `nil`, não destruída — `ObjectValue.Value` fica válido, `nil` até (re)stream in | [3979778](https://devforum.roblox.com/t/feedback-on-objectvalue/3979778) | Sim (EndlessSashimi, staff) — doc atualizada em out/2025 |

## Fontes (acesso 2026-07-04)

- [Instance | Documentation](https://create.roblox.com/docs/reference/engine/classes/Instance) (via mirror `raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/classes/Instance.yaml`) — doc oficial de `Destroy()`, `Parent`, `Destroying`.
- [ObjectValue | Documentation](https://create.roblox.com/docs/reference/engine/classes/ObjectValue) (via mirror raw.githubusercontent equivalente) — doc oficial da classe.
- [ObjectValue doesn't automatically clear out non-existent object](https://devforum.roblox.com/t/objectvalue-doesnt-automatically-clear-out-non-existent-object/1687465)
- [ObjectValue.Changed does not fire when :Destroy() is called on the value](https://devforum.roblox.com/t/objectvaluechanged-does-not-fire-when-destroy-is-called-on-the-value/3600077)
- [Tip: How to tell if ObjectValue.Value has been destroyed/is actually nil](https://devforum.roblox.com/t/tip-how-to-tell-if-objectvaluevalue-has-been-destroyedis-actually-nil/1867489)
- [ObjectValue Instance Problems (RefPropDescriptor)](https://devforum.roblox.com/t/objectvalue-instance-problems-properties-that-hold-an-instance-require-innovation-refpropdescriptor/3084990)
- [Feedback on "ObjectValue"](https://devforum.roblox.com/t/feedback-on-objectvalue/3979778)
- [Instance.Destroying fires too late](https://devforum.roblox.com/t/instancedestroying-fires-too-late/2842369)
- [Instance.Destroying Not Firing When Parent Is Being Destroyed](https://devforum.roblox.com/t/instancedestroying-not-firing-when-parent-is-being-destroyed/3052042)
- [Incorrect Behavior of Destroying Event in Example Code](https://devforum.roblox.com/t/incorrect-behavior-of-destroying-event-in-example-code/3219541)
- [ObjectValue's values stop tracing things parented to nil and back](https://devforum.roblox.com/t/objectvalues-values-stop-tracing-things-that-were-parented-to-nil-and-back-until-its-own-value-property-gets-reset/3952107) (não relacionado a Team Create — só editor/autocomplete)
- [Destroy() Can Now Replicate to Clients](https://devforum.roblox.com/t/destroy-can-now-replicate-to-clients/1694890) (contexto servidor/cliente de jogo publicado, não Team Create)
- [Instance parameters not guaranteed to be replicated before being destroyed](https://devforum.roblox.com/t/instance-parameters-not-guaranteed-to-be-replicated-before-being-destroyed-yet-children-are/2310933) (idem, não Team Create)

## Confiança

- Pergunta 1 (Value não zera / Changed não dispara em Destroy): **média** —
  não há uma frase da doc oficial dizendo isso explicitamente, mas há
  confirmação consistente e repetida de staff da Roblox em múltiplos threads
  do DevForum ("intended behavior"), reforçada pela recomendação oficial de
  `Destroy()` para zerar variáveis manualmente (que só faz sentido se o
  engine não faz isso automaticamente).
- Pergunta 2 (comportamento sob Team Create especificamente): **baixa /
  não encontrado** — nenhuma fonte trata do cenário exato; extrapolação a
  partir da pergunta 1, não confirmação direta. Precisa de teste com dois
  Studios reais antes de virar `[Verificado]` em qualquer doc do projeto.
- Pergunta 3 (padrão de detecção robusto): **média** — combinação
  Parent==nil + pcall é consistente com a garantia oficial documentada
  ("locks the Parent property"), mas a doc não descreve esse padrão
  explicitamente como API pública recomendada; vem de dedução da comunidade.
- Pergunta 4 (pegadinhas do DevForum): **alta** para os threads com resposta
  de staff citada; **média** para os sem resposta de staff (relatos de
  usuário, não confirmados oficialmente).
