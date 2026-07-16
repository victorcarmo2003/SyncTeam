# WebStreamClient: dá pra ler o close code (1013) e o motivo de um fechamento de WebSocket?

## Pergunta

O harness (extensão VS Code) rejeita uma segunda conexão de plugin fechando o
socket com `socket.close(1013, "SyncTeam: já existe um plugin conectado")`
(biblioteca `ws` do Node — código de close 1013 "Try Again Later" + reason em
texto). Do lado do plugin Luau, que conecta via
`HttpService:CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, { Url = ... })`:

1. Qual é o nome exato da classe/tipo retornado por `CreateWebStreamClient`? Tem página de referência oficial?
2. O evento de fechamento (`Closed`, se existir) expõe o close code numérico e/ou a reason string?
3. O evento `Error` (se existir separado) expõe algo equivalente (código, mensagem) que ajude a diferenciar "servidor rejeitou de propósito com motivo" de "nada ouvindo na porta"/"erro de rede genérico"?
4. Já existe registro anterior neste projeto confirmando (ou não) esse ponto?

## Resposta objetiva

**Não dá, de forma alguma, hoje (confirmado contra a doc oficial).** `CreateWebStreamClient` retorna um objeto da classe `WebStreamClient` (referência oficial confirmada). Esse objeto expõe 4 eventos: `Opened(responseStatusCode, headers)`, `MessageReceived(message)`, `Error(responseStatusCode, errorMessage)` e `Closed()`. **`Closed` não recebe nenhum parâmetro** — zero close code, zero reason string, documentado explicitamente como evento sem parâmetros (`parameters: []` na doc-fonte). **`Error` recebe `responseStatusCode` e `errorMessage`, mas `responseStatusCode` é documentado como "the standard HTTP error status code (e.g., 404, 500)"** — ou seja, é um status HTTP (nível da conexão/handshake), não o close code do protocolo WebSocket (RFC 6455, ex.: 1000, 1006, 1013). Não há nenhum campo documentado, em `Closed` ou em `Error`, para o close code 1013 ou para a reason string `"SyncTeam: já existe um plugin conectado"` que o servidor `ws` envia. Reforça isso um pedido de feature aberto no DevForum ("Send and receive close codes for WebSockets", 10/jan/2026) pedindo exatamente essa capacidade — sem resposta de staff, sem replies, ainda em aberto — confirmando que a lacuna é conhecida pela comunidade e não resolvida. **Conclusão prática para o SyncTeam**: hoje não é possível diferenciar de forma confiável e documentada "servidor rejeitou com 1013 + motivo" de "erro de rede genérico"/"nada ouvindo na porta" só lendo os parâmetros de `Closed`/`Error`. Qualquer heurística (ex.: a já usada em `runConnection`, plugin/src/init.server.luau: "caiu sem nunca ter recebido mensagem E dentro de uma janela curta") precisa continuar sendo uma inferência por comportamento observado, não uma leitura direta do close code.

## Detalhes e ressalvas

### 1. Classe retornada e página de referência

Confirmado: `create.roblox.com/docs/reference/engine/classes/WebStreamClient` é a página oficial da classe `WebStreamClient` (non-creatable, non-replicated). Propriedade `ConnectionState: WebStreamClientState`. Métodos: `Close()` (fecha e dispara `Closed`), `Send(data: string)` (só funciona para `WebStreamClientType.WebSocket`).

Enum `WebStreamClientState` (`create.roblox.com/docs/reference/engine/enums/WebStreamClientState`) tem 4 valores: `Connecting` (0), `Open` (1), `Error` (2, "An unrecoverable error has occured... cutting off the stream"), `Closed` (3, "closed naturally by the server or manually by the user"). Nenhum desses valores carrega código/motivo — é só um estado enumerado, mesma limitação dos eventos.

### 2. Evento `Closed` — texto oficial verbatim (creator-docs YAML)

```yaml
- name: WebStreamClient.Closed
  summary: ''
  description: |
    Fires when the server closes the connection succesfully or the user calls
    `Class.WebStreamClient:Close()`
  code_samples: []
  parameters: []
```

