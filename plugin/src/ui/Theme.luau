-- SyncTeam — Constantes visuais do painel de status (M4.5)
--
-- Centraliza cor/espaçamento/fonte usados por StatusPanel.luau/Toast.luau/
-- PluginUI.luau — nenhum valor "mágico" solto nos componentes.
--
-- 2026-08-02 (reskin "Modux Companion", 7ª rodada): paleta INTEIRA
-- substituída pela aprovada no mockup `design-preview/styles.css` (bloco
-- `:root` com variáveis `--mc-*`, ver `.claude/agent-memory/ui-dev.md` pro
-- raciocínio completo de cada decisão). Fonte de verdade PIXEL-A-PIXEL é o
-- CSS do mockup — os valores abaixo são a tradução literal de cada
-- `--mc-*` para `Color3`. Paleta continua ESCURA FIXA (não reage ao tema
-- claro/escuro do Studio — mesma decisão pragmática de sempre, ver histórico
-- na memória do agente).
--
-- Princípios do reskin (valem para TODOS os componentes que usam este
-- Theme, não repetir em cada arquivo):
--   1. Fundo ÚNICO (`Background`) em TODO o painel — sem blocos internos
--      mais claros/escuros (titlebar, linhas de tabela, campos: todos a
--      MESMA cor de fundo; a separação visual vem de bordas finas/linhas
--      divisórias, nunca de tons de cinza diferentes).
--   2. Sem cantos arredondados em NENHUM elemento (por isso não existe mais
--      `Theme.Layout.CornerRadius` — o token foi removido, não zerado;
--      nenhum componente deveria referenciá-lo).
--   3. Toda cor semântica (verde/amarelo/vermelho) vem em PAR: a versão
--      clara (`Green`/`Yellow`/`Red`) é SÓ para texto/indicador sobre o
--      fundo escuro; a `*Strong` é SÓ para fundo de botão (sempre com
--      `ButtonText` branco puro em cima) — nunca inverter os dois papéis.
--      `Blue`/`Purple` não têm par `*Strong` (o mockup também não usa em
--      nenhum botão) — mantidos só como tokens disponíveis para o futuro.
--   4. Bordas finas (`BorderSizePixel = 1`, `BorderColor3 = Theme.Color.Border`)
--      são o ÚNICO contorno visual admitido (campos tipo "porta"/"info box",
--      botões-ícone transparentes) — nunca uma UIStroke customizada nem
--      cantos arredondados fazendo esse papel.
local Theme = {}

