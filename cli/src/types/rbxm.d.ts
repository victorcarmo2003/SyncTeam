// Declaração ambiente para o import `with { type: "file" }` do Bun (ver
// .claude/research/2026-08-03-bun-compile-embed-binary-file-rbxm.md).
// O import não devolve os bytes do arquivo, devolve uma STRING de path (real
// em dev, virtual `/$bunfs/...` dentro do binário compilado) — é isso que
// permite o `tsc --noEmit` type-checar `src/index.ts` mesmo antes de
// `bun run scripts/build-plugin-asset.ts` ter gerado o `.rbxm` de verdade em
// `src/assets/` (a declaração é uma correspondência de padrão de módulo, não
// exige o arquivo físico existir no disco para o compilador).
declare module "*.rbxm" {
  const path: string;
  export default path;
}
