-- Signal Module
-- Sistema de eventos/sinais usando metatables em Lua
-- Permite conectar callbacks a sinais e disparar eventos

export type SignalConnection = {
	Connected: boolean,
	Disconnect: (self: SignalConnection) -> (),
}

export type Signal<T...> = {
	Connect: (self: Signal<T...>, callback: (T...) -> ()) -> SignalConnection,
	Fire: (self: Signal<T...>, T...) -> (),
	Wait: (self: Signal<T...>) -> T...,
	Block: (self: Signal<T...>) -> (),
	Unblock: (self: Signal<T...>) -> (),
	GetConnectionCount: (self: Signal<T...>) -> number,
	DisconnectAll: (self: Signal<T...>) -> (),
}

export type SignalAPI = {
	new: <T...>() -> Signal<T...>,
}

local Signal = {} :: any
Signal.__index = Signal

-- Cria um novo sinal
function Signal.new()
	local self = setmetatable({}, Signal)
	self._connections = {}
	self._blocked = false
	return self
end

-- Conecta uma função ao sinal
-- Retorna um objeto Connection que pode ser desconectado
function Signal:Connect(callback)
	if type(callback) ~= "function" then
		error("Callback deve ser uma função", 2)
	end

	local connection = {
		Connected = true,
		_callback = callback,
		_signal = self,
	}

	-- Metatable para o objeto Connection
	local connectionMeta = {
		__newindex = function(t, k, v)
			if k == "Connected" then
				if not v and rawget(t, "Connected") then
					-- Desconectar
					for i, conn in ipairs(self._connections) do
						if conn == t then
							table.remove(self._connections, i)
							rawset(t, "Connected", false)
							break
						end
					end
				else
					rawset(t, k, v)
				end
			else
				rawset(t, k, v)
			end
		end,
	}

	setmetatable(connection, connectionMeta)
	table.insert(self._connections, connection)

	-- Método para desconectar
	function connection:Disconnect()
		self.Connected = false
	end

	return connection
end

-- Dispara o sinal com os argumentos fornecidos
function Signal:Fire(...)
	if self._blocked then
		return
	end

	-- Cria uma cópia para evitar problemas se conexões forem removidas durante execução
	local connections = {}
	for _, conn in ipairs(self._connections) do
		table.insert(connections, conn)
	end

	for _, connection in ipairs(connections) do
		if connection.Connected then
			local success, err = pcall(connection._callback, ...)
			if not success then
				error("Erro ao executar callback: " .. tostring(err), 2)
			end
		end
	end
end

-- Aguarda até que o sinal seja disparado
function Signal:Wait()
	local thread = coroutine.running()
	if not thread then
		error("Wait() deve ser chamado em uma coroutine", 2)
	end

	local connection
	connection = self:Connect(function(...)
		connection:Disconnect()
		coroutine.resume(thread, ...)
	end)

	return coroutine.yield()
end

-- Bloqueia o sinal (dispara Fire mas nada acontece)
function Signal:Block()
	self._blocked = true
end

-- Desbloqueia o sinal
function Signal:Unblock()
	self._blocked = false
end

-- Obtém o número de conexões ativas
function Signal:GetConnectionCount()
	local count = 0
	for _, conn in ipairs(self._connections) do
		if conn.Connected then
			count = count + 1
		end
	end
	return count
end

-- Desconecta todas as conexões
function Signal:DisconnectAll()
	for _, conn in ipairs(self._connections) do
		conn.Connected = false
	end
	self._connections = {}
end

-- Metatable para o Signal
setmetatable(Signal, {
	__call = function(self)
		return Signal.new()
	end,
})

return (Signal :: any) :: SignalAPI
