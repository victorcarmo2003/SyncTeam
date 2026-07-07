# Regras de código TypeScript (extensão VS Code / harness Node)

- **Rede**: servidor WebSocket com pacote `ws`, bind exclusivamente em
  `127.0.0.1` — nunca `0.0.0.0`. Portas com default fixo e configuráveis.
- **Protocolo**: mensagens JSON com campo `kind` obrigatório e `requestId` em
  requisições/respostas. Validar toda mensagem recebida antes de usar; mensagem
  inválida é logada e descartada, nunca derruba o servidor.
- **Formato Rojo**: toda a lógica de nomenclatura de arquivos
  (`*.server.luau`, `*.client.luau`, `init.*`, mapeamento do
  `default.project.json`) vive em um módulo único e testado — nenhuma outra
  parte do código constrói nomes de arquivo por conta própria.
- **Toolchain** (herdada do RojoCoop, que já funcionou): TypeScript estrito,
  esbuild para bundle, vitest para testes. Sem frameworks pesados; dependências
  novas precisam de justificativa.
- **Escrita em disco**: operações no workspace do usuário passam pela API do
  VS Code (`workspace.fs`/edits) quando a extensão estiver ativa, para o buffer
  aberto acompanhar; harness de spike pode usar `node:fs` direto.
- Escreva para Windows e Unix: paths com `path.join`/`path.posix` conforme o
  contexto, comparação de paths case-insensitive no Windows (bug real corrigido
  no RojoCoop).
