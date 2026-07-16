# Wally: `wally install` apaga a pasta `Packages/` inteira? Como vendorizar um módulo manual sem risco?

## Pergunta

O usuário quer adicionar/manter um módulo MANUALMENTE dentro de `Packages/`
(pasta gerada pelo `wally install`) e teme que rodar `wally install` de novo
apague esse módulo, já que o Wally geralmente reconstrói `Packages/` a partir
do `wally.lock`. Três perguntas: (1) `wally install` limpa a pasta inteira ou
só atualiza o que está no lockfile? (2) existe opção em `wally.toml`/flag de
CLI pra excluir um subcaminho de ser apagado? (3) se não existe, qual a
prática recomendada pra vendorizar um módulo manual sem risco?

## Resposta objetiva

**Sim, `wally install` apaga a pasta de destino INTEIRA (`Packages/`,
`ServerPackages/`, `DevPackages/`) recursivamente a cada execução**, via
`fs::remove_dir_all`, antes de reconstruir a partir do `wally.lock` — não há
diff/merge seletivo. **Não existe nenhuma opção em `wally.toml` nem flag de
CLI para excluir um subcaminho desse apagamento.** O campo `exclude` que
existe em `wally.toml` é para outra coisa (o que entra no pacote quando VOCÊ
publica um pacote seu no registry), não protege conteúdo de `Packages/`
contra o `clean()` do install. Qualquer arquivo colocado manualmente dentro
de `Packages/`, `ServerPackages/` ou `DevPackages/` será destruído na próxima
`wally install`. Prática recomendada: colocar o módulo manual FORA dessas
três pastas (pasta irmã, ex. `Vendor/` ou similar, mapeada separadamente no
`default.project.json` do Rojo) — o Wally não tem suporte documentado a
"dependência local/path" no `wally.toml` que pudesse servir de escape hatch
dentro da árvore gerenciada.

## Detalhes e ressalvas

### 1. Comportamento de `wally install` (confirmado no código-fonte)

Fonte: `src/installation.rs` do repositório oficial `UpliftGames/wally`
(branch `main`, acesso 2026-07-16). Função verbatim:

```rust
pub fn clean(&self) -> anyhow::Result<()> {
    fn remove_ignore_not_found(path: &Path) -> io::Result<()> {
        if let Err(err) = fs::remove_dir_all(path) {
            if err.kind() != io::ErrorKind::NotFound {
                return Err(err);
            }
        }

        Ok(())
    }

    remove_ignore_not_found(&self.shared_dir)?;
    remove_ignore_not_found(&self.server_dir)?;
    remove_ignore_not_found(&self.dev_dir)?;

    Ok(())
}
```

Onde (mesmo arquivo, construtor `new`):

```rust
let shared_dir = project_path.join("Packages");
let server_dir = project_path.join("ServerPackages");
let dev_dir = project_path.join("DevPackages");
```

E em `src/commands/install.rs`, o comando chama `installation.clean()?;`
antes de `installation.install()`, ou seja, **toda execução de
`wally install` remove recursivamente as três pastas inteiras** (ignorando
apenas o erro "não existe") e as reconstrói do zero a partir da resolução do
lockfile. Não há lógica de "podar seletivamente" o que não está no lockfile
nem de preservar arquivos não gerenciados — é tudo ou nada: a pasta some e
volta recriada só com o que o Wally escreve.

### 2. Opção de excluir subcaminho do apagamento

Não encontrada. O `README.md` oficial (mesma branch) documenta um campo
`exclude` (ex. `exclude = ["node_modules"]`) no manifesto `wally.toml`, mas
esse campo controla **o que é empacotado quando você PUBLICA um pacote seu**
no registry Wally (`wally publish`) — não tem relação com proteger conteúdo
local de `Packages/` contra o `clean()` do `install`. Não há flag de CLI
documentada (`wally install --help` só expõe `--locked`, que faz o comando
falhar se o lockfile não bater com o manifesto, sem afetar o comportamento
de limpeza). Nenhuma menção a dependências "path"/locais no `wally.toml` que
pudessem servir de mecanismo alternativo — apenas dependências de registry
(`scope/name@version`) e git (`git:https://...`) são suportadas conforme o
README.

### 3. Prática recomendada (inferência fundamentada, sem confirmação explícita de "best practice" da comunidade)

Não achei um tópico do DevForum discutindo especificamente esse workaround
("vendorizar módulo manual junto de pacotes Wally"). A busca por
`wally Packages folder vendor manual module workaround devforum roblox`
trouxe só threads sobre bugs de instalação/pasta não sendo criada, sem
relação direta. Dado o comportamento confirmado no código (destruição total
e incondicional de `Packages/`/`ServerPackages/`/`DevPackages/`), a única
prática seguramente compatível é: **manter o módulo manual em uma pasta
fora das três pastas gerenciadas pelo Wally** (ex. `Vendor/` ou
`ManualPackages/` na raiz do projeto), mapeada como pasta extra no
`default.project.json` do Rojo/SyncTeam e requerida (`require`) pelo caminho
próprio, não como se fosse um pacote Wally. Isso é consistente com a
convenção já adotada no projeto (`.claude/rules/typescript.md` menciona
"pastas extras do usuário" como algo já suportado pelo formato Rojo). Marco
esta parte como **inferência**, não como prática documentada oficialmente
ou confirmada por consenso do fórum.

## Fontes (acesso 2026-07-16)

- [`UpliftGames/wally` — `src/installation.rs`](https://raw.githubusercontent.com/UpliftGames/wally/main/src/installation.rs) — função `clean()`, `remove_ignore_not_found`, definição de `shared_dir`/`server_dir`/`dev_dir` = `Packages`/`ServerPackages`/`DevPackages`.
- [`UpliftGames/wally` — `src/commands/install.rs`](https://raw.githubusercontent.com/UpliftGames/wally/main/src/commands/install.rs) — chamada de `installation.clean()?` antes de `install()`; flag `--locked`.
- [`UpliftGames/wally` — `README.md`](https://raw.githubusercontent.com/UpliftGames/wally/main/README.md) — campo `exclude` do manifesto (escopo: publish, não install), ausência de dependência tipo "path", suporte a dependência git.
- [`UpliftGames/wally` (repo principal)](https://github.com/UpliftGames/wally/) — página do projeto.
- Busca no DevForum sem resultado direto sobre o workaround específico (ver query acima) — tratado como lacuna, não como "não existe solução".

## Confiança

- Item 1 (limpeza total incondicional): **alta** — confirmado no código-fonte
  oficial, função literal lida via raw.githubusercontent.
- Item 2 (ausência de opção de exclusão do install): **alta** — ausência
  confirmada tanto no código (`install.rs`/`installation.rs` não expõem tal
  flag) quanto no README oficial.
- Item 3 (prática recomendada — pasta irmã fora de `Packages/`): **média**,
  é a única opção logicamente segura dado o comportamento confirmado, mas
  não é uma "best practice" documentada explicitamente pela comunidade/DevForum
  que eu tenha encontrado — é dedução, não confirmação de terceiros.