Theme.Color = {
	-- Fundo ÚNICO do painel inteiro (titlebar, conteúdo, linhas de tabela,
	-- campos tipo "porta"/"info box") — --mc-bg. Era um tom mais escuro na
	-- titlebar (destacava como "card"); agora tudo a mesma cor (princípio 1).
	Background = Color3.fromRGB(23, 23, 23),

	-- Borda padrão única, usada em TODO contorno do painel (campos, chip de
	-- segundos, botões-ícone transparentes, fundo sólido de RESYNC-idle/
	-- toggle) — --mc-border.
	Border = Color3.fromRGB(84, 84, 84),
	-- Hover de elementos cuja cor de fundo É o próprio Border (RESYNC idle,
	-- toggles de Configurações) — aproximação de `filter: brightness(1.2)`
	-- do CSS (Roblox não tem filtro de brilho; computado como
	-- canal*1.2, arredondado, já que não há um valor fixo equivalente no
	-- mockup — mesma técnica já aceita no projeto para hovers antigos).
	BorderHover = Color3.fromRGB(101, 101, 101),

	-- Texto principal (títulos, botões coloridos ficam com ButtonText à
	-- parte) — --mc-text. Também usado como base de linhas divisórias
	-- (ver Theme.Layout.*Transparency abaixo — Color3 não tem canal alpha).
	Text = Color3.fromRGB(242, 242, 242),
	-- Texto secundário (labels "INFO:"/"Porta", texto de linha INFO da
	-- tabela, corpo do texto de campos somente-leitura) — --mc-subtext.
	SubText = Color3.fromRGB(199, 199, 199),
	-- Texto discreto (selo de segundos, cabeçalho da tabela, opções "em
	-- breve") — --mc-muted.
	Muted = Color3.fromRGB(154, 154, 154),

	-- Cores de status/severidade, SEMPRE em par (ver princípio 3 acima).
	Green = Color3.fromRGB(150, 220, 150), -- --mc-green: indicador de status "connected", bolinha de líder
	GreenStrong = Color3.fromRGB(34, 130, 74), -- --mc-green-strong: fundo do CONNECT "disconnected" (ação = conectar) e do RESYNC "done"/toast "sucesso"
	GreenStrongHover = Color3.fromRGB(39, 150, 85), -- aproximação de brightness(1.15), mesmo método de BorderHover
	Yellow = Color3.fromRGB(235, 200, 120), -- --mc-yellow: indicador de status "connecting"
	YellowStrong = Color3.fromRGB(163, 120, 20), -- --mc-yellow-strong: fundo do CONNECT "connecting" e do RESYNC "syncing"/toast "aviso"
	YellowStrongHover = Color3.fromRGB(187, 138, 23),
	Red = Color3.fromRGB(230, 120, 120), -- --mc-red: indicador de status "error" (reservado, não modelado nos 3 estados atuais de connectionStatus)
	RedStrong = Color3.fromRGB(189, 45, 45), -- --mc-red-strong: fundo do CONNECT "connected" (ação = desconectar) e do toast "erro"
	RedStrongHover = Color3.fromRGB(217, 52, 52),
	-- --mc-blue / --mc-purple: SEM par "Strong" (o próprio mockup já avisa)
	-- e não usados em nenhum botão desta fatia — mantidos como tokens
	-- disponíveis, mesma decisão do CSS de origem.
	Blue = Color3.fromRGB(130, 170, 230),
	-- ÚNICA exceção à nota acima, aberta em 2026-09-19 para o seletor
	-- Individual/Teams (StatusPanel.ModeRow): o trilho é fundo CHEIO com
	-- texto branco, então precisa de um par `*Strong` como todo botão
	-- colorido do painel (princípio 3) — `Blue` puro é claro demais para
	-- carregar `ButtonText` em cima. Sem origem no CSS do mockup (que nunca
	-- usou azul como fundo), então derivado para casar de PESO com os Strong
	-- que já existem: luminância perceptual (0.299R + 0.587G + 0.114B) de
	-- 86,5 contra 88 do RedStrong e 95 do GreenStrong — as duas metades do
	-- seletor ficam com o mesmo peso visual, que é o ponto.
	BlueStrong = Color3.fromRGB(40, 92, 180),
	Purple = Color3.fromRGB(124, 77, 200), -- --mc-purple: fundo do RESYNC "idle" (2026-08-02 — era Border/cinza)
	PurpleHover = Color3.fromRGB(143, 89, 230), -- aproximação de brightness(1.15), mesma técnica de BorderHover/GreenStrongHover

	-- Regra nova (substitui a distinção antiga "idle discreto"): TODO botão
	-- colorido (fundo `*Strong` ou `Border`) usa texto branco PURO — nunca
	-- Theme.Color.Text (242,242,242), que é "quase branco" mas não put branco.
	ButtonText = Color3.fromRGB(255, 255, 255),
	-- ÚNICA exceção à regra acima: faixa "info"/genérica do Toast (fundo
	-- SubText claro + texto PRETO) — briefing explícito, ver Toast.luau.
	ToastInfoText = Color3.fromRGB(0, 0, 0),
}

Theme.Font = {
	-- Fonte "arredondada e amigável, mas sóbria" — confirmado por pesquisa
	-- que `Enum.Font.Nunito` EXISTE no enum atual do Roblox antes de
	-- depender dela (ver `.claude/research/2026-08-02-font-enum-fontface-
	-- fontweight-nunito.md`, regra do projeto para API de Font nova).
	-- Usada em TUDO no painel, exceto o campo técnico da porta (Mono).
	Rounded = Enum.Font.Nunito,
	-- Campo técnico (porta) — único lugar que foge da fonte arredondada
	-- (briefing: "campos técnicos: porta, endereço"). `Enum.Font.Code` já é
	-- usado no projeto há tempo (não é API nova, não precisa de confirmação
	-- de pesquisa) e é o mais próximo de "Cascadia Code" do mockup.
	Mono = Enum.Font.Code,
}

-- `Enum.Font.Nunito` não tem uma variante "*Bold" própria no enum (ao
-- contrário de `Gotham`/`GothamBold`) — pra negrito de verdade é preciso
-- `FontFace`/`Font.new` com `Enum.FontWeight.Bold`. Técnica CONFIRMADA por
-- pesquisa antes de codar (ver arquivo de pesquisa citado acima):
--   - NUNCA mutar `instance.FontFace.Weight` diretamente — `Font` é um
--     value type, a leitura devolve CÓPIA; mutar um campo da cópia não
--     reflete de volta na Instance (confirmado por 2 relatos de DevForum
--     independentes na pesquisa).
--   - Sempre montar um `Font` NOVO (`Font.new(family, weight, style)`) e
--     reatribuir o objeto INTEIRO de volta a `.FontFace`.
--   - Chamar SEMPRE depois que `.Font` (enum) já foi setado na Instance —
--     a engine mantém `.Font`/`.FontFace` sincronizados nos dois sentidos
--     (doc oficial: "kept in sync with"), então setar `.Font` DEPOIS
--     reconstruiria o `FontFace` a partir do enum (peso Regular),
--     desfazendo o override. `vide.create` já aplica todas as props
--     (inclusive `.Font`) antes de devolver a Instance, então chamar
--     `Theme.applyBold(instance)` logo após `vide.create "TextLabel" {...}`
--     retornar é sempre seguro.
function Theme.applyBold(instance)
	local face = instance.FontFace
	instance.FontFace = Font.new(face.Family, Enum.FontWeight.Bold, face.Style)
end

-- Espaçamentos/tamanhos usados em mais de um componente (evita repetir o
-- mesmo número mágico em StatusPanel/Toast/PluginUI). Layout exato em pixels
-- é decisão desta tarefa quando não especificado 1:1 pelo mockup — ver
-- memória do agente para o raciocínio completo.
Theme.Layout = {
	Padding = 12, -- mockup: .st-content/.st-settings-body { padding: 12px } (era 10)
	TitleBarHeight = 36,
	RowHeight = 30,
	ButtonHeight = 34,
	IconButtonSize = 28,
	-- SEM corner-radius: nenhum elemento do painel usa cantos arredondados
	-- no reskin (princípio 2 acima) — o token foi REMOVIDO de propósito
	-- (não zerado), nenhum componente deveria mais referenciá-lo.

	-- Transparências equivalentes às linhas/overlays `rgba(242,242,242,X)`
	-- do CSS — `Color3` do Roblox não tem canal alpha; o efeito é
	-- `BackgroundTransparency` numa Instance com `BackgroundColor3 = Theme.Color.Text`.
	DividerTransparency = 0.88, -- linha entre título e conteúdo (rgba(...,0.12))
	RowDividerTransparency = 0.92, -- linha entre linhas da tabela de sessões (rgba(...,0.08))
	HoverOverlayTransparency = 0.92, -- hover de botão-ícone transparente (rgba(...,0.08)) — MESMO valor de RowDividerTransparency por coincidência do CSS, não por relação semântica (nomes separados de propósito)
}

return Theme
