- `api.github.com/search/code?q=...` exige autenticação (retorna 401 sem
  token) mesmo pra repositório público — não usar como atalho de busca de
  código; usar a Contents API (listar diretório) + WebFetch no raw em vez
  disso.

## Tooling Luau (lint/format/teste headless) — lune, selene, stylua, testez

- Doc oficial do Lune (`lune-org.github.io/docs/`) tem página dedicada
  "API Status" da lib `roblox` (`lune-org.github.io/docs/roblox/4-api-status/`)
  que lista TAXATIVAMENTE o que é suportado (`DataModel.GetService`/
  `FindService`, ~23 métodos genéricos de `Instance`, ~23 datatypes tipo
  Vector3/CFrame/Color3) com aviso explícito "if an API on a class is not
  listed here it may not be within the scope for Lune" — atalho direto pra
  responder "Lune suporta serviço X?" sem precisar vasculhar changelog.
  Achado central: Lune **NÃO** mocka `game`/`workspace`/`script` nem
  serviços vivos (`TestService`, `HttpService:CreateWebStreamClient`,
  `ScriptEditorService`, `ChangeHistoryService`) — a lib `roblox` é só
  serialização/manipulação de arquivo de place/model, "more limited API"
  que o engine real (frase literal da doc). Ferramentas de terceiro que
  tentam emular mais por cima do Lune (ex. `lune-test`, DevForum
  t/4658410, mai/2026) usam `getfenv()` (2-3x mais lento, incompleto) — bom
  pra citar como "existe, mas não maduro", não como solução pronta.
