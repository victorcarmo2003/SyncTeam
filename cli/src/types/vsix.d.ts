// Declaração ambiente para o import `with { type: "file" }` do Bun, mesmo
// padrão de `rbxm.d.ts` (ver ali para o porquê) — permite `tsc --noEmit`
// passar mesmo sem `src/assets/syncteam.vsix` gerado ainda (declaração de
// módulo por padrão de nome, não exige o arquivo físico no disco).
declare module "*.vsix" {
  const path: string;
  export default path;
}
