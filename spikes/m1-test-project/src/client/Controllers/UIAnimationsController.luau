local CollectionService = game:GetService("CollectionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Modux = require(ReplicatedStorage.Shared.Modux)
local Spring = require(ReplicatedStorage.Packages.spring) :: any

local DEFAULT_DAMPING = 0.82
local DEFAULT_FREQUENCY = 6
local DEFAULT_EPSILON = 0.001
local OPEN_SCALE_START = 0.88
local OPEN_SCALE_END = 1
local CLOSE_SCALE_END = 0.88
local PRESS_SCALE = 0.94
local PULSE_SCALE = 1.08
local HOVER_SCALE = 1.06

local HOVER_SCALE_TAG = "UI.HoverScale"
local HOVER_FADE_TAG = "UI.HoverFade"
local PRESS_TAG = "UI.Press"
local POP_TAG = "UI.Pop"
local COLLAPSE_TAG = "UI.Collapse"
local PULSE_TAG = "UI.Pulse"

type SpringOptions = {
	TargetInstance: Instance?,
	From: any?,
	To: any?,
	Damping: number?,
	Frequency: number?,
	Epsilon: number?,
	Clock: ("RenderStepped" | "Heartbeat")?,
	Step: ((value: any, alpha: number, animation: any) -> ())?,
	Done: (() -> ())?,
	Reset: (() -> ())?,
}

type AnimationHandle<T> = {
	Completed: RBXScriptSignal,
	IsPlaying: (self: AnimationHandle<T>) -> boolean,
	Get: (self: AnimationHandle<T>) -> (T, T),
	GetCurrentPos: (self: AnimationHandle<T>) -> T,
	Set: (self: AnimationHandle<T>, value: T) -> AnimationHandle<T>,
	SetTarget: (self: AnimationHandle<T>, nextTarget: T) -> AnimationHandle<T>,
	SetConfig: (self: AnimationHandle<T>, nextDamping: number?, nextFrequency: number?) -> AnimationHandle<T>,
	Play: (self: AnimationHandle<T>, nextTarget: T?, nextFrom: T?) -> AnimationHandle<T>,
	Stop: (self: AnimationHandle<T>, finish: boolean?) -> AnimationHandle<T>,
	Reset: (self: AnimationHandle<T>) -> AnimationHandle<T>,
	Destroy: (self: AnimationHandle<T>) -> AnimationHandle<T>,
}

type GroupAnimationHandle = {
	Completed: RBXScriptSignal,
	Play: (self: GroupAnimationHandle) -> GroupAnimationHandle,
	Stop: (self: GroupAnimationHandle, finish: boolean?) -> GroupAnimationHandle,
	Reset: (self: GroupAnimationHandle) -> GroupAnimationHandle,
	GetCurrentPos: (self: GroupAnimationHandle) -> { any },
	Destroy: (self: GroupAnimationHandle) -> GroupAnimationHandle,
}

type SequenceAnimationHandle = {
	Completed: RBXScriptSignal,
	Play: (self: SequenceAnimationHandle) -> SequenceAnimationHandle,
	Next: (self: SequenceAnimationHandle) -> SequenceAnimationHandle,
	Stop: (self: SequenceAnimationHandle, finish: boolean?) -> SequenceAnimationHandle,
	Reset: (self: SequenceAnimationHandle) -> SequenceAnimationHandle,
	GetCurrentPos: (self: SequenceAnimationHandle) -> any,
	Destroy: (self: SequenceAnimationHandle) -> SequenceAnimationHandle,
}

local UIAnimationsController = Modux.Controller("UIAnimationsController")

UIAnimationsController.ActiveConnections = {} :: { [GuiObject]: RBXScriptConnection }
UIAnimationsController.ActiveAnimations = {} :: { [Instance]: { [any]: boolean } }
UIAnimationsController.TaggedTasks = {} :: { [Instance]: { [string]: { any } } }

-- Retorna uma velocidade inicial compativel com o tipo animado.
local function zeroVelocity(value: any): any
	if typeof(value) == "Vector3" then
		return Vector3.zero
	end

	return 0
end

-- Converte valores animados em uma magnitude numerica para medir convergencia.
local function magnitude(value: any): number
	if typeof(value) == "number" then
		return math.abs(value)
	end

	if typeof(value) == "Vector3" then
		return value.Magnitude
	end

	return 0
end

-- Calcula o progresso normalizado da animacao entre o valor inicial e final.
local function alphaFrom(fromValue: any, toValue: any, value: any, epsilon: number): number
	if typeof(fromValue) ~= "number" or typeof(toValue) ~= "number" or typeof(value) ~= "number" then
		return 1
	end

	local span = toValue - fromValue
	if math.abs(span) <= epsilon then
		return 1
	end

	return math.clamp((value - fromValue) / span, 0, 1)
end

-- Desconecta uma conexao do Roblox quando ela existe.
local function disconnect(connection: RBXScriptConnection?)
	if connection then
		connection:Disconnect()
	end
end

-- Executa a limpeza de tarefas guardadas por tags, aceitando conexoes, funcoes e handles.
local function cleanupTask(task: any)
	if typeof(task) == "RBXScriptConnection" then
		task:Disconnect()
	elseif typeof(task) == "function" then
		task()
	elseif typeof(task) == "table" then
		if typeof(task.Destroy) == "function" then
			task:Destroy()
		elseif typeof(task.Disconnect) == "function" then
			task:Disconnect()
		end
	end
end

-- Le um atributo numerico da instancia ou usa o valor padrao.
local function getNumberAttribute(instance: Instance, attributeName: string, fallback: number): number
	local value = instance:GetAttribute(attributeName)
	if typeof(value) == "number" then
		return value
	end

	return fallback
end

-- Le qual clock de atualizacao a animacao marcada deve usar.
local function getClockAttribute(instance: Instance): "RenderStepped" | "Heartbeat" | nil
	local value = instance:GetAttribute("Clock")
	if value == "RenderStepped" or value == "Heartbeat" then
		return value
	end

	return nil
end

-- Monta as opcoes de spring a partir dos atributos configurados na UI.
local function getTaggedSpringOptions(instance: Instance): SpringOptions
	return {
		Damping = getNumberAttribute(instance, "Damping", DEFAULT_DAMPING),
		Frequency = getNumberAttribute(instance, "Frequency", DEFAULT_FREQUENCY),
		Epsilon = getNumberAttribute(instance, "Epsilon", DEFAULT_EPSILON),
		Clock = getClockAttribute(instance),
	}
end

-- Valida se a instancia marcada por tag pode receber animacoes de UI.
local function getTaggedGuiObject(instance: Instance, tag: string): GuiObject?
	if not instance:IsA("GuiObject") then
		warn(`[UIAnimationsController] "{instance:GetFullName()}" usa {tag}, mas nao e GuiObject.`)
		return nil
	end

	return instance :: GuiObject
end

-- Aplica transparencia no tipo de GuiObject correto, incluindo CanvasGroup.
local function setTransparency(target: GuiObject, value: number)
	if target:IsA("CanvasGroup") then
		(target :: CanvasGroup).GroupTransparency = value
		return
	end

	if target:IsA("TextLabel") or target:IsA("TextButton") or target:IsA("TextBox") then
		(target :: TextLabel).TextTransparency = value
	end

	if target:IsA("ImageLabel") or target:IsA("ImageButton") then
		(target :: ImageLabel).ImageTransparency = value
	end

	target.BackgroundTransparency = value
end

-- Busca a transparencia atual usando a propriedade visual mais adequada ao alvo.
local function getTransparency(target: GuiObject): number
	if target:IsA("CanvasGroup") then
		return (target :: CanvasGroup).GroupTransparency
	end

	if target:IsA("TextLabel") or target:IsA("TextButton") or target:IsA("TextBox") then
		return (target :: TextLabel).TextTransparency
	end

	if target:IsA("ImageLabel") or target:IsA("ImageButton") then
		return (target :: ImageLabel).ImageTransparency
	end

	return target.BackgroundTransparency
end

-- Garante que o GuiObject tenha um UIScale para animacoes de escala.
UIAnimationsController.EnsureScale = function(self, window: GuiObject): UIScale
	local scale = window:FindFirstChildOfClass("UIScale")
	if not scale then
		scale = Instance.new("UIScale")
		scale.Scale = 1
		scale.Parent = window
	end

	return scale :: UIScale
end

-- Procura um CanvasGroup para animar transparencia em grupo quando disponivel.
UIAnimationsController.FindCanvas = function(self, window: GuiObject): CanvasGroup?
	if window:IsA("CanvasGroup") then
		return window :: CanvasGroup
	end

	return window:FindFirstChildOfClass("CanvasGroup")
end

-- Registra uma animacao ativa para permitir parada ou limpeza por instancia.
UIAnimationsController.RegisterAnimation = function(self, target: Instance?, animation)
	if not target then
		return
	end

	if not self.ActiveAnimations[target] then
		self.ActiveAnimations[target] = {}
	end

	self.ActiveAnimations[target][animation] = true
end

-- Remove uma animacao do registro de animacoes ativas.
UIAnimationsController.UnregisterAnimation = function(self, target: Instance?, animation)
	if not target then
		return
	end

	local animations = self.ActiveAnimations[target]
	if not animations then
		return
	end

	animations[animation] = nil
	if next(animations) == nil then
		self.ActiveAnimations[target] = nil
	end
end

-- Para todas as animacoes ligadas a uma instancia.
UIAnimationsController.Stop = function(self, target: Instance)
	local animations = self.ActiveAnimations[target]
	if animations then
		local list = {}
		for animation in animations do
			table.insert(list, animation)
		end

		for _, animation in list do
			animation:Stop()
		end
	end

	local legacyConnection = self.ActiveConnections[target]
	if legacyConnection then
		legacyConnection:Disconnect()
		self.ActiveConnections[target] = nil
	end
end

-- Verifica se uma tag ja teve seus eventos e animacoes vinculados.
UIAnimationsController.IsTaggedBound = function(self, instance: Instance, tag: string): boolean
	local tagTasks = self.TaggedTasks[instance]
	return tagTasks ~= nil and tagTasks[tag] ~= nil
end

-- Guarda as tarefas criadas por uma tag para limpar depois.
UIAnimationsController.TrackTaggedTasks = function(self, instance: Instance, tag: string, tasks: { any })
	if not self.TaggedTasks[instance] then
		self.TaggedTasks[instance] = {}
	end

	self.TaggedTasks[instance][tag] = tasks
end

-- Remove eventos, animacoes e callbacks associados a uma tag especifica.
UIAnimationsController.UnbindTag = function(self, instance: Instance, tag: string)
	local tagTasks = self.TaggedTasks[instance]
	if not tagTasks then
		return
	end

	local tasks = tagTasks[tag]
	if not tasks then
		return
	end

	tagTasks[tag] = nil
	for _, task in tasks do
		cleanupTask(task)
	end

	if next(tagTasks) == nil then
		self.TaggedTasks[instance] = nil
	end
end

-- Remove todos os vinculos de tags de uma instancia.
UIAnimationsController.UnbindAllTags = function(self, instance: Instance)
	local tagTasks = self.TaggedTasks[instance]
	if not tagTasks then
		return
	end

	local tags = {}
	for tag in tagTasks do
		table.insert(tags, tag)
	end

	for _, tag in tags do
		self:UnbindTag(instance, tag)
	end
end

-- Vincula um comportamento de animacao a todas as instancias com uma tag.
UIAnimationsController.BindTaggedPreset = function(self, tag: string, binder: (self: any, instance: Instance) -> ())
	for _, instance in CollectionService:GetTagged(tag) do
		binder(self, instance)
	end

	local addedConnection = CollectionService:GetInstanceAddedSignal(tag):Connect(function(instance)
		binder(self, instance)
	end)
	self:Cleanup(addedConnection)

	local removedConnection = CollectionService:GetInstanceRemovedSignal(tag):Connect(function(instance)
		self:UnbindTag(instance, tag)
	end)
	self:Cleanup(removedConnection)
end

-- Cria o handle base de animacao usando spring, com Play, Stop, Completed e Destroy.
UIAnimationsController.CreateSpring = function(self, options: SpringOptions): AnimationHandle<any>
	local controller = self
	local targetInstance = options.TargetInstance
	local fromValue = if options.From ~= nil then options.From else 0
	local toValue = if options.To ~= nil then options.To else fromValue
	local damping = options.Damping or DEFAULT_DAMPING
	local frequency = options.Frequency or DEFAULT_FREQUENCY
	local epsilon = options.Epsilon or DEFAULT_EPSILON
	local clock = options.Clock or "RenderStepped"
	local step = options.Step
	local done = options.Done
	local reset = options.Reset

	local spring = Spring.new(fromValue)
	spring.Damping = damping
	spring.Frequency = frequency
	spring:SetTarget(toValue)

	local completedEvent = Instance.new("BindableEvent")
	local handle = {
		Completed = completedEvent.Event,
	}
	local connection: RBXScriptConnection? = nil
	local playing = false
	local destroyed = false

	-- Executa o callback visual da animacao para o valor atual.
	local function apply(value: any, alpha: number)
		if step then
			step(value, alpha, handle)
		end
	end

	-- Interrompe o loop de atualizacao e desregistra a animacao.
	local function stopConnection()
		disconnect(connection)
		connection = nil
		playing = false
		controller:UnregisterAnimation(targetInstance, handle)
	end

	-- Informa se a animacao esta rodando no momento.
	function handle:IsPlaying(): boolean
		return playing
	end

	-- Retorna a posicao e velocidade atuais do spring.
	function handle:Get(): (any, any)
		return spring.Position, spring.Velocity
	end

	-- Retorna somente a posicao atual, parecido com ler o valor atual de um tween.
	function handle:GetCurrentPos(): any
		return spring.Position
	end

	-- Define imediatamente o valor atual da animacao.
	function handle:Set(value: any)
		fromValue = value
		spring.Position = value
		spring.Velocity = zeroVelocity(value)
		apply(value, alphaFrom(fromValue, toValue, value, epsilon))
		return self
	end

	-- Atualiza o alvo para onde o spring deve convergir.
	function handle:SetTarget(nextTarget: any)
		toValue = nextTarget
		spring:SetTarget(nextTarget)
		return self
	end

	-- Altera amortecimento e frequencia do spring.
	function handle:SetConfig(nextDamping: number?, nextFrequency: number?)
		if nextDamping then
			damping = nextDamping
			spring.Damping = nextDamping
		end

		if nextFrequency then
			frequency = nextFrequency
			spring.Frequency = nextFrequency
		end

		return self
	end

	-- Inicia ou reinicia a animacao ate o alvo definido.
	function handle:Play(nextTarget: any?, nextFrom: any?)
		if destroyed then
			return self
		end

		stopConnection()

		if nextFrom ~= nil then
			fromValue = nextFrom
			spring.Position = nextFrom
			spring.Velocity = zeroVelocity(nextFrom)
			apply(nextFrom, 0)
		else
			fromValue = spring.Position
		end

		if nextTarget ~= nil then
			toValue = nextTarget
		end

		spring.Damping = damping
		spring.Frequency = frequency
		spring:SetTarget(toValue)
		playing = true
		controller:RegisterAnimation(targetInstance, handle)

		local signal = if clock == "Heartbeat" then RunService.Heartbeat else RunService.RenderStepped
		connection = signal:Connect(function(deltaTime)
			spring:Update(deltaTime)

			local value = spring.Position
			local alpha = alphaFrom(fromValue, toValue, value, epsilon)
			apply(value, alpha)

			local distance = magnitude(value - toValue)
			local velocity = magnitude(spring.Velocity)
			if distance <= epsilon and velocity <= epsilon then
				stopConnection()
				spring.Position = toValue
				spring.Velocity = zeroVelocity(toValue)
				apply(toValue, 1)

				if done then
					done()
				end

				completedEvent:Fire(Enum.PlaybackState.Completed)
			end
		end)

		controller:Cleanup(connection :: RBXScriptConnection)
		return self
	end

	-- Para a animacao, podendo finalizar direto no valor alvo.
	function handle:Stop(finish: boolean?)
		local wasPlaying = playing
		stopConnection()
		if finish then
			spring.Position = toValue
			spring.Velocity = zeroVelocity(toValue)
			apply(toValue, 1)
		end

		if wasPlaying then
			completedEvent:Fire(if finish then Enum.PlaybackState.Completed else Enum.PlaybackState.Cancelled)
		end

		return self
	end

	-- Volta a animacao para o valor inicial e chama o reset customizado.
	function handle:Reset()
		stopConnection()
		spring.Position = fromValue
		spring.Velocity = zeroVelocity(fromValue)
		spring:SetTarget(fromValue)
		apply(fromValue, 0)

		if reset then
			reset()
		end

		return self
	end

	-- Encerra o handle e impede novos Plays.
	function handle:Destroy()
		destroyed = true
		stopConnection()
		completedEvent:Destroy()
		return self
	end

	return handle
end

-- Agrupa animacoes para controlar todas ao mesmo tempo.
UIAnimationsController.Group = function(self, animations: { any }): GroupAnimationHandle
	local completedEvent = Instance.new("BindableEvent")
	local completedConnections = {}
	local handle = {
		Completed = completedEvent.Event,
	}

	local function disconnectCompleted()
		for _, connection in completedConnections do
			disconnect(connection)
		end

		table.clear(completedConnections)
	end

	-- Inicia todas as animacoes do grupo.
	function handle:Play()
		disconnectCompleted()
		local completedCount = 0

		for _, animation in animations do
			if animation.Completed then
				local completedConnection = animation.Completed:Connect(function()
					completedCount += 1
					if completedCount >= #animations then
						disconnectCompleted()
						completedEvent:Fire(Enum.PlaybackState.Completed)
					end
				end)
				table.insert(completedConnections, completedConnection)
			end
		end

		for _, animation in animations do
			animation:Play()
		end
		return self
	end

	-- Para todas as animacoes do grupo.
	function handle:Stop(finish: boolean?)
		disconnectCompleted()
		for _, animation in animations do
			animation:Stop(finish)
		end

		completedEvent:Fire(if finish then Enum.PlaybackState.Completed else Enum.PlaybackState.Cancelled)
		return self
	end

	-- Reseta todas as animacoes do grupo.
	function handle:Reset()
		for _, animation in animations do
			animation:Reset()
		end
		return self
	end

	-- Retorna as posicoes atuais de todas as animacoes do grupo.
	function handle:GetCurrentPos(): { any }
		local positions = {}
		for _, animation in animations do
			table.insert(positions, if animation.GetCurrentPos then animation:GetCurrentPos() else animation:Get())
		end

		return positions
	end

	-- Destroi ou para todas as animacoes do grupo.
	function handle:Destroy()
		disconnectCompleted()
		for _, animation in animations do
			if animation.Destroy then
				animation:Destroy()
			else
				animation:Stop()
			end
		end
		completedEvent:Destroy()
		return self
	end

	return handle
end

-- Controla animacoes em sequencia, avancando uma de cada vez.
UIAnimationsController.Sequence = function(self, animations: { any }): SequenceAnimationHandle
	local completedEvent = Instance.new("BindableEvent")
	local handle = {
		Completed = completedEvent.Event,
	}
	local currentIndex = 1
	local playing = false

	-- Inicia a sequencia pela primeira animacao.
	function handle:Play()
		currentIndex = 1
		playing = true
		local animation = animations[currentIndex]
		if animation then
			animation:Play()
		else
			playing = false
			completedEvent:Fire(Enum.PlaybackState.Completed)
		end

		return self
	end

	-- Avanca para a proxima animacao da sequencia.
	function handle:Next()
		currentIndex += 1
		local animation = animations[currentIndex]
		if animation then
			animation:Play()
		else
			playing = false
			completedEvent:Fire(Enum.PlaybackState.Completed)
		end

		return self
	end

	-- Para todas as animacoes da sequencia.
	function handle:Stop(finish: boolean?)
		local wasPlaying = playing
		playing = false
		for _, animation in animations do
			animation:Stop(finish)
		end

		if wasPlaying then
			completedEvent:Fire(if finish then Enum.PlaybackState.Completed else Enum.PlaybackState.Cancelled)
		end

		return self
	end

	-- Reinicia a sequencia e reseta todas as animacoes.
	function handle:Reset()
		currentIndex = 1
		playing = false
		for _, animation in animations do
			animation:Reset()
		end

		return self
	end

	-- Retorna a posicao atual da animacao ativa na sequencia.
	function handle:GetCurrentPos(): any
		local animation = animations[currentIndex]
		if not animation then
			return nil
		end

		return if animation.GetCurrentPos then animation:GetCurrentPos() else animation:Get()
	end

	-- Destroi ou para todas as animacoes da sequencia.
	function handle:Destroy()
		playing = false
		for _, animation in animations do
			if animation.Destroy then
				animation:Destroy()
			else
				animation:Stop()
			end
		end

		completedEvent:Destroy()
		return self
	end

	return handle
end

-- ======================= BUILT-IN ANIMATIONS ===========================
-- Anima o UIScale de uma janela ate a escala desejada.
UIAnimationsController.Scale = function(
	self,
	window: GuiObject,
	toScale: number,
	options: SpringOptions?
): AnimationHandle<number>
	options = options or {}
	if not options then
		return {} :: AnimationHandle<number>
	end
	local scale = self:EnsureScale(window)
	local fromScale = if options.From ~= nil then options.From else scale.Scale
	local userStep = options.Step

	return self:CreateSpring({
		TargetInstance = options.TargetInstance or window,
		From = fromScale,
		To = toScale,
		Damping = options.Damping,
		Frequency = options.Frequency,
		Epsilon = options.Epsilon,
		Clock = options.Clock,
		Done = options.Done,
		Reset = options.Reset,
		Step = function(value, alpha, animation)
			scale.Scale = value
			if userStep then
				userStep(value, alpha, animation)
			end
		end,
	})
end

-- Anima transparencia de um GuiObject ou CanvasGroup.
UIAnimationsController.Fade = function(
	self,
	target: GuiObject,
	toTransparency: number,
	options: SpringOptions?
): AnimationHandle<number>
	options = options or {}
	if not options then
		return {} :: AnimationHandle<number>
	end
	local fadeTarget = self:FindCanvas(target) or target
	local fromTransparency = if options.From ~= nil then options.From else getTransparency(fadeTarget)
	local userStep = options.Step

	return self:CreateSpring({
		TargetInstance = options.TargetInstance or target,
		From = fromTransparency,
		To = toTransparency,
		Damping = options.Damping,
		Frequency = options.Frequency,
		Epsilon = options.Epsilon,
		Clock = options.Clock,
		Done = options.Done,
		Reset = options.Reset,
		Step = function(value, alpha, animation)
			setTransparency(fadeTarget, value)
			if userStep then
				userStep(value, alpha, animation)
			end
		end,
	})
end

-- Interpola a posicao de uma janela ate o destino informado.
UIAnimationsController.Slide = function(
	self,
	window: GuiObject,
	toPosition: UDim2,
	options: SpringOptions?
): AnimationHandle<number>
	options = options or {}
	if not options then
		return {} :: AnimationHandle<number>
	end
	local fromPosition = options.From or window.Position
	local userStep = options.Step

	return self:CreateSpring({
		TargetInstance = options.TargetInstance or window,
		From = 0,
		To = 1,
		Damping = options.Damping,
		Frequency = options.Frequency,
		Epsilon = options.Epsilon,
		Clock = options.Clock,
		Done = options.Done,
		Reset = function()
			window.Position = fromPosition
			if options.Reset then
				options.Reset()
			end
		end,
		Step = function(value, alpha, animation)
			window.Position = fromPosition:Lerp(toPosition, value)
			if userStep then
				userStep(value, alpha, animation)
			end
		end,
	})
end

-- Anima o preenchimento horizontal de uma barra usando um ratio de 0 a 1.
UIAnimationsController.Bar = function(
	self,
	fill: GuiObject,
	ratio: number,
	options: SpringOptions?
): AnimationHandle<number>
	options = options or {}
	if not options then
		return {} :: AnimationHandle<number>
	end
	local currentSize = fill.Size
	local fromRatio = if options.From ~= nil then options.From else currentSize.X.Scale
	local toRatio = math.clamp(ratio, 0, 1)
	local userStep = options.Step

	return self:CreateSpring({
		TargetInstance = options.TargetInstance or fill,
		From = fromRatio,
		To = toRatio,
		Damping = options.Damping,
		Frequency = options.Frequency,
		Epsilon = options.Epsilon,
		Clock = options.Clock,
		Done = options.Done,
		Reset = options.Reset,
		Step = function(value, alpha, animation)
			fill.Size =
				UDim2.new(math.clamp(value, 0, 1), currentSize.X.Offset, currentSize.Y.Scale, currentSize.Y.Offset)
			if userStep then
				userStep(value, alpha, animation)
			end
		end,
	})
end

-- Mostra uma janela com escala de entrada e fade opcional de CanvasGroup.
UIAnimationsController.Pop = function(self, window: GuiObject, options: SpringOptions?): AnimationHandle<number>
	options = options or {}
	if not options then
		return {} :: AnimationHandle<number>
	end
	window.Visible = true

	local canvas = self:FindCanvas(window)
	if canvas then
		canvas.GroupTransparency = 1
	end

	return self:Scale(window, OPEN_SCALE_END, {
		From = options.From or OPEN_SCALE_START,
		Damping = options.Damping,
		Frequency = options.Frequency,
		Epsilon = options.Epsilon,
		Clock = options.Clock,
		Done = options.Done,
		Step = function(value, alpha, animation)
			if canvas then
				canvas.GroupTransparency = 1 - alpha
			end

			if options.Step then
				options.Step(value, alpha, animation)
			end
		end,
	})
end

-- Esconde uma janela reduzindo escala e restaurando o estado visual ao terminar.
UIAnimationsController.Collapse = function(self, window: GuiObject, options: SpringOptions?): AnimationHandle<number>
	options = options or {}
	if not options then
		return {} :: AnimationHandle<number>
	end
	local canvas = self:FindCanvas(window)
	local scale = self:EnsureScale(window)

	return self:Scale(window, options.To or CLOSE_SCALE_END, {
		From = options.From or scale.Scale,
		Damping = options.Damping,
		Frequency = options.Frequency,
		Epsilon = options.Epsilon,
		Clock = options.Clock,
		Step = function(value, alpha, animation)
			if canvas then
				canvas.GroupTransparency = alpha
			end

			if options.Step then
				options.Step(value, alpha, animation)
			end
		end,
		Done = function()
			window.Visible = false
			scale.Scale = 1

			if canvas then
				canvas.GroupTransparency = 0
			end

			if options.Done then
				options.Done()
			end
		end,
	})
end

-- Executa o efeito de apertar e voltar para a escala base.
UIAnimationsController.Press = function(self, window: GuiObject, options: SpringOptions?): SequenceAnimationHandle
	options = options or {}
	if not options then
		return {} :: SequenceAnimationHandle
	end
	local baseScale = if options.From ~= nil then options.From else self:EnsureScale(window).Scale
	local downScale = options.To or PRESS_SCALE
	local upAnimation
	local downAnimation
	local sequence

	upAnimation = self:Scale(window, baseScale, {
		Damping = options.Damping,
		Frequency = options.Frequency,
		Epsilon = options.Epsilon,
		Clock = options.Clock,
		Done = function()
			if options.Done then
				options.Done()
			end

			sequence:Next()
		end,
	})

	downAnimation = self:Scale(window, downScale, {
		From = baseScale,
		Damping = options.Damping,
		Frequency = options.Frequency,
		Epsilon = options.Epsilon,
		Clock = options.Clock,
		Done = function()
			sequence:Next()
		end,
	})

	sequence = self:Sequence({ downAnimation, upAnimation })

	return sequence
end

-- Executa um pulso de escala e retorna para a escala base.
UIAnimationsController.Pulse = function(self, window: GuiObject, options: SpringOptions?): SequenceAnimationHandle
	options = options or {}
	if not options then
		return {} :: SequenceAnimationHandle
	end
	local baseScale = if options.From ~= nil then options.From else self:EnsureScale(window).Scale
	local peakScale = options.To or PULSE_SCALE
	local returnAnimation
	local peakAnimation
	local sequence

	returnAnimation = self:Scale(window, baseScale, {
		Damping = options.Damping,
		Frequency = options.Frequency,
		Epsilon = options.Epsilon,
		Clock = options.Clock,
		Done = function()
			if options.Done then
				options.Done()
			end

			sequence:Next()
		end,
	})

	peakAnimation = self:Scale(window, peakScale, {
		From = baseScale,
		Damping = options.Damping,
		Frequency = options.Frequency,
		Epsilon = options.Epsilon,
		Clock = options.Clock,
		Done = function()
			sequence:Next()
		end,
	})

	sequence = self:Sequence({ peakAnimation, returnAnimation })

	return sequence
end

-- Atalho legado para tocar uma animacao de escala com callbacks simples.
UIAnimationsController.PlayScale = function(
	self,
	window: GuiObject,
	fromScale: number,
	toScale: number,
	onStep: ((alpha: number) -> ())?,
	onDone: (() -> ())?
): AnimationHandle<number>
	self:Stop(window)
	local animation = self:Scale(window, toScale, {
		From = fromScale,
		Step = function(_value, alpha)
			if onStep then
				onStep(alpha)
			end
		end,
		Done = onDone,
	})

	animation:Play()
	return animation
end

-- Abre uma janela usando a animacao padrao de Pop.
UIAnimationsController.Open = function(self, window: GuiObject): AnimationHandle<number>
	self:Stop(window)
	local animation = self:Pop(window)
	animation:Play()
	return animation
end

-- Fecha uma janela usando a animacao padrao de Collapse.
UIAnimationsController.Close = function(self, window: GuiObject, onDone: (() -> ())?): AnimationHandle<number>
	self:Stop(window)
	local animation = self:Collapse(window, {
		Done = onDone,
	})
	animation:Play()
	return animation
end

-- Vincula escala de hover a uma instancia marcada com UI.HoverScale.
UIAnimationsController.BindHoverScale = function(self, instance: Instance)
	if self:IsTaggedBound(instance, HOVER_SCALE_TAG) then
		return
	end

	local window = getTaggedGuiObject(instance, HOVER_SCALE_TAG)
	if not window then
		return
	end

	local scale = self:EnsureScale(window)
	local baseScale = getNumberAttribute(window, "BaseScale", scale.Scale)
	local hoverScale = getNumberAttribute(window, "HoverScale", baseScale * HOVER_SCALE)
	local animation = self:Scale(window, baseScale, getTaggedSpringOptions(window))

	local enterConnection = window.MouseEnter:Connect(function()
		animation:Play(hoverScale)
	end)

	local leaveConnection = window.MouseLeave:Connect(function()
		animation:Play(baseScale)
	end)

	local destroyingConnection = window.Destroying:Connect(function()
		self:UnbindTag(window, HOVER_SCALE_TAG)
	end)

	self:TrackTaggedTasks(window, HOVER_SCALE_TAG, {
		enterConnection,
		leaveConnection,
		destroyingConnection,
		function()
			animation:Destroy()
		end,
	})
end

-- Vincula fade de hover a uma instancia marcada com UI.HoverFade.
UIAnimationsController.BindHoverFade = function(self, instance: Instance)
	if self:IsTaggedBound(instance, HOVER_FADE_TAG) then
		return
	end

	local window = getTaggedGuiObject(instance, HOVER_FADE_TAG)
	if not window then
		return
	end

	local fadeTarget = self:FindCanvas(window) or window
	local idleTransparency = getNumberAttribute(window, "IdleTransparency", getTransparency(fadeTarget))
	local hoverTransparency = getNumberAttribute(window, "HoverTransparency", 0)
	local animation = self:Fade(window, idleTransparency, getTaggedSpringOptions(window))

	local enterConnection = window.MouseEnter:Connect(function()
		animation:Play(hoverTransparency)
	end)

	local leaveConnection = window.MouseLeave:Connect(function()
		animation:Play(idleTransparency)
	end)

	local destroyingConnection = window.Destroying:Connect(function()
		self:UnbindTag(window, HOVER_FADE_TAG)
	end)

	self:TrackTaggedTasks(window, HOVER_FADE_TAG, {
		enterConnection,
		leaveConnection,
		destroyingConnection,
		function()
			animation:Destroy()
		end,
	})
end

-- Vincula estados de hover e press a um GuiButton marcado com UI.Press.
UIAnimationsController.BindPress = function(self, instance: Instance)
	if self:IsTaggedBound(instance, PRESS_TAG) then
		return
	end

	if not instance:IsA("GuiButton") then
		warn(`[UIAnimationsController] "{instance:GetFullName()}" usa {PRESS_TAG}, mas nao e GuiButton.`)
		return
	end

	local button = instance :: GuiButton
	local scale = self:EnsureScale(button)
	local baseScale = getNumberAttribute(button, "BaseScale", scale.Scale)
	local hoverScale = getNumberAttribute(button, "HoverScale", baseScale * 1.03)
	local pressScale = getNumberAttribute(button, "PressScale", PRESS_SCALE)
	local animation = self:Scale(button, baseScale, getTaggedSpringOptions(button))
	local isHovering = false
	local isPressed = false

	-- Escolhe a escala atual com base no estado de hover/pressionado.
	local function playCurrentTarget()
		if isPressed then
			animation:Play(pressScale)
		elseif isHovering then
			animation:Play(hoverScale)
		else
			animation:Play(baseScale)
		end
	end

	local enterConnection = button.MouseEnter:Connect(function()
		isHovering = true
		playCurrentTarget()
	end)

	local leaveConnection = button.MouseLeave:Connect(function()
		isHovering = false
		isPressed = false
		playCurrentTarget()
	end)

	local downConnection = button.MouseButton1Down:Connect(function()
		isPressed = true
		playCurrentTarget()
	end)

	local upConnection = button.MouseButton1Up:Connect(function()
		isPressed = false
		playCurrentTarget()
	end)

	local destroyingConnection = button.Destroying:Connect(function()
		self:UnbindTag(button, PRESS_TAG)
	end)

	self:TrackTaggedTasks(button, PRESS_TAG, {
		enterConnection,
		leaveConnection,
		downConnection,
		upConnection,
		destroyingConnection,
		function()
			animation:Destroy()
		end,
	})
end

-- Toca Pop automaticamente para instancias marcadas com UI.Pop.
UIAnimationsController.PlayTaggedPop = function(self, instance: Instance)
	if self:IsTaggedBound(instance, POP_TAG) then
		return
	end

	local window = getTaggedGuiObject(instance, POP_TAG)
	if not window then
		return
	end

	local animation = self:Pop(window, {
		Damping = getNumberAttribute(window, "Damping", DEFAULT_DAMPING),
		Frequency = getNumberAttribute(window, "Frequency", DEFAULT_FREQUENCY),
		Epsilon = getNumberAttribute(window, "Epsilon", DEFAULT_EPSILON),
		Clock = getClockAttribute(window),
	})
	animation:Play()

	local destroyingConnection = window.Destroying:Connect(function()
		self:UnbindTag(window, POP_TAG)
	end)

	self:TrackTaggedTasks(window, POP_TAG, {
		destroyingConnection,
		function()
			animation:Destroy()
		end,
	})
end

-- Toca Collapse automaticamente para instancias marcadas com UI.Collapse.
UIAnimationsController.PlayTaggedCollapse = function(self, instance: Instance)
	if self:IsTaggedBound(instance, COLLAPSE_TAG) then
		return
	end

	local window = getTaggedGuiObject(instance, COLLAPSE_TAG)
	if not window then
		return
	end

	local animation = self:Collapse(window, {
		Damping = getNumberAttribute(window, "Damping", DEFAULT_DAMPING),
		Frequency = getNumberAttribute(window, "Frequency", DEFAULT_FREQUENCY),
		Epsilon = getNumberAttribute(window, "Epsilon", DEFAULT_EPSILON),
		Clock = getClockAttribute(window),
	})
	animation:Play()

	local destroyingConnection = window.Destroying:Connect(function()
		self:UnbindTag(window, COLLAPSE_TAG)
	end)

	self:TrackTaggedTasks(window, COLLAPSE_TAG, {
		destroyingConnection,
		function()
			animation:Destroy()
		end,
	})
end

-- Toca Pulse automaticamente para instancias marcadas com UI.Pulse.
UIAnimationsController.PlayTaggedPulse = function(self, instance: Instance)
	if self:IsTaggedBound(instance, PULSE_TAG) then
		return
	end

	local window = getTaggedGuiObject(instance, PULSE_TAG)
	if not window then
		return
	end

	local animation = self:Pulse(window, {
		To = getNumberAttribute(window, "PulseScale", PULSE_SCALE),
		Damping = getNumberAttribute(window, "Damping", DEFAULT_DAMPING),
		Frequency = getNumberAttribute(window, "Frequency", DEFAULT_FREQUENCY),
		Epsilon = getNumberAttribute(window, "Epsilon", DEFAULT_EPSILON),
		Clock = getClockAttribute(window),
	})
	animation:Play()

	local destroyingConnection = window.Destroying:Connect(function()
		self:UnbindTag(window, PULSE_TAG)
	end)

	self:TrackTaggedTasks(window, PULSE_TAG, {
		destroyingConnection,
		function()
			animation:Destroy()
		end,
	})
end

-- Registra todos os presets de animacao baseados em tags.
UIAnimationsController:OnInit(function(self)
	local tags = {
		[HOVER_SCALE_TAG] = self.BindHoverScale,
		[HOVER_FADE_TAG] = self.BindHoverFade,
		[PRESS_TAG] = self.BindPress,
		[POP_TAG] = self.PlayTaggedPop,
		[COLLAPSE_TAG] = self.PlayTaggedCollapse,
		[PULSE_TAG] = self.PlayTaggedPulse,
	}

	for tag, binder in tags do
		self:BindTaggedPreset(tag, binder)
	end
end)

-- Limpa tags, animacoes ativas e conexoes quando o controller e destruido.
UIAnimationsController:OnDestroy(function(self)
	local taggedInstances = {}
	for instance in self.TaggedTasks do
		table.insert(taggedInstances, instance)
	end

	for _, instance in taggedInstances do
		self:UnbindAllTags(instance)
	end

	for target, animations in self.ActiveAnimations do
		for animation in animations do
			animation:Destroy()
		end

		self.ActiveAnimations[target] = nil
	end

	for window, connection in self.ActiveConnections do
		connection:Disconnect()
		self.ActiveConnections[window] = nil
	end
end)

return UIAnimationsController
