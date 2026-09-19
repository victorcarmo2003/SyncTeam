// Um plugin de mentira, para a bancada.
//
// A extensao hospeda o WebSocket e o plugin do Studio conecta nela. Entao dá
// para ocupar o lugar do plugin: fazer o `hello`, responder o que o Studio
// responderia, e REGISTRAR tudo que a extensao emite. Assim cada gesto no
// disco vira uma lista de mensagens observada, sem Studio aberto e sem
// depender de alguem clicar nada.
//
// Isso cobre a direcao disco -> Studio inteira, que e onde mora a pergunta
// desta bancada (o que a extensao decide quando uma pasta some por move e o
// que ela decide quando some por unlink).
//
// Uso:  node plugin-falso.mjs <porta> <saida.jsonl> [estado.json] [comandos.jsonl]
//
// Com `comandos.jsonl` o plugin falso tambem EMITE: cada linha acrescentada
// ao arquivo e uma mensagem mandada para a extensao tal como esta. E assim
// que a bancada exercita o sentido Studio -> disco (sourceChanged,
// scriptAdded, scriptRemoved, scriptMoved) sem Studio aberto e sem ninguem
// digitando.
//
// Com `estado.json` o "Studio" LEMBRA os scripts entre execucoes, que e o que
// acontece de verdade quando o plugin cai e volta na mesma place. Sem ele,
// cada conexao e um Studio que esqueceu tudo — tambem um caso real (place
// recem-aberta, uuids realocados) e o suspeito numero um da duplicata.
// `ws` vem da extensao, que ja o tem. Instalar uma segunda copia so para a
// bancada arriscaria versao diferente da que o servidor usa.
import { createRequire } from "node:module";
const exigir = createRequire(import.meta.url);
const { WebSocket } = exigir("../../vscode-extension/node_modules/ws");
import fs from "node:fs";

const PROTOCOL_VERSION = 2;
const porta = Number(process.argv[2] ?? 1400);
const saida = process.argv[3] ?? "./observado.jsonl";

fs.writeFileSync(saida, "");
const registrar = (direcao, msg) => {
	fs.appendFileSync(
		saida,
		JSON.stringify({ t: Date.now(), direcao, kind: msg?.kind, msg }) + "\n",
	);
};

// O que o Studio "tem". A bancada comeca vazia de proposito: o que aparecer
// aqui foi a extensao que mandou criar, e e isso que se quer medir.
const arquivoEstado = process.argv[4] ?? null;
const arquivoComandos = process.argv[5] ?? null;
const scripts = new Map(); // uuid -> { path, className, source }
let proximoUuid = 1;

if (arquivoEstado && fs.existsSync(arquivoEstado)) {
	const guardado = JSON.parse(fs.readFileSync(arquivoEstado, "utf8"));
	for (const [uuid, s] of Object.entries(guardado.scripts ?? {})) scripts.set(uuid, s);
	proximoUuid = guardado.proximoUuid ?? 1;
	console.log(`[bancada] estado carregado: ${scripts.size} script(s)`);
}

const salvar = () => {
	if (!arquivoEstado) return;
	fs.writeFileSync(
		arquivoEstado,
		JSON.stringify({ scripts: Object.fromEntries(scripts), proximoUuid }, null, 2),
	);
};

const ws = new WebSocket(`ws://127.0.0.1:${porta}`);

ws.on("open", () => {
	const hello = {
		kind: "hello",
		protocolVersion: PROTOCOL_VERSION,
		role: "studio",
		placeName: "BancadaGestos",
		pluginVersion: "bancada-0.1",
		clientId: "bancada",
	};
	registrar("->", hello);
	ws.send(JSON.stringify(hello));
	console.log(`[bancada] conectado em ${porta}, fingindo ser o plugin`);
});

