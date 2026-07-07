// Servidor de eco para o teste de transporte do spike M0.
// Uso: npm install && node ws-echo-server.mjs
import { WebSocketServer } from "ws";

const PORT = 34901;
const server = new WebSocketServer({ host: "127.0.0.1", port: PORT });

server.on("listening", () => {
  console.log(`[ws-echo] ouvindo em ws://127.0.0.1:${PORT}`);
});

server.on("connection", (socket) => {
  console.log("[ws-echo] Studio conectou");
  socket.on("message", (data) => {
    console.log("[ws-echo] recebeu:", data.toString());
    socket.send(`eco: ${data.toString()}`);
  });
  socket.on("close", () => console.log("[ws-echo] conexão fechada"));
});
