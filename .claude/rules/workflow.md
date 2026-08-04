# Regras de fluxo de trabalho

## Delegação a agentes (pedido explícito do usuário, 2026-07-02)

Para tarefas **não-triviais**, delegue ao agente da área em vez de codar
diretamente na sessão principal:

| Área | Agente |
|---|---|
| Confirmar API/comportamento externo (Roblox, VS Code, Node) | `researcher` |
| Código Luau / plugin Studio / schema Team Create | `luau-dev` |
| TypeScript / extensão VS Code / harness Node | `extension-dev` |
| O que o usuário vê (decorações, painéis, widgets, textos) | `ui-dev` |
| Revisão de diff/PR nas duas stacks (só reporta, nunca corrige) | `code-reviewer` |
| Rodar/expandir testes, tooling de teste e debug | `qa-tester` |

Exceções que podem ser feitas direto: correções triviais (typo, uma linha),
edição de documentação, e leitura/investigação de código. Em caso de dúvida,
delegue.

## Autoridade em obstáculo recuperável

Ver [.claude/rules/authority.md](authority.md): agentes decidem e seguem em
obstáculos recuperáveis (porta ocupada, cache sujo, retry transitório), com
log claro da decisão — sem travar pedindo confirmação a cada obstáculo. Ação
destrutiva/irreversível continua exigindo o usuário sempre.

## Disciplina de verdade

- Afirmações em docs levam marcador: `[Verificado]` (testado de verdade),
  `[Hipótese]` (acreditamos, não testado), `[Decisão pendente]`.
- Nunca promova a `[Verificado]` sem execução real. Teste que envolve
  replicação Team Create exige **dois Studios reais** — escreva o roteiro e
  peça ao usuário; não simule e declare validado.
- Hipótese de plataforma nova = spike descartável em `spikes/` antes de
  código de produto.

## Manutenção de estado

- Ao fim de trabalho significativo: atualizar `docs/PROJECT_STATUS.md`.
- Decisão nova ou revertida: registrar em `docs/DECISIONS.md` com data e
  motivação. Decisões existentes não se contornam silenciosamente.
- Resultado de pesquisa vai para `.claude/research/`, nunca só no chat.