ws.on("message", (bruto) => {
	let msg;
	try {
		msg = JSON.parse(bruto.toString());
	} catch {
		registrar("<-", { kind: "(json invalido)", bruto: bruto.toString().slice(0, 200) });
		return;
	}
	registrar("<-", msg);

	// Responder o que o Studio responderia, senao a extensao fica esperando o
	// ack e para de mandar as proximas — e a bancada perderia os gestos
	// seguintes.
	const responder = (r) => {
		registrar("->", r);
		ws.send(JSON.stringify(r));
	};

	switch (msg.kind) {
		case "listScripts":
			responder({
				kind: "scriptList",
				requestId: msg.requestId,
				scripts: [...scripts.entries()].map(([uuid, s]) => ({
					uuid,
					path: s.path,
					className: s.className,
				})),
			});
			break;

		case "readSource": {
			const s = scripts.get(msg.uuid);
			responder({
				kind: "sourceContent",
				requestId: msg.requestId,
				uuid: msg.uuid,
				source: s ? s.source : "",
			});
			break;
		}

		case "writeSource": {
			// Criar traz path/className e espera um uuid novo; atualizar traz
			// o uuid que ja existe.
			let uuid = msg.uuid;
			if (!uuid) {
				// Sufixo aleatorio, nao so um contador. A extensao guarda o
				// mapeamento path->uuid entre sessoes do plugin, entao ela
				// repete uuids de execucoes anteriores; um contador que
				// reinicia em 1 colide com eles e uma entrada sobrescreve a
				// outra em silencio. Ja aconteceu: uma bateria inteira reportou
				// 2 scripts onde havia 4, e o cenario que dependia disso deu
				// resultado errado.
				uuid = `bancada-${proximoUuid++}-${Math.random().toString(36).slice(2, 8)}`;
				scripts.set(uuid, {
					path: msg.path ?? "(sem path)",
					className: msg.className ?? "ModuleScript",
					source: msg.source ?? "",
				});
			} else {
				const s = scripts.get(uuid);
				if (s) {
					s.source = msg.source ?? s.source;
				} else {
					// Update para um uuid que este "Studio" nao conhece. Acontece
					// quando a extensao guardou o mapeamento path->uuid de uma
					// sessao anterior e o plugin voltou sem ele. Descartar aqui
					// fazia a bancada mentir: o script existia do lado da
					// extensao e nunca aparecia no estado do plugin.
					scripts.set(uuid, {
						path: msg.path ?? "(sem path)",
						className: msg.className ?? "ModuleScript",
						source: msg.source ?? "",
					});
				}
			}
			salvar();
			responder({ kind: "writeAck", requestId: msg.requestId, uuid, ok: true });
			break;
		}

		case "deleteScript":
			scripts.delete(msg.uuid);
			salvar();
			responder({ kind: "writeAck", requestId: msg.requestId, uuid: msg.uuid, ok: true });
			break;

		case "ping":
			responder({ kind: "pong", requestId: msg.requestId });
			break;

		default:
			// Mensagem espontanea (leaseChanged, presenceChanged...) nao pede
			// resposta. Fica so no registro.
			break;
	}
});

// Le o arquivo de comandos por polling e manda cada linha nova. Polling, e
// nao watch, de proposito: o teste escreve com `>>` de shell e um watch de fs
// no Windows perde append pequeno com frequencia — aqui atraso de 200ms nao
// atrapalha e nao perder nenhuma linha importa.
if (arquivoComandos) {
	fs.writeFileSync(arquivoComandos, "");
	let lidas = 0;
	setInterval(() => {
		let linhas;
		try {
			const bruto = fs.readFileSync(arquivoComandos, "utf8");
			linhas = bruto.split(String.fromCharCode(10)).map((x) => x.trim()).filter(Boolean);
		} catch {
			return;
		}
		while (lidas < linhas.length) {
			const bruta = linhas[lidas++];
			let msg;
			try {
				msg = JSON.parse(bruta);
			} catch {
				console.error("[bancada] comando invalido:", bruta.slice(0, 120));
				continue;
			}
			// Mantem o "Studio" coerente com o que ele diz ter feito, senao o
			// listScripts da proxima conexao contradiz os eventos emitidos.
			if (msg.kind === "scriptAdded") {
				scripts.set(msg.uuid, { path: msg.path, className: msg.className, source: msg.source ?? "" });
			} else if (msg.kind === "sourceChanged") {
				const s = scripts.get(msg.uuid);
				if (s) s.source = msg.source ?? "";
			} else if (msg.kind === "scriptRemoved") {
				scripts.delete(msg.uuid);
			} else if (msg.kind === "scriptMoved") {
				const s = scripts.get(msg.uuid);
				if (s) s.path = msg.newPath;
			}
			salvar();
			// `source` viaja no scriptAdded so para a bancada preencher o
			// estado; o protocolo real nao tem esse campo ali.
			const { source, ...paraEnviar } = msg.kind === "scriptAdded" ? msg : { ...msg, source: undefined };
			const saida = msg.kind === "scriptAdded" ? paraEnviar : msg;
			registrar("->", saida);
			ws.send(JSON.stringify(saida));
		}
	}, 200);
}

ws.on("close", () => {
	console.log("[bancada] conexao fechada");
	process.exit(0);
});
ws.on("error", (e) => {
	console.error("[bancada] erro:", e.message);
	process.exit(1);
});

for (const sinal of ["SIGINT", "SIGTERM"]) {
	process.on(sinal, () => {
		try {
			ws.close();
		} catch {}
		process.exit(0);
	});
}