`parameters: []` — confirmado, não há close code nem reason. Note também que a descrição não distingue "fechado normalmente pelo servidor" de "fechado com código de erro/rejeição pelo servidor" — ambos os casos (fechamento limpo 1000, ou fechamento com 1013 do nosso harness) parecem cair no mesmo evento sem diferenciação.

### 3. Evento `Error` — texto oficial verbatim (creator-docs YAML)

```yaml
- name: WebStreamClient.Error
  summary: |
    Fires if an error is received while establishing the connection or during
    the connection lifetime.
  parameters:
    - name: responseStatusCode
      type: int
      summary: |
        The standard HTTP error status code (e.g., 404, 500).
    - name: errorMessage
      type: string
      summary: |
        A descriptive message containing details about the error.
```

Ponto central: `responseStatusCode` é explicitamente tipado/documentado como **HTTP status code** ("404, 500" como exemplos), não como close code de WebSocket. 1013 é um close code do protocolo WS (RFC 6455 range 1000-1015 + faixa de app 4000+), não um status HTTP — não há garantia nem indício documentado de que o valor 1013 enviado pelo `ws` do Node apareça em `responseStatusCode`, nem que `errorMessage` carregue o texto de reason (`"SyncTeam: já existe um plugin conectado"`) que o servidor mandou. Também não está claro, pela doc, se uma rejeição do tipo "servidor aceitou o handshake HTTP e depois fechou o socket com código de aplicação" dispara `Error` ou só `Closed` — a doc trata `Error` como associado a "estabelecer conexão" (handshake) ou "durante a vida da conexão" de forma genérica, sem exemplo desse cenário específico.

Não encontrei (nem na doc, nem no DevForum) nenhuma tabela de mapeamento "close code WS → o que aparece em qual evento/parâmetro do WebStreamClient". Essa lacuna é a mesma reportada no feature request abaixo.

### 4. Feature request confirma a lacuna (nível de confiança: consistente com a doc, sem resposta oficial)

`devforum.roblox.com/t/send-and-receive-close-codes-for-websockets/4240741` — post único de 10/jan/2026 (usuário "LightOnOff", trust level comum, não staff): "It is not possible (to my knowledge) to send and receive close codes using WebSockets created by HttpService... some APIs rely on these close codes to close cleanly or to quit from errors or invalid states." **Sem nenhuma resposta** (confirmado via endpoint JSON do Discourse: thread com 1 único post, 0 replies) até a data de acesso desta pesquisa. Isso não é uma negação oficial explícita de staff, mas é evidência consistente (nível de confiança médio-baixo, é só 1 post sem staff) de que a comunidade também não encontrou um jeito de ler close codes — e bate exatamente com o que a doc oficial mostra (nenhum parâmetro disponível para isso).

O anúncio original de WebSockets em Studio (`devforum.roblox.com/t/websockets-support-in-studio-is-now-available/4021932`, 23/out/2025) não detalha parâmetros de `Closed`/`Error` nem menciona close codes — é só o anúncio de alto nível, sem substituir a doc de referência da classe.

### 5. Nota lateral (fora do escopo da pergunta, registrada por precaução)

O FAQ do anúncio (resumo, não verbatim) menciona "até 4" conexões simultâneas em algum ponto, enquanto a doc de referência atual de `CreateWebStreamClient` (creator-docs, HttpService.yaml) diz explicitamente **"limit of six total clients allowed at one time"** — mesmo número (6) já usado nas regras do projeto (`.claude/rules/luau.md`). Tratando a doc de referência como fonte mais autoritativa/atual que o texto do anúncio (que é mais antigo, out/2025, e pode ter sido escrito antes do limite final): **manter 6 como o número válido**, sem mudança de recomendação. Registrado aqui só para não perder o dado, não é o foco desta pesquisa.

### O que isso implica para o código do plugin (sem prescrever solução, é decisão de `luau-dev`)

