import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Tres arquivos pegam porta de verdade (syncServer, portOwnership,
    // syncTeamService) e o padrao do vitest e rodar ARQUIVOS em paralelo.
    // `getFreePort` pede uma efemera ao SO, FECHA, e so depois o teste liga
    // nela — entre fechar e ligar, outro arquivo pega a mesma porta.
    //
    // Nesta maquina a faixa efemera comeca em 1024 (`netsh int ipv4 show
    // dynamicport tcp`), entao o sorteio cai em qualquer lugar, inclusive em
    // cima de porta de servico. Medido: 1 falha em 14 execucoes, sempre em
    // teste de porta, com EADDRINUSE, EACCES e ECONNREFUSED alternando.
    //
    // Serializar os arquivos remove a disputa. Custa alguns segundos e vale:
    // falha intermitente em suite ensina a ignorar vermelho.
    fileParallelism: false,
  },
});
