-- SyncTeam — Constantes visuais do painel de status (M4.5)
--
-- Centraliza cor/espaçamento/fonte usados por StatusPanel.luau/Toast.luau/
-- PluginUI.luau — nenhum valor "mágico" solto nos componentes. Nenhuma das
-- cores abaixo veio de uma referência já validada (o RojoCoop só tinha UI do
-- lado da extensão VS Code, ver .claude/agent-memory/ui-dev.md); são
-- decisões de design desta tarefa, documentadas em detalhe na memória do
-- agente — mudar aqui muda o painel inteiro de uma vez.
--
-- Paleta pensada para conviver com os dois temas do Studio (claro/escuro):
-- como DockWidgetPluginGui não expõe um "tema atual" simples de observar por
-- Vide sem StudioService (fora de escopo desta fatia — decisão registrada em
-- .claude/agent-memory/ui-dev.md), o painel usa uma paleta ESCURA FIXA
-- (segue o mockup do usuário: "título no topo escuro"), igual nos dois temas
-- do Studio. Mesma decisão pragmática já aceita alhures no projeto quando o
-- 100% "correto" (StudioService:GetPropertyChangedSignal("Theme")) fica para
-- uma iteração futura.

local Theme = {}

Theme.Color = {
	-- Fundo geral do painel (main view e settings view).
	Background = Color3.fromRGB(30, 30, 34),
	-- Barra de título "SYNC TEAM" — mais escura que o fundo (mockup do
	-- usuário: "título no topo escuro").
	TitleBar = Color3.fromRGB(18, 18, 21),
	TitleText = Color3.fromRGB(235, 235, 240),

	-- Campo de porta (TextBox) e labels de suporte.
	FieldBackground = Color3.fromRGB(45, 45, 50),
	FieldText = Color3.fromRGB(220, 220, 225),
	FieldPlaceholder = Color3.fromRGB(130, 130, 138),
	LabelMuted = Color3.fromRGB(150, 150, 158),

	-- Botão CONNECT/DISCONNECT muda de cor conforme o estado da conexão (3
	-- estados, ver StatusPanel.ConnectRow / init.server.runConnection):
	-- azul = parado (ação: conectar), laranja = tentando/reconectando,
	-- vermelho = conectado (ação: desconectar).
	ConnectIdle = Color3.fromRGB(46, 111, 219), -- azul: "disconnected" parado, ação = "conectar"
	ConnectIdleHover = Color3.fromRGB(58, 125, 235),
	ConnectConnecting = Color3.fromRGB(224, 132, 32), -- laranja: "connecting"/reconectando em loop
	ConnectConnectingHover = Color3.fromRGB(238, 146, 46),
	ConnectActive = Color3.fromRGB(196, 60, 60), -- vermelho: "connected", ação = "desconectar"
	ConnectActiveHover = Color3.fromRGB(214, 74, 74),
	ButtonText = Color3.fromRGB(245, 245, 248),

	-- Engrenagem de configurações e botão de voltar.
	IconButton = Color3.fromRGB(60, 60, 66),
	IconButtonHover = Color3.fromRGB(75, 75, 82),

	-- Cabeçalho e linhas da tabela USER | INFO.
	TableHeaderText = Color3.fromRGB(140, 140, 148),
	RowBackgroundEven = Color3.fromRGB(36, 36, 41),
	RowBackgroundOdd = Color3.fromRGB(30, 30, 34),
	RowText = Color3.fromRGB(225, 225, 230),
	RowInfoText = Color3.fromRGB(165, 165, 172),
	-- Bolinha de líder — verde, convenção comum de "ativo/principal"; nenhuma
	-- outra cor no painel usa verde, sem ambiguidade.
	LeaderDot = Color3.fromRGB(70, 200, 120),

	-- Opções "em breve" nas configurações.
	DisabledText = Color3.fromRGB(100, 100, 108),

	-- Toast (M4.5, item 3 da tarefa) — fundo neutro escuro com faixa de
	-- destaque à esquerda; texto claro. Sem variação de cor por severidade
	-- nesta fatia (todo gatilho listado na tarefa é "erro/aviso genuíno";
	-- diferenciar info/warning/error fica para uma iteração futura se
	-- surgir um gatilho que precise).
	ToastBackground = Color3.fromRGB(50, 50, 56),
	ToastAccent = Color3.fromRGB(219, 156, 46), -- âmbar: "atenção", nem erro fatal nem sucesso
	ToastText = Color3.fromRGB(240, 240, 244),
	-- Botão de fechar (✕) do toast flutuante — discreto, acende no hover.
	ToastCloseIdle = Color3.fromRGB(150, 150, 158),
	ToastCloseHover = Color3.fromRGB(240, 240, 244),
}

Theme.Font = {
	Title = Enum.Font.GothamBold,
	Body = Enum.Font.Gotham,
	Bold = Enum.Font.GothamBold,
}

-- Espaçamentos/tamanhos usados em mais de um componente (evita repetir o
-- mesmo número mágico em StatusPanel/Toast/PluginUI). Layout exato em pixels
-- é decisão desta tarefa, não especificada pelo mockup — ver memória do
-- agente para o raciocínio completo.
Theme.Layout = {
	Padding = 10,
	TitleBarHeight = 36,
	RowHeight = 30,
	ButtonHeight = 34,
	IconButtonSize = 28,
	CornerRadius = UDim.new(0, 6),
}

return Theme