- A heurística já documentada em `docs/PROJECT_STATUS.md` (linhas ~230-238) e `.claude/agent-memory/luau-dev.md` (linhas ~709-726) — inferir rejeição por "caiu sem nunca ter recebido mensagem E dentro de uma janela curta (`PROBABLE_REJECTION_WINDOW_SECONDS`)" — **continua sendo a abordagem correta**, porque a API não dá nenhum caminho direto para ler o código 1013 ou o texto do motivo. Não há necessidade de revisar esse código à luz desta pesquisa; ela só formaliza que a lacuna é real e definitiva (doc oficial confirma ausência de parâmetro, não é falta de sorte em achar a doc certa).
- Se o SyncTeam quiser comunicar o motivo exato da rejeição ao usuário (ex.: "outro plugin já conectado" vs. "harness não está rodando"), o caminho **precisa ser fora do protocolo de close do WebSocket** — ex.: o servidor mandar uma mensagem JSON de aplicação (`MessageReceived`) ANTES de fechar, já que `MessageReceived` carrega o payload completo (`message: string`) e o `Closed`/`Error` não. Isso é só uma constatação da pesquisa, a decisão de implementar fica com `luau-dev`/`extension-dev`.

## Fontes

- https://create.roblox.com/docs/reference/engine/classes/WebStreamClient (via `raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/classes/WebStreamClient.yaml`, acesso 2026-07-15) — confiança alta (doc oficial), inclui texto verbatim dos eventos `Closed`/`Error`/`Opened`/`MessageReceived` e método `Close()`/`Send()`.
- https://create.roblox.com/docs/reference/engine/enums/WebStreamClientState (via raw yaml equivalente, acesso 2026-07-15) — confiança alta.
- https://create.roblox.com/docs/reference/engine/classes/HttpService (seção `CreateWebStreamClient`, via `raw.githubusercontent.com/.../HttpService.yaml`, acesso 2026-07-15) — confiança alta; confirma limite de 6 clientes e ausência de menção a close codes na descrição do método.
- https://devforum.roblox.com/t/send-and-receive-close-codes-for-websockets/4240741 (acesso 2026-07-15, verificado também via endpoint `.json` do Discourse para confirmar que não há replies) — confiança média-baixa (post único de usuário comum, sem confirmação de staff, mas consistente com a doc oficial).
- https://devforum.roblox.com/t/websockets-support-in-studio-is-now-available/4021932 (acesso 2026-07-15) — confiança alta (anúncio oficial Roblox), mas não detalha parâmetros de evento — usado só como contexto/data de lançamento do recurso.
- Contexto interno consultado (confirma que a lacuna nunca foi fechada antes): `docs/PROJECT_STATUS.md` linhas ~230-238, `.claude/agent-memory/luau-dev.md` linhas ~709-726 (registros de 2026-07-07 dizendo explicitamente "sem confirmação salva em `.claude/research/`").

## Confiança geral

**Alta** para a resposta central ("`Closed` não expõe nada, `Error` expõe só HTTP status + mensagem, nenhum dos dois documenta close code WS nem reason string") — vem direto do YAML de referência oficial, fonte primária, sem ambiguidade de redação (`parameters: []` é explícito). **Média-baixa** apenas para a inferência adicional de que 1013/reason "nunca aparecem em lugar nenhum" nesses eventos — isso é ausência de documentação positiva, não um teste ao vivo excluindo a hipótese de o valor aparecer via algum campo não documentado; se quiser 100% de certeza empírica, precisaria logar `responseStatusCode`/`errorMessage` reais durante uma rejeição de verdade (2 Studios, harness rejeitando a 2ª conexão) e conferir se por acaso 1013 aparece ali mesmo sem estar documentado — isso é um teste barato que `luau-dev` já pode ter feito via logging (ver nota "code`/`errorMessage` continuam só logados" em luau-dev.md linha 725); vale checar esse log real antes de fechar o assunto por completo, mas para fins de "posso confiar nisso na doc para desenhar o protocolo", a resposta é definitiva.