- **TestEZ (`Roblox/testez`) foi arquivado pelo dono em 14/set/2024**
  (read-only) — não é mais o padrão ativo em 2026. Sucessor "oficial" da
  própria Roblox é `jsdotlua/jest-lua` → `Roblox/jest-roblox` (esse último é
  só "read-only mirror", dev real é interno), mas a doc/issue do
  `jsdotlua/jest-lua` confirma que **ainda não roda headless via Lune/Luvit
  em 2026** ("Jest Lua can currently only run inside of Roblox... help
  wanted to get it running in other Lua environments, such as Lune or
  Luvit") — ou seja, não adotar Jest Roblox esperando rodar fora do Studio.
  O caminho legado de TestEZ pra CI era `LPGhatguy/lemur` (reimplementação
  parcial da API Roblox em Lua puro, pré-Lune) — não confirmei atividade
  recente, tratar como possivelmente abandonado, não recomendar pra código
  novo sem checar de novo. Conclusão útil pra recomendação de arquitetura:
  em 2026 não existe framework de teste estilo-spec maduro e amplamente
  adotado que rode headless pra código Luau que dependa de Roblox; o que dá
  pra testar headless com Lune é só lógica pura (sem tocar serviço do
  Studio), com um runner simples baseado em `assert`, não um framework BDD.
- Selene (`Kampfkarren/selene`) e StyLua (`JohnnyMorganz/StyLua`) são
  projetos de autores DIFERENTES (não confundir como "mesmo projeto") mas
  ativamente mantidos os dois em 2026 (releases de mai/2026) e sempre
  aparecem juntos em templates comunitários de Rojo+Wally+Rokit — bom
  padrão pra confirmar rápido: `selene.toml` usa `std = "roblox"` (+
  opcional `roblox-std-source = "pinned"` pra gerar `roblox.yml` local sem
  depender de rede a cada 6h; `selene update-roblox-std` força refresh) pra
  reconhecer `game`/`script`/`workspace`/`Instance` sem falso-positivo.
  Rokit (`rojo-rbx/rokit`, sucessor de Aftman/Foreman) é o instalador
  padrão pra essas ferramentas hoje: `rokit add <owner>/<repo>` (ex.
  `rokit add lune-org/lune`, `rokit add Kampfkarren/selene`,
  `rokit add JohnnyMorganz/StyLua`) + `rokit.toml` versionado no repo.
  Detalhe completo (incl. lista de fontes e ressalva sobre alegação não
  confirmada de rename `stylua.toml`→`.stylua.toml`) em
  `.claude/research/2026-08-02-lune-selene-stylua-testez-luau-tooling.md`.

## `SetAttribute` com valor Instance — `InstanceHandle` (beta jul/2026)

- Confirmado (fórum, não ainda em doc de referência): desde post oficial de
  staff no DevForum em 23/jul/2026, `Instance:SetAttribute(nome, instancia)`
  aceita um valor `Instance` diretamente — sem toggle de beta, "no setup
  required". Mas `GetAttribute()` NÃO devolve a Instance: devolve um novo
  tipo de engine `InstanceHandle`, que exige `:Get()` (não-bloqueante, nil
  se ausente) ou `:Wait([timeout])` (bloqueante) pra obter a Instance real.
  `GetAttributeChangedSignal` dispara ao trocar/apagar o atributo, mas NÃO
  dispara quando o alvo entra/sai de streaming nem quando é destruído —
  mesmo padrão de sinal frágil já registrado em `.claude/rules/luau.md`
  pra `Source.Changed`/`ObjectValue.Changed`.
- **Achado crítico pra qualquer decisão de arquitetura**: staff da própria
  Roblox confirma NA MESMA thread que o comportamento em `:Destroy()` do
  alvo referenciado **ainda não está implementado/finalizado** — hoje pode
  gerar yield infinito em `:Wait()` sem timeout (bug relatado e confirmado
  por staff como esperado no estado atual); invalidação automática (erro ou
  cancelamento com warning) é só uma ideia futura. Ou seja: ao contrário de
  `ObjectValue.Value` (documentado no projeto como referência morta mantida,
  nunca nil), o destino de `InstanceHandle` após Destroy() não está fechado
  — não assumir nenhum dos dois comportamentos sem re-testar.
- **Não encontrei em lugar nenhum** (post original, 5 páginas de replies,
  thread separada "What is an InstanceHandle?", buscas dedicadas) qualquer
  menção a comportamento em **Team Create** (replicação entre dois clientes
  Studio na mesma sessão colaborativa — o caso de uso central do SyncTeam).
  O que existe confirmado (relato de usuário, não staff) é replicação via
  `RemoteEvent` servidor↔cliente em jogo publicado, que é mecanismo
  DIFERENTE de replicação de atributo entre Studios via Team Create. Se
  isso virar relevante pra decisão de arquitetura, é preciso spike em dois
  Studios reais, não assumir a partir do caso RemoteEvent.
- Doc oficial de referência (`create.roblox.com/docs/reference/engine/
  classes/Instance#SetAttribute`, guia `Roblox/creator-docs`
  `content/en-us/scripting/attributes.md`) e dump de terceiros
  (`robloxapi.github.io`, changelog e página de classe `InstanceHandle.html`
  → 404) ainda não refletem a feature (checado 02/ago/2026) — só o DevForum
  confirma até agora.
- Detalhe completo, com atribuição de cada afirmação a staff vs. usuário
  comum e trechos citados, em
  `.claude/research/2026-08-02-setattribute-instance-value.md`.

## `DescendantRemoving`/`DescendantAdded` — semântica exata em reparent

- Fonte oficial mais confiável pra semântica EXATA (texto literal) de
  eventos de `Instance` não é a página HTML renderizada
  (`create.roblox.com/docs/reference/engine/classes/Instance#Nome`, que via
  WebFetch só devolve assinatura + exemplo trivial, sem a descrição em prosa)
  — é o **YAML fonte** do repositório `Roblox/creator-docs`:
  `raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/classes/Instance.yaml`
  (pedir pro WebFetch achar o bloco do evento específico; arquivo é grande,
  ~2400 linhas, pode truncar — pedir trechos visados por nome do evento).
- **Definição textual exata confirmada**: `DescendantRemoving` = "fires
  immediately before the parent Instance changes such that a descendant
  instance will no longer be a descendant" — ou seja, é relativo ao
  ancestral em que o evento foi conectado: só dispara quando a Instance está
  prestes a DEIXAR de ser descendente DAQUELE ancestral específico. Reparent
  direto entre duas posições que continuam ambas dentro da mesma árvore
  observada não deveria disparar (a relação de descendência nunca se rompe);
  reparent para uma Instance órfã (recém-criada, ainda sem `.Parent`) ou pra
  fora da árvore, sim, dispara — mesmo que temporário/rápido.
- `DescendantAdded` documentado oficialmente só como "fires after a
  descendant is added" — a alegação (comum em resumos de busca/Fandom) de
  que dispara INDIVIDUALMENTE pra cada descendente pré-existente quando uma
  subárvore inteira é reparentada de uma vez **não está confirmada na doc
  oficial** (página oficial só tem exemplo trivial de 1 instância sem
  filhos). Único suporte encontrado é DevForum (2020,
  `t/descendantadded-with-models/94936`), sem confirmação staff, e com
  ressalva explícita de um dos respondentes ("Anaminus": comportamento comum
  mas "nothing guaranteeing that it happens in all possible cases").
- `Enum.SignalBehavior` (`Default`/`Immediate`/`Deferred`/`AncestryDeferred`)
  controla se handlers desses eventos rodam inline (`Immediate`) ou
  enfileirados pro próximo "resumption point" (`Deferred` — recomendado pela
  Roblox, e já é o padrão em places NOVOS/template; em places EXISTENTES o
  valor `Default` ainda equivale a `Immediate`, então **checar
  `workspace.SignalBehavior` no place real** antes de assumir qual modo
  está ativo). Doc oficial: `create.roblox.com/docs/scripting/events/deferred`
  (ou `.md` fonte em `Roblox/creator-docs`). Nenhuma fonte (oficial ou
  fórum) confirma a ordem exata quando MÚLTIPLOS eventos (remove + add) pra
  MESMA Instance ficam enfileirados no mesmo lote deferido — ponto em
  aberto, só teste real em Studio resolve.
- Detalhe completo (aplicado ao caso real de
  `SourceWatcher.resolvePath`/conversão Folder→Script, com citações) em
  `.claude/research/2026-08-02-reparent-descendantremoving-semantics.md`.

## `Enum.Font`/`Font`/`FontFace`/`Enum.FontWeight` — reskin de UI (Theme/StatusPanel/Toast)

- **Atalho de fonte primária pra qualquer dúvida de enum/datatype Font**:
  YAML bruto em `raw.githubusercontent.com/Roblox/creator-docs/main/
  content/en-us/reference/engine/{enums,datatypes}/<Nome>.yaml` — mesmo
  padrão já usado pra `Instance.yaml` acima. Confirmado funcionando pra
  `enums/Font.yaml`, `enums/FontWeight.yaml`, `datatypes/Font.yaml`,
  `classes/TextLabel.yaml` (WebFetch com prompt pedindo texto verbatim das
  descriptions, não resumo, dá resultado confiável e citável).
- **`Enum.Font.Nunito` EXISTE** no enum atual (valor 35) — confirmado em
  YAML oficial + página HTML renderizada + WebSearch, os três batendo.
  Lista completa do enum `Font` (54 itens, ordem oficial) está salva em
  `.claude/research/2026-08-02-font-enum-fontface-fontweight-nunito.md` —
  útil pra qualquer pergunta futura tipo "Enum.Font.X existe?" sem precisar
  refazer o fetch.
- **`Font` (datatype)/`FontFace` (propriedade)/`Font.new`/`Font.fromName`/
  `Font.fromEnum`/`Font.fromId` são todos reais e documentados hoje**,
  assinaturas exatas confirmadas via YAML oficial: `Font.new(family:
  Content, weight?: Enum.FontWeight = Regular, style?: Enum.FontStyle =
  Normal)` (family é asset id `rbxasset://`/`rbxassetid://`, NÃO nome cru);
  `Font.fromName(name: string, weight?, style?)` aceita nome tipo
  `"FredokaOne"` (sem espaço, mesmo texto do item do enum — confirmado por
  relato de fórum de erro comum ao usar `"Fredoka One"` com espaço);
  `Font.fromEnum(font: Enum.Font)` (erro se `Enum.Font.Unknown`).
- **`Enum.FontWeight` — 9 valores confirmados** (YAML oficial):
  `Thin`(100)/`ExtraLight`(200)/`Light`(300)/`Regular`(400, default)/
  `Medium`(500)/`SemiBold`(600)/`Bold`(700)/`ExtraBold`(800)/`Heavy`(900).
- **Gotcha real confirmado por 2 threads DevForum independentes**: mutar
  `instance.FontFace.Weight = X` diretamente **não tem efeito** (comum
  engano — é value type, leitura devolve cópia). Técnica correta: ler
  `.FontFace` numa var local, construir/mutar um `Font` novo (via
  `Font.new`/reatribuição de campo na cópia local), e **reatribuir o objeto
  inteiro de volta** à propriedade `.FontFace`.
- Doc oficial confirma (texto verbatim) que `.Font` (enum legado) e
  `.FontFace` (datatype novo) são propriedades "kept in sync" uma com a
  outra — mas só documenta explicitamente a direção `FontFace→Font`
  ("quando você seta FontFace, Font vira o Enum.Font correspondente ou
  Unknown"). A direção oposta (setar `.Font` reseta peso customizado do
  FontFace de volta pro peso implícito daquele item do enum) é **inferência
  lógica a partir do texto de sincronização, não citação/teste staff
  dedicado** — mas suficiente pra recomendação prática seguir sendo segura:
  em qualquer helper tipo `applyBold(instance)`, sempre setar `.Font`
  primeiro (se for setar) e `.FontFace` por último, nunca o contrário.
- Detalhe completo (com todas as citações verbatim) em
  `.claude/research/2026-08-02-font-enum-fontface-fontweight-nunito.md`.

## Streaming de Source por tecla via Team Create — viabilidade

- **Sem API de patch incremental de escrita**: `ScriptEditorService`
  (YAML oficial, 12 membros) não tem nenhum método de "insert at
  position"/"replace range" para escrever Source — `UpdateSourceAsync`
  sempre reescreve a string inteira via callback `(oldContent) ->
  newContent`. O único range-aware é `TextDocumentDidChange`
  (`{range={start,end}, text}`), mas é evento de LEITURA de mudanças no
  editor local, não API de escrita.
- **Achado mais forte contra "write a cada tecla"**: issue oficial do
  próprio Rojo, `rojo-rbx/rojo#1273` ("Made two way Source sync stable") —
  sincronizar Source a cada tecla causou "repeated writes/server echoes" e
  cursor pulando pro final; a correção foi ELIMINAR write automático por
  tecla e trocar por gatilho manual (atalho). Fonte de confiança média
  (contribuidor individual, issue aberta, não staff Roblox) mas é a analogia
  de caso de uso mais próxima do SyncTeam já achada em qualquer pesquisa do
  projeto — vale a pena checar de novo se essa issue fechar/mergear.
- **Write externo + sessão colaborativa ativa no mesmo Script já é
  sabidamente frágil mesmo em baixa frequência**: thread oficial "Live
  Scripting Beta" (`t/2640607`) tem engenheiro Roblox reconhecendo bug vago
  ("this is a bug with something, but not sure what... corrupted data being
  sent") quando write externo via `UpdateSourceAsync` coincide com sessão
  Live Scripting ativa no mesmo Script — sem fix confirmado até o acesso.
- **Live Scripting em si é construído sobre `UpdateSourceAsync`** (doc
  oficial confirma verbatim) e tem fallback documentado para read-only
  quando a banda é insuficiente — evidência indireta de que write frequente
  de Source via Team Create é sustentável em princípio, mas não prova que a
  mesma eficiência vale pro caminho de API pública exposto a plugins
  (Live Scripting pode ter otimização interna não exposta).
- **Rate limit de replicação de propriedade em Team Create especificamente:
  não encontrado em nenhuma fonte** (nem doc oficial nem DevForum trata
  Team Create como caminho de replicação separado do client-server de jogo
  publicado). A única info de coalescing achada ("só o último valor de uma
  propriedade alterada 3x no mesmo frame replica") é de thread de tutorial
  de usuário sobre replicação de JOGO PUBLICADO, sem citar fonte oficial e
  sem mencionar Team Create — não promover a fato sem spike real.
- Detalhe completo com todas as citações verbatim em
  `.claude/research/2026-08-02-realtime-source-streaming-team-create.md`.

## VS Code Marketplace — erro "suspicious content" no `vsce publish`

- Fora do escopo Roblox, mas registrado aqui porque a pergunta pode
  reaparecer (publicação da extensão SyncTeam). Fonte oficial mais forte
  encontrada: blog `developer.microsoft.com/blog/security-and-trust-in-
  visual-studio-marketplace/` — confirma que TODO pacote publicado passa
  por scanner de malware (motor tipo Defender) + análise dinâmica em
  **sandbox de comportamento em runtime**, e que extensões flagradas vão
  pra revisão manual de engenheiro de segurança pra evitar falso-positivo.
  Não é rate-limit nem coisa que passa só esperando — fica bloqueado até
  correção ou revisão manual.
- **Nenhuma fonte (oficial ou comunidade) confirma qual sinal específico
  dispara o flag** — nem "publisher novo", nem "abrir socket/servidor de
  rede local", nem "metadados incompletos" têm confirmação oficial como
  causa. São só correlações observadas em relatos de usuário (issues
  `microsoft/vsmarketplace` #344/#682/#826/#919, todas sem resposta técnica
  pública da causa raiz) — inclusive há um caso documentado (Microsoft Q&A,
  extensão 100% local sem rede, metadados completos) onde nada disso se
  aplicava e só resolveu via contato manual.
- Mitigação prática mais citada (sem garantia): preencher
  `repository`/`homepage`/`bugs`/`license`/`keywords` no `package.json`,
  `.vscodeignore` limpando `node_modules`/`.git`/scripts de build/fontes
  `.ts` do VSIX final (usar bundler tipo esbuild pra gerar `dist/` único),
  conferir `publisher` no manifest bate exatamente (case-sensitive) com o
  nome no portal.
- Canal oficial de contestação/revisão manual: e-mail
  `vsmarketplace@microsoft.com` e abrir issue no repositório
  `github.com/microsoft/vsmarketplace` ("Customer feedback and issue
  tracker repository for Visual Studio Marketplace"). Existe também um
  formulário de suporte linkado do portal/Partner Center, mas o atalho
  `aka.ms/...` exato variou entre fontes consultadas — não confirmei qual é
  o correto, checar direto no portal quando for usar.
- Detalhe completo com todas as citações em
  `.claude/research/2026-08-02-vsce-publish-suspicious-content-error.md`.

## Rokit — formato de artefato exigido / distribuição do plugin do Rojo

- **Rokit não exige manifest do lado do autor da ferramenta** (nada tipo
  `rokit-manifest.json`) — só heurística de NOME do asset + fallback de
  parsing binário real. Código-fonte relevante em
  `github.com/rojo-rbx/rokit`:
  - `lib/descriptor/os.rs`: detecção de SO por substring/palavra no nome do
    arquivo (ex. `"stylua-linux-x86_64-musl"`, `"rojo-...-win64"`).
  - `lib/descriptor/executable_parsing.rs`: FALLBACK que faz parsing real
    dos headers do binário já baixado — ELF (`e_machine`), Mach-O
    (`cputype`, trata "Fat"/universal), PE (`machine` do COFF). Ou seja:
    **o artefato final PRECISA ser um executável nativo válido nesses 3
    formatos** — script puro (`.js`/`.py`/shell) não passa; um binário
    gerado por `bun build --compile`/`pkg`/`nexe` teoricamente passaria (tem
    headers nativos reais), mas não achei nenhum caso confirmado de
    ferramenta Node.js distribuída assim via Rokit (busca dedicada, sem
    resultado).
  - `lib/sources/artifact/provider.rs`: único provider é GitHub Releases
    (`ArtifactProvider::GitHub`, não há GitLab/outro).
  - `lib/sources/artifact/format.rs`: formatos de compressão aceitos
    (nome do arquivo): `.zip`, `.tar`, `.tar.gz`/`.tgz`, `.tar.xz`/`.txz`,
    `.gz`.
  - Consumidor usa `rokit.toml` (`alias = "provider/author/name@version"`);
    instalação local em `{author}-{name}-{version}/`, binário
    `{name}[.exe]` dentro.
- **O Rojo NÃO baixa seu próprio plugin de Studio (`.rbxm`) em runtime nem
  via Rokit** — é feature do PRÓPRIO binário `rojo` (Rokit só entrega o
  binário `rojo`; depois disso `rojo plugin install` age sozinho, sem
  rede). Mecanismo confirmado em `build.rs` (raiz de
  `github.com/rojo-rbx/rojo`, lido diretamente): compila o código Luau-fonte
  da pasta `plugin/` + `plugin.project.json` num `VfsSnapshot` serializado
  pra `plugin.bincode` em tempo de BUILD; esse arquivo é embutido no binário
  via `include_bytes!` (constante `PLUGIN_BINCODE`, confirmado via DeepWiki
  sobre `src/cli/plugin.rs` — não consegui abrir esse arquivo bruto direto,
  path pode ter mudado). Em runtime, só deserializa os bytes já embutidos e
  escreve `RojoManagedPlugin.rbxm` na pasta de plugins do Studio (localizada
  via `RobloxStudio::locate()`, do crate `Kampfkarren/roblox-install` — ver
  seção dedicada abaixo com o path exato por SO). `build.rs` também valida
  que `plugin/Version.txt` bate com a versão do Cargo, evitando plugin
  dessincronizado do CLI. Alternativa manual sem CLI (confiança média, só
  via snippet de busca, não fetch direto): Roblox Creator Store (Asset ID
  `13916111004`) ou `.rbxm` anexado ao GitHub Release.
- **Implicação prática pro SyncTeam** (hoje: extensão VS Code TS + plugin
  Luau, SEM CLI compilado): não cabe direto no padrão Rokit sem antes
  existir um binário nativo standalone do projeto. Se algum dia surgir um
  componente CLI/servidor fora do VS Code, teria que compilar como binário
  nativo real (Rust/Go, ou Node empacotado via `bun build --compile`/`pkg`
  — sem precedente confirmado) publicado em GitHub Release com nome de
  asset contendo palavra-chave de SO/arch reconhecível.
- **CORREÇÃO (03/ago/2026) — a afirmação acima de "Rokit só aceita
  `owner/repo` completo, sem registro central" estava INCOMPLETA.** Existe
  sim um mecanismo de shorthand (`rokit add rojo` sem owner funciona,
  confirmado ao vivo pelo usuário), mas é **lista hardcoded no código-fonte
  do binário**, não registro dinâmico tipo npm nem busca por GitHub API.
  Vive em `src/util/constants.rs` (não em `lib/`): constante
  `KNOWN_TOOL_AUTHORS_AND_IDS` (array de 8 pares autor→[ferramentas]),
  processada num `BTreeMap` (`KNOWN_TOOLS`, lookup case-insensitive) via
  `get_known_tool(tool)`. Consumida em `src/util/id_or_spec.rs`
  (`ToolIdOrSpec::from_str`): se o argumento não contém `@`, tenta
  `get_known_tool(s)` ANTES de tentar parsear como `ToolId` cru (que exige
  `owner/nome`) — só cai pro parse cru se não achar no mapa. Lista completa
  hoje (8 autores, 12 ferramentas): `evaera`→`moonwave`;
  `Iron-Stag-Games`→`lync`; `JohnnyMorganz`→`luau-lsp`,`StyLua`,
  `wally-package-types`; `Kampfkarren`→`selene`; `luau-lang`→`luau`;
  `lune-org`→`lune`; `rojo-rbx`→`remodel`,`rojo`,`tarmac`;
  `UpliftGames`→`wally`. **Não documentado** em README/CHANGELOG (busca
  dedicada nos dois, sem achado) — só descobrível lendo o código-fonte.
  **Sem `CONTRIBUTING.md` no repo** e sem processo formal encontrado pra
  terceiro entrar nessa lista — hoje só ferramentas do núcleo do
  ecossistema Rojo/Luau estão lá, nenhum precedente de projeto externo;
  entrar exigiria PR direto em `src/util/constants.rs` a critério dos
  mantenedores. **Implicação pro `syncteam-cli`**: sem esse shorthand,
  usuários sempre precisam do owner completo (`rokit add
  <owner>/SyncTeam`), que já funciona hoje sem mudança nenhuma — não é
  bloqueio, só significa que não vira `rokit add SyncTeam` sem pedir (e
  provavelmente não conseguir) entrada nessa lista curada. Detalhe completo
  com o código-fonte citado verbatim em
  `.claude/research/2026-08-03-rokit-known-tools-shorthand-mechanism.md`.
- Detalhe completo com todas as citações de código-fonte em
  `.claude/research/2026-08-02-rokit-artifact-format-rojo-plugin-distribution.md`.

## Bun `bun build --compile` — embutir arquivo binário arbitrário (equivalente a `include_bytes!` do Rust)

- **Confirmado, doc oficial, feature madura desde v1.1.5 (mai/2024)** — bem
  antes da 1.3.13 usada no projeto. Sintaxe:
  `import rbxmPath from "./SyncTeam.rbxm" with { type: "file" }`. O import
  devolve uma **string de path** (não os bytes): em dev aponta pro arquivo
  real; depois de `bun build --compile` vira path virtual interno
  `/$bunfs/root/<nome>-<hash>.<ext>`. Leitura em runtime é **API idêntica**
  dentro e fora do binário compilado: `await Bun.file(rbxmPath).bytes()`
  (→ `Uint8Array`, ideal pra binário) ou `.arrayBuffer()`/`.text()`; `node:fs`
  (`readFileSync`) também funciona sobre o mesmo path virtual.
- Sem limite de tamanho/tipo documentado — doc oficial usa exatamente esse
  mecanismo pra `.wasm`, `.ttf`, `.node` (N-API addon) e libs nativas
  (`.dylib`/`.so`/`.dll` via `bun:ffi`) como exemplos de "binary files",
  então `.rbxm` (poucos KB) não é caso de risco plausível.
- `Bun.embeddedFiles: ReadonlyArray<Blob>` lista tudo que foi embutido
  (ordenado por nome, vazio fora de standalone) — útil só pra debug/
  verificação pós-build, não necessário no fluxo principal.
  `Bun.isStandaloneExecutable: boolean` detecta se está rodando dentro do
  binário compilado sem custo de alocar Blobs.
- Único bug relevante achado (Windows, `bun build --compile` travando com
  binário embutido + `--minify`/`--sourcemap`) foi na v1.1.4, corrigido logo
  em seguida (PR referenciada no próprio issue) — não afeta a 1.3.13 atual,
  mas vale lembrar se aparecer algo estranho ativando essas flags junto de
  embed no Windows.
- Não é necessário recorrer à alternativa "base64 em string constante"
  (mais simples/sem dependência de bundler, mas gera +33% de tamanho de
  fonte e um passo extra de geração) — a feature nativa está madura e sem
  relato de instabilidade pra arquivo binário genérico na versão atual;
  guardar a alternativa como fallback só se aparecer bug real ao testar.
- Doc oficial: `bun.sh/docs/bundler/executables` (seção "Embed assets &
  files") e `bun.com/reference/bun/embeddedFiles`. Detalhe completo com
  citações em
  `.claude/research/2026-08-03-bun-compile-embed-binary-file-rbxm.md`.

## Pasta de Plugins locais do Roblox Studio por SO — Windows `[Verificado]`, macOS sem doc oficial

- **Windows** (já em uso em `Tools/build-and-deploy-plugin.sh` e
  `cli/src/plugin/studioPluginsDir.ts`): `%LOCALAPPDATA%\Roblox\Plugins`.
- **macOS**: `~/Documents/Roblox/Plugins`. **Nenhuma doc oficial
  (`create.roblox.com/docs`) nem post de staff no DevForum confirma esse
  caminho** — todas as threads relevantes do fórum revisadas (várias sobre
  "plugin não aparece no Mac") discutem o problema sem ninguém citar o path
  exato. A confirmação mais forte disponível é o código-fonte real do crate
  `Kampfkarren/roblox-install` (mesmo autor de Selene; é o mecanismo que o
  **próprio Rojo usa** para achar a pasta de plugins e instalar
  `RojoManagedPlugin.rbxm` — ver `build.rs`/`RobloxStudio::locate()` citado
  acima). Bloco relevante (`src/lib.rs`, `#[cfg(target_os = "macos")]`,
  `locate_from_directory`):
  ```rust
  let documents = dirs::document_dir().ok_or(Error::DocumentsDirectoryNotFound)?;
  let plugins = documents.join("Roblox").join("Plugins");
  ```
  (`dirs::document_dir()` resolve pra `$HOME/Documents` no macOS).
- **Cuidado com um contraexemplo de baixa qualidade circulando**: página
  de terceiros sem vínculo aparente com a Roblox
  (`roblox-studio-plugins-folder.pages.dev`) afirma
  `~/Library/Application Support/Roblox/Plugins` — sem fonte citada, e
  `~/Library/Application Support/Roblox` de fato existe no macOS (confirmado
  por artigo oficial de suporte sobre desinstalar o Roblox Player), mas como
  pasta de dados/cache do Roblox em geral, não há evidência de que a
  subpasta `Plugins` de lá seja usada pelo Studio para plugins locais.
  Tratar essa alegação como não confirmada/provavelmente errada se
  reaparecer em pesquisa futura.
- Existe um setting `Studio.PluginsDir` (mencionado em
  `Kampfkarren/roblox-install` issue #33 e ecoado por relato de usuário no
  DevForum que resolveu bug de plugin sumido "mudando o Plugins Directory")
  que pode fazer o valor real divergir do default por máquina — não achei
  onde esse setting fica exposto na UI do Studio.
- Detalhe completo com todas as citações em
  `.claude/research/2026-08-03-macos-studio-plugins-folder-path.md`.

## VS Code — ícone customizado em `StatusBarItem` (SVG direto NÃO existe)

- **`StatusBarItem.text` só aceita texto + `$(codicon-id)` (`ThemeIcon`)**,
  nunca imagem/SVG direto. Prova forte da ausência: issue oficial
  `microsoft/vscode#72244` pedindo exatamente sintaxe `$(custom:path/to/
  icon.svg)` foi **fechada em 09/out/2019 como "completed"** sem implementar
  esse path — o que endereçou o pedido foi a contribution point `icons`
  (glyph-em-fonte), não SVG cru.
- **`contributes.icons`** (schema confirmado no guia oficial "Product Icon
  Theme"): `{ "id": { "description": "...", "default": { "fontPath":
  "./x.woff", "fontCharacter": "\\E001" } } }`. Citação verbatim da doc:
  "VS Code requires the icons to be defined as glyph in an icon font." —
  **fonte (WOFF recomendado), nunca SVG solto**, mesmo a doc "recomendando
  SVG" em outro contexto (comandos/views, não essa contribution point).
  Depois de declarado, usa-se `$(id)` em qualquer lugar que aceite
  `ThemeIcon`, inclusive `StatusBarItem.text`.
- **Ferramenta padrão pra gerar a fonte a partir de SVGs**: `fantasticon`
  (`github.com/tancredi/fantasticon`, hoje sob `twbs/fantasticon`) — é a
  MESMA ferramenta usada pelo próprio `microsoft/vscode-codicons` pra gerar
  a fonte de ícones do VS Code, bom precedente de confiança.
- **Ícone da extensão na view de Extensions/Marketplace (campo `icon` no
  manifest)**: doc oficial pede PNG mín. 128x128 (256x256 Retina).
  Confirmado (issue oficial aberta `microsoft/vsmarketplace#1272`) que
  `vsce` **recusa publicar** com SVG nesse campo por segurança — sempre
  converter SVG→PNG antes (passo único, bem mais simples que gerar fonte).
- Detalhe completo com todas as citações em
  `.claude/research/2026-08-03-statusbaritem-custom-icon-svg.md`.
