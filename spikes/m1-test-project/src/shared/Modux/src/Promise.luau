--!strict

export type Status = "Pending" | "Fulfilled" | "Rejected" | "Cancelled"
export type ErrorKind = "ExecutionError" | "AlreadyCancelled" | "NotResolvedInTime" | "TimedOut"

export type ErrorOptions = {
	error: unknown?,
	trace: string?,
	context: string?,
	kind: ErrorKind?,
	parent: Error?,
}

export type Error = {
	error: string,
	trace: string?,
	context: string?,
	kind: ErrorKind?,
	parent: Error?,
	createdTick: number,
	createdTrace: string,
	extend: (self: Error, options: ErrorOptions?) -> Error,
	getErrorChain: (self: Error) -> { Error },
}

type Fn<A...> = (A...) -> ()
type Opt<T> = T?

type AnyFn = (...any) -> ...any

export type Resolve<T> = (value: T | Promise<T>, ...any) -> ()
export type Reject = (reason: any) -> ()
export type OnCancel = (callback: Fn<>) -> ()

export type Executor<T> = (resolve: Resolve<T>, reject: Reject, onCancel: OnCancel) -> ()

export type PromiseLike = {
	andThen: (self: PromiseLike, onFulfilled: Opt<AnyFn>, onRejected: Opt<AnyFn>) -> PromiseLike,
	catch: (self: PromiseLike, onRejected: AnyFn) -> PromiseLike,
	finally: (self: PromiseLike, onFinally: Fn<>) -> PromiseLike,
	tap: (self: PromiseLike, onTap: (any) -> ()) -> PromiseLike,
	andThenCall: (self: PromiseLike, callback: AnyFn, any) -> PromiseLike,
	andThenReturn: (self: PromiseLike, any) -> PromiseLike,
	finallyCall: (self: PromiseLike, callback: AnyFn, any) -> PromiseLike,
	finallyReturn: (self: PromiseLike, any) -> PromiseLike,
	now: (self: PromiseLike, rejectionValue: any?) -> PromiseLike,
	timeout: (self: PromiseLike, seconds: number, rejectionValue: any?) -> PromiseLike,

	cancel: (self: PromiseLike) -> (),
	getStatus: (self: PromiseLike) -> Status,
	awaitStatus: (self: PromiseLike) -> (Status, any?),
	expect: (self: PromiseLike) -> any,
	await: (self: PromiseLike) -> (boolean, any),
}

export type Promise<T> = PromiseLike & {
	andThen: <U>(
		self: Promise<T>,
		onFulfilled: ((value: T) -> U | Promise<U>)?,
		onRejected: ((reason: any) -> U | Promise<U>)?
	) -> Promise<U>,
	catch: <U>(self: Promise<T>, onRejected: (reason: any) -> U | Promise<U>) -> Promise<T | U>,
	tap: (self: Promise<T>, onTap: (value: T) -> any) -> Promise<T>,
	now: (self: Promise<T>, rejectionValue: any?) -> Promise<T>,
	timeout: (self: Promise<T>, seconds: number, rejectionValue: any?) -> Promise<T>,
	awaitStatus: (self: Promise<T>) -> (Status, T?),
	expect: (self: Promise<T>) -> T,
	await: (self: Promise<T>) -> (boolean, T?),
}

type PackedValues = { n: number, [number]: any }

type Handler<T> = {
	onFulfilled: ((...any) -> ...any)?,
	onRejected: ((reason: any) -> ...any)?,
	resolve: (...any) -> (),
	reject: (reason: any) -> (),
	traceback: string,
}

type CancelState = {
	cancelled: boolean,
	callbacks: { Fn<> },
}

type _Promise<T> = PromiseLike & {
	_status: Status,
	_values: PackedValues?,
	_reason: any,
	_handlers: { Handler<any> },
	_cancelState: CancelState,
	_handled: boolean,
	_source: string,
	_consumers: number,
}

local StatusEnum = table.freeze({
	Pending = "Pending" :: "Pending",
	Fulfilled = "Fulfilled" :: "Fulfilled",
	Rejected = "Rejected" :: "Rejected",
	Cancelled = "Cancelled" :: "Cancelled",
})

local ErrorKindEnum = table.freeze({
	ExecutionError = "ExecutionError" :: "ExecutionError",
	AlreadyCancelled = "AlreadyCancelled" :: "AlreadyCancelled",
	NotResolvedInTime = "NotResolvedInTime" :: "NotResolvedInTime",
	TimedOut = "TimedOut" :: "TimedOut",
})

local Error = {} :: any
Error.__index = Error

function Error.new(options: ErrorOptions?): Error
	local opts = (options or { error = "Unknown Error" }) :: ErrorOptions
	local self = setmetatable({
		error = if opts.error ~= nil then tostring(opts.error) else "[This error has no error text.]",
		trace = opts.trace,
		context = opts.context,
		kind = opts.kind,
		parent = opts.parent,
		createdTick = os.clock(),
		createdTrace = debug.traceback(),
	}, Error)
	return self :: any
end

function Error.is(value: any): boolean
	if type(value) ~= "table" then
		return false
	end
	local mt = getmetatable(value)
	return mt == Error
end

function Error:extend(options: ErrorOptions?): Error
	local opts = (options or { error = self.error }) :: ErrorOptions
	if opts.kind == nil then
		opts.kind = self.kind
	end
	opts.parent = self
	return Error.new(opts)
end

function Error:getErrorChain(): { Error }
	local chain: { Error } = { self }
	local cur: Error? = self
	while cur and cur.parent do
		table.insert(chain, cur.parent)
		cur = cur.parent
	end
	return chain
end

function Error:__tostring(): string
	local parts: { string } = {
		string.format("-- Promise.Error(%s) --", self.kind or "?"),
	}
	for _, err in self:getErrorChain() do
		table.insert(parts, table.concat({ err.trace or err.error, err.context or "" }, "\n"))
	end
	return table.concat(parts, "\n")
end

local Promise = {} :: any
Promise.__index = Promise

local PROMISE_BRAND = "__LUUAU_PROMISE__"

local unhandledRejectionCallbacks: { (promise: PromiseLike, reason: any) -> () } = {}

local taskDefer = task.defer
local taskDelay = task.delay
local taskSpawn = task.spawn

local function isCallable(value: any): boolean
	if type(value) == "function" then
		return true
	end
	if type(value) == "table" then
		local mt = getmetatable(value)
		if mt and type(rawget(mt, "__call")) == "function" then
			return true
		end
	end
	return false
end

local function isPromise(value: any): boolean
	if type(value) ~= "table" then
		return false
	end
	local mt = getmetatable(value)
	return mt == Promise and rawget(value, PROMISE_BRAND) == true
end

local function schedule(fn: () -> ())
	taskDefer(fn)
end

local function cancelStateNew(): CancelState
	return {
		cancelled = false,
		callbacks = {},
	}
end

local function onCancelRegister(cancelState: CancelState, cb: () -> ()): ()
	if cancelState.cancelled then
		schedule(cb)
		return
	end
	table.insert(cancelState.callbacks, cb)
end

local function cancelStateFire(cancelState: CancelState)
	if cancelState.cancelled then
		return
	end
	cancelState.cancelled = true
	local callbacks = cancelState.callbacks
	cancelState.callbacks = {}
	for _, cb in callbacks do
		schedule(cb)
	end
end

local function makeErrorHandler(creationTrace: string): (err: any) -> any
	return function(err: any): any
		if type(err) == "table" then
			return err
		end
		return Error.new({
			error = tostring(err),
			kind = ErrorKindEnum.ExecutionError,
			trace = debug.traceback(tostring(err), 2),
			context = "Promise created at:\n\n" .. creationTrace,
		})
	end
end

local function runCallback(traceback: string, fn: AnyFn, ...: any): (boolean, any)
	local packed = table.pack(xpcall(fn, makeErrorHandler(traceback), ...))
	if not packed[1] then
		return false, packed[2]
	end
	local n = packed.n - 1
	local out: PackedValues = table.create(n) :: any
	out.n = n
	for i = 1, n do
		out[i] = packed[i + 1]
	end
	return true, out
end

local function runHandler<T>(parent: _Promise<T>, handler: Handler<T>)
	if parent._status == "Cancelled" then
		handler.reject(parent._reason or "Promise cancelled")
		return
	end

	local ok: boolean
	local out: any
	if parent._status == "Fulfilled" then
		local values = parent._values :: PackedValues
		if handler.onFulfilled == nil then
			handler.resolve(table.unpack(values, 1, values.n))
			return
		end
		ok, out = runCallback(handler.traceback, handler.onFulfilled, table.unpack(values, 1, values.n))
	else
		if handler.onRejected == nil then
			handler.reject(parent._reason)
			return
		end
		ok, out = runCallback(handler.traceback, handler.onRejected, parent._reason)
	end

	if not ok then
		handler.reject(out)
		return
	end

	local results = out :: PackedValues
	local first = results[1]
	if isPromise(first) then
		(first :: any):andThen(handler.resolve, handler.reject)
	else
		handler.resolve(table.unpack(results, 1, results.n))
	end
end

local function flushHandlers<T>(self: _Promise<T>)
	local handlers = self._handlers
	if handlers[1] == nil then
		return
	end
	self._handlers = {}

	schedule(function()
		for i = 1, #handlers do
			runHandler(self, handlers[i])
		end
	end)
end

local _reject: <T>(self: _Promise<T>, reason: any) -> ()

local function _resolve<T>(self: _Promise<T>, ...: any)
	if self._status ~= "Pending" then
		return
	end
	local first = ...
	if first == self then
		self._status = "Rejected"
		self._reason = "Cannot resolve promise with itself"
		flushHandlers(self)
		return
	end

	if isPromise(first) then
		if select("#", ...) > 1 then
			warn(
				string.format(
					"When a Promise is resolved with another Promise, extra arguments are discarded. See:\n\n%s",
					self._source
				)
			)
		end
		(first :: any):andThen(function(...: any)
			_resolve(self, ...)
		end, function(e: any)
			_reject(self, e)
		end)
		return
	end

	self._status = "Fulfilled"
	(self :: any)._values = table.pack(...)
	flushHandlers(self)
end

function _reject<T>(self: _Promise<T>, reason: any)
	if self._status ~= "Pending" then
		return
	end
	self._status = "Rejected"
	self._reason = reason

	taskDefer(function()
		if (self._status :: Status) ~= "Rejected" then
			return
		end
		if self._handled then
			return
		end

		local callbacks = unhandledRejectionCallbacks
		if callbacks[1] == nil then
			warn(string.format("Unhandled Promise rejection:\n\n%s\n\n%s", tostring(reason), self._source))
			return
		end

		for i = 1, #callbacks do
			taskSpawn(callbacks[i], self, reason)
		end
	end)
	flushHandlers(self)
end

local function newPromise<T>(executor: Executor<T>, sourceTrace: string?): Promise<T>
	local cancelState = cancelStateNew()
	local traceback = sourceTrace or debug.traceback(nil, 2)

	local self = setmetatable({
		[PROMISE_BRAND] = true,
		_status = "Pending" :: Status,
		_values = nil,
		_reason = nil,
		_handlers = {},
		_cancelState = cancelState,
		_handled = false,
		_source = traceback,
		_consumers = 0,
	}, Promise) :: any

	local resolved = false
	local rejected = false

	local function resolve(...: any)
		if resolved or rejected then
			return
		end
		resolved = true
		_resolve(self, ...)
	end

	local function reject(reason: any)
		if resolved or rejected then
			return
		end
		rejected = true
		_reject(self, reason)
	end

	local function onCancel(cb: () -> ())
		onCancelRegister(cancelState, cb)
	end

	schedule(function()
		if cancelState.cancelled then
			reject("Promise cancelled")
			return
		end

		local ok, err = (xpcall :: any)(executor, makeErrorHandler(traceback), resolve, reject, onCancel)
		if not ok then
			reject(err)
		end
	end)

	return self
end

local function makeSettled(status: Status, values: PackedValues?, reason: any, sourceTrace: string): Promise<any>
	return (
		setmetatable({
			[PROMISE_BRAND] = true,
			_status = status,
			_values = values,
			_reason = reason,
			_handlers = {},
			_cancelState = cancelStateNew(),
			_handled = true,
			_source = sourceTrace,
			_consumers = 0,
		}, Promise) :: any
	) :: Promise<any>
end

function Promise.new<T>(executor: Executor<T>): Promise<T>
	return newPromise(executor, debug.traceback(nil, 2))
end

function Promise.resolve<T>(value: T | Promise<T>): Promise<T>
	if isPromise(value) then
		return value :: any
	end
	return newPromise(function(resolve)
		resolve(value)
	end, debug.traceback(nil, 2))
end

function Promise.reject<T>(reason: any): Promise<T>
	return newPromise(function(_resolve, reject)
		reject(reason)
	end, debug.traceback(nil, 2))
end

function Promise.try<T>(fn: (...any) -> any, ...: any): Promise<T>
	local args = table.pack(...)
	local traceback = debug.traceback(nil, 2)
	return newPromise(function(resolve, reject)
		local packed = table.pack(xpcall(fn, makeErrorHandler(traceback), table.unpack(args, 1, args.n)))
		if not packed[1] then
			reject(packed[2])
			return
		end
		resolve(table.unpack(packed, 2, packed.n))
	end, traceback)
end

function Promise.defer<T>(executor: Executor<T>): Promise<T>
	return newPromise(executor, debug.traceback(nil, 2))
end

function Promise.promisify<T>(callback: (...any) -> T): (...any) -> Promise<T>
	return function(...: any): Promise<T>
		local args = table.pack(...)
		return Promise.try(function()
			return callback(table.unpack(args, 1, args.n))
		end)
	end
end

function Promise.fromEvent<T>(event: any, predicate: ((...any) -> boolean)?): Promise<T>
	return newPromise(function(resolve, reject, onCancel)
		if event == nil then
			reject("Promise.fromEvent expects an event, got nil")
			return
		end
		local eventType = typeof(event)
		if eventType ~= "table" and eventType ~= "userdata" and eventType ~= "RBXScriptSignal" then
			reject("Promise.fromEvent expects an event with :Connect")
			return
		end

		if predicate ~= nil and not isCallable(predicate) then
			reject("Promise.fromEvent predicate must be callable")
			return
		end

		local p = predicate or function(): boolean
			return true
		end

		local connection: any = nil
		local done = false

		local function disconnect()
			if connection ~= nil then
				local ok = pcall(function()
					(connection :: any):Disconnect()
				end)
				if not ok then
				end
				connection = nil
			end
		end

		onCancel(function()
			if done then
				return
			end
			done = true
			disconnect()
		end)

		local connectOk, connectErr = pcall(function()
			connection = (event :: any):Connect(function(...: any)
				if done then
					return
				end
				local ok, shouldResolve = pcall(p :: any, ...)
				if not ok then
					done = true
					disconnect()
					reject(shouldResolve)
					return
				end

				if shouldResolve == true then
					done = true
					disconnect()
					resolve(...)
				end
			end)
		end)
		if not connectOk then
			done = true
			reject(connectErr)
			return
		end
	end)
end

function Promise.delay(seconds: number): Promise<number>
	return newPromise(function(resolve, _, onCancel)
		local done = false
		onCancel(function()
			done = true
		end)
		taskDelay(seconds, function()
			if done then
				return
			end
			resolve(seconds)
		end)
	end)
end

function Promise._timeout<T>(promise: Promise<T>, seconds: number, rejectionValue: any?): Promise<T>
	return newPromise(function(resolve, reject, onCancel)
		local finished = false
		onCancel(function()
			if finished then
				return
			end
			finished = true
			if isPromise(promise) then
				(promise :: any):cancel()
			end
		end)

		taskDelay(seconds, function()
			if finished then
				return
			end
			finished = true
			if isPromise(promise) then
				(promise :: any):cancel()
			end
			reject(rejectionValue ~= nil and rejectionValue or "Promise timed out")
		end);
		(promise :: any):andThen(function(...: any)
			if finished then
				return
			end
			finished = true
			resolve(...)
		end, function(e: any)
			if finished then
				return
			end
			finished = true
			reject(e)
		end)
	end)
end

function Promise.all<T>(promises: { Promise<T> }): Promise<{ T }>
	return newPromise(function(resolve, reject, onCancel)
		local n = #promises
		if n == 0 then
			resolve({})
			return
		end

		local results = table.create(n) :: { T }
		local remaining = n
		local cancelled = false
		local finished = false

		local function cancelAll()
			for i = 1, n do
				(promises[i] :: any):cancel()
			end
		end

		onCancel(function()
			cancelled = true
			cancelAll()
		end)

		for i = 1, n do
			local p = promises[i];
			(p :: any):andThen(function(v: any)
				if cancelled then
					return
				end
				if finished then
					return
				end
				results[i] = v
				remaining -= 1
				if remaining == 0 then
					finished = true
					resolve(results)
				end
			end, function(e: any)
				if cancelled then
					return
				end
				if finished then
					return
				end
				finished = true
				cancelAll()
				reject(e)
			end)
		end
	end)
end

function Promise.some<T>(promises: { Promise<T> }, count: number): Promise<{ T }>
	return newPromise(function(resolve, reject, onCancel)
		local n = #promises
		if type(count) ~= "number" then
			reject("Promise.some expects count: number")
			return
		end
		if count <= 0 then
			resolve({})
			return
		end
		if n == 0 then
			reject("Promise.some requires at least one promise")
			return
		end
		if count > n then
			reject("Promise.some count cannot exceed list size")
			return
		end

		local results = table.create(count) :: { T }
		local resolvedCount = 0
		local rejectedCount = 0
		local finished = false

		local function cancelAll()
			for i = 1, n do
				(promises[i] :: any):cancel()
			end
		end

		onCancel(function()
			finished = true
			cancelAll()
		end)

		for i = 1, n do
			local p = promises[i];
			(p :: any):andThen(function(v: any)
				if finished then
					return
				end
				resolvedCount += 1
				results[resolvedCount] = v
				if resolvedCount >= count then
					finished = true
					cancelAll()
					resolve(results)
				end
			end, function(e: any)
				if finished then
					return
				end
				rejectedCount += 1
				if n - rejectedCount < count then
					finished = true
					cancelAll()
					reject(e)
				end
			end)
		end
	end)
end

function Promise.race<T>(promises: { Promise<T> }): Promise<T>
	return newPromise(function(resolve, reject, onCancel)
		local n = #promises
		local finished = false

		local function cancelAll()
			for i = 1, n do
				(promises[i] :: any):cancel()
			end
		end

		onCancel(function()
			finished = true
			cancelAll()
		end)

		for i = 1, n do
			local p = promises[i];
			(p :: any):andThen(function(v: any)
				if finished then
					return
				end
				finished = true
				cancelAll()
				resolve(v)
			end, function(e: any)
				if finished then
					return
				end
				finished = true
				cancelAll()
				reject(e)
			end)
		end
	end)
end

function Promise.any<T>(promises: { Promise<T> }): Promise<T>
	return newPromise(function(resolve, reject, onCancel)
		local n = #promises
		if n == 0 then
			reject("Promise.any requires at least one promise")
			return
		end

		local finished = false
		local rejections = 0
		local reasons = table.create(n)

		local function cancelAll()
			for i = 1, n do
				(promises[i] :: any):cancel()
			end
		end

		onCancel(function()
			finished = true
			cancelAll()
		end)

		for i = 1, n do
			local p = promises[i];
			(p :: any):andThen(function(v: any)
				if finished then
					return
				end
				finished = true
				cancelAll()
				resolve(v)
			end, function(e: any)
				if finished then
					return
				end
				reasons[i] = e
				rejections += 1
				if rejections == n then
					finished = true
					reject(reasons)
				end
			end)
		end
	end)
end

function Promise.allSettled<T>(
	promises: { Promise<T> }
): Promise<{ { status: "fulfilled", value: T } | { status: "rejected", reason: any } }>
	return newPromise(function(resolve, _reject, onCancel)
		local n = #promises
		if n == 0 then
			resolve({})
			return
		end

		local settled = table.create(n)
		local remaining = n
		local cancelled = false

		local function cancelAll()
			for i = 1, n do
				(promises[i] :: any):cancel()
			end
		end

		onCancel(function()
			cancelled = true
			cancelAll()
		end)

		for i = 1, n do
			local p = promises[i];
			(p :: any):andThen(function(v: any)
				if cancelled then
					return
				end
				settled[i] = { status = "fulfilled", value = v }
				remaining -= 1
				if remaining == 0 then
					resolve(settled :: any)
				end
			end, function(e: any)
				if cancelled then
					return
				end
				settled[i] = { status = "rejected", reason = e }
				remaining -= 1
				if remaining == 0 then
					resolve(settled :: any)
				end
			end)
		end
	end)
end

function Promise.each<T, U>(list: { T }, predicate: (value: T, index: number) -> U | Promise<U>): Promise<{ U }>
	return newPromise(function(resolve, reject, onCancel)
		local n = #list
		local results = table.create(n)
		local cancelled = false
		local inFlight: any = nil

		local function cancelInFlight()
			if inFlight ~= nil and isPromise(inFlight) then
				(inFlight :: any):cancel()
			end
		end

		onCancel(function()
			cancelled = true
			cancelInFlight()
		end)

		local function step(i: number)
			if cancelled then
				return
			end
			if i > n then
				resolve(results :: any)
				return
			end

			local ok, out = pcall(predicate :: any, list[i], i)
			if not ok then
				reject(out)
				return
			end

			if isPromise(out) then
				inFlight = out;
				(out :: any):andThen(function(v: any)
					inFlight = nil
					if cancelled then
						return
					end
					results[i] = v
					step(i + 1)
				end, function(e: any)
					inFlight = nil
					if cancelled then
						return
					end
					reject(e)
				end)
			else
				results[i] = out
				step(i + 1)
			end
		end

		step(1)
	end)
end

function Promise.fold<T, U>(
	list: { T },
	reducer: (acc: U, value: T, index: number) -> U | Promise<U>,
	initialValue: U
): Promise<U>
	return newPromise(function(resolve, reject, onCancel)
		local n = #list
		local cancelled = false
		local inFlight: any = nil

		local function cancelInFlight()
			if inFlight ~= nil and isPromise(inFlight) then
				(inFlight :: any):cancel()
			end
		end

		onCancel(function()
			cancelled = true
			cancelInFlight()
		end)

		local acc: any = initialValue

		local function step(i: number)
			if cancelled then
				return
			end
			if i > n then
				resolve(acc)
				return
			end

			local ok, out = pcall(reducer :: any, acc, list[i], i)
			if not ok then
				reject(out)
				return
			end

			if isPromise(out) then
				inFlight = out;
				(out :: any):andThen(function(v: any)
					inFlight = nil
					if cancelled then
						return
					end
					acc = v
					step(i + 1)
				end, function(e: any)
					inFlight = nil
					if cancelled then
						return
					end
					reject(e)
				end)
			else
				acc = out
				step(i + 1)
			end
		end

		step(1)
	end)
end

function Promise.retry<T>(callback: (...any) -> Promise<T>, times: number, ...: any): Promise<T>
	local args = table.pack(...)
	return newPromise(function(resolve, reject, onCancel)
		if type(times) ~= "number" then
			reject("Promise.retry expects times: number")
			return
		end

		local cancelled = false
		local inFlight: any = nil

		local function cancelInFlight()
			if inFlight ~= nil and isPromise(inFlight) then
				(inFlight :: any):cancel()
			end
		end

		onCancel(function()
			cancelled = true
			cancelInFlight()
		end)

		local function attempt(remaining: number)
			if cancelled then
				return
			end
			local ok, p = pcall(callback :: any, table.unpack(args, 1, args.n))
			if not ok then
				reject(p)
				return
			end
			if not isPromise(p) then
				reject("Promise.retry callback must return a Promise")
				return
			end

			inFlight = p;
			(p :: any):andThen(function(v: any)
				inFlight = nil
				if cancelled then
					return
				end
				resolve(v)
			end, function(e: any)
				inFlight = nil
				if cancelled then
					return
				end
				if remaining > 0 then
					attempt(remaining - 1)
				else
					reject(e)
				end
			end)
		end

		attempt(times)
	end)
end

function Promise.retryWithDelay<T>(callback: (...any) -> Promise<T>, times: number, seconds: number, ...: any): Promise<T>
	local args = table.pack(...)
	return newPromise(function(resolve, reject, onCancel)
		if type(times) ~= "number" then
			reject("Promise.retryWithDelay expects times: number")
			return
		end
		if type(seconds) ~= "number" then
			reject("Promise.retryWithDelay expects seconds: number")
			return
		end

		local cancelled = false
		local inFlight: any = nil

		local function cancelInFlight()
			if inFlight ~= nil and isPromise(inFlight) then
				(inFlight :: any):cancel()
			end
		end

		onCancel(function()
			cancelled = true
			cancelInFlight()
		end)

		local function attempt(remaining: number)
			if cancelled then
				return
			end
			local ok, p = pcall(callback :: any, table.unpack(args, 1, args.n))
			if not ok then
				reject(p)
				return
			end
			if not isPromise(p) then
				reject("Promise.retryWithDelay callback must return a Promise")
				return
			end

			inFlight = p;
			(p :: any):andThen(function(v: any)
				inFlight = nil
				if cancelled then
					return
				end
				resolve(v)
			end, function(e: any)
				inFlight = nil
				if cancelled then
					return
				end
				if remaining > 0 then
					inFlight = Promise.delay(seconds);
					(inFlight :: any):andThen(function()
						inFlight = nil
						attempt(remaining - 1)
					end, function(delayErr: any)
						inFlight = nil
						reject(delayErr)
					end)
				else
					reject(e)
				end
			end)
		end

		attempt(times)
	end)
end

function Promise.is(value: any): boolean
	return isPromise(value)
end

function Promise.onUnhandledRejection(callback: (promise: PromiseLike, reason: any) -> ()): () -> ()
	table.insert(unhandledRejectionCallbacks, callback)
	return function()
		local idx = table.find(unhandledRejectionCallbacks, callback)
		if idx then
			table.remove(unhandledRejectionCallbacks, idx)
		end
	end
end

function Promise:getStatus(): Status
	return (self :: any)._status
end

function Promise:cancel()
	local impl = self :: any
	if impl._status ~= "Pending" then
		return
	end
	impl._status = "Cancelled"
	cancelStateFire(impl._cancelState)
	impl._reason = "Promise cancelled"
	flushHandlers(impl)
end

function Promise:andThen<U>(onFulfilled, onRejected): Promise<U>
	local parent = self :: any
	if onRejected ~= nil then
		parent._handled = true
	end
	local handlerTrace = debug.traceback(nil, 2)

	-- Register as a live consumer so refcount-driven cancellation works.
	-- Only track consumers while the parent is still pending; once settled,
	-- the count is no longer meaningful.
	local registered = false
	if parent._status == "Pending" then
		parent._consumers += 1
		registered = true
	end

	return newPromise(function(resolve, reject, onCancel)
		local function releaseConsumer()
			if registered and parent._status == "Pending" then
				registered = false
				parent._consumers -= 1
			end
		end

		local function wrappedResolve(...: any)
			releaseConsumer()
			resolve(...)
		end

		local function wrappedReject(reason: any)
			releaseConsumer()
			reject(reason)
		end

		onCancel(function()
			if registered and parent._status == "Pending" then
				releaseConsumer()
				if parent._consumers <= 0 then
					(parent :: any):cancel()
				end
			end
		end)

		local handler: Handler<any> = {
			onFulfilled = onFulfilled,
			onRejected = onRejected,
			resolve = wrappedResolve,
			reject = wrappedReject,
			traceback = handlerTrace,
		}

		if parent._status == "Pending" then
			table.insert(parent._handlers, handler)
		else
			schedule(function()
				runHandler(parent, handler)
			end)
		end
	end, handlerTrace)
end

function Promise:catch<U>(onRejected): Promise<U>
	return (self :: any):andThen(nil, onRejected)
end

function Promise:tap(onTap: (any) -> any): Promise<any>
	return (self :: any):andThen(function(...: any)
		local args = table.pack(...)
		local ret = onTap(table.unpack(args, 1, args.n))
		if isPromise(ret) then
			return (ret :: any):andThen(function()
				return table.unpack(args, 1, args.n)
			end)
		end
		return table.unpack(args, 1, args.n)
	end)
end

function Promise:andThenReturn(...): Promise<any>
	local args = table.pack(...)
	return (self :: any):andThen(function()
		return table.unpack(args, 1, args.n)
	end)
end

function Promise:andThenCall(callback: (...any) -> ...any, ...): Promise<any>
	local args = table.pack(...)
	return (self :: any):andThen(function()
		return callback(table.unpack(args, 1, args.n))
	end)
end

function Promise:finally(onFinally: (status: Status) -> any): Promise<any>
	local parent = self :: any
	local traceback = debug.traceback(nil, 2)
	return newPromise(function(resolve, reject, onCancel)
		local cancelled = false
		onCancel(function()
			cancelled = true
		end)

		local function runFinally(status: Status, passthrough: () -> ())
			if cancelled then
				return
			end
			local ok, ret = pcall(onFinally, status)
			if cancelled then
				return
			end
			if not ok then
				reject(ret)
				return
			end
			if isPromise(ret) then
				(ret :: any):andThen(function()
					if cancelled then
						return
					end
					passthrough()
				end, function(e: any)
					if cancelled then
						return
					end
					reject(e)
				end)
			else
				passthrough()
			end
		end
		(parent :: any):andThen(function(...: any)
			local args = table.pack(...)
			runFinally("Fulfilled", function()
				resolve(table.unpack(args, 1, args.n))
			end)
		end, function(e: any)
			local status: Status = if parent._status == "Cancelled" then "Cancelled" else "Rejected"
			runFinally(status, function()
				reject(e)
			end)
		end)
	end, traceback)
end

function Promise:finallyReturn(...): Promise<any>
	local args = table.pack(...)
	return (self :: any):finally(function() end):andThen(function()
		return table.unpack(args, 1, args.n)
	end, function()
		return table.unpack(args, 1, args.n)
	end)
end

function Promise:finallyCall(callback: (...any) -> ...any, ...): Promise<any>
	local args = table.pack(...)
	return (self :: any):finally(function()
		return callback(table.unpack(args, 1, args.n))
	end)
end

function Promise:awaitStatus(): (Status, ...any)
	local impl = self :: any
	if impl._status == "Fulfilled" then
		local values = impl._values :: PackedValues
		return "Fulfilled", table.unpack(values, 1, values.n)
	elseif impl._status == "Rejected" then
		return "Rejected", impl._reason
	elseif impl._status == "Cancelled" then
		return "Cancelled", impl._reason
	end
	local packed = table.pack((self :: any):await())
	if packed[1] then
		return "Fulfilled", table.unpack(packed, 2, packed.n)
	end
	return (self :: any):getStatus(), packed[2]
end

function Promise:expect(): ...any
	local packed = table.pack((self :: any):await())
	if packed[1] then
		return table.unpack(packed, 2, packed.n)
	end
	error(packed[2], 2)
end

function Promise:now(rejectionValue: any?): Promise<any>
	local impl = self :: any
	local traceback = debug.traceback(nil, 2)
	if impl._status == "Fulfilled" then
		return makeSettled("Fulfilled", impl._values, nil, traceback)
	elseif impl._status == "Rejected" then
		return makeSettled("Rejected", nil, impl._reason, traceback)
	elseif impl._status == "Cancelled" then
		return makeSettled("Rejected", nil, impl._reason, traceback)
	end
	local reason = rejectionValue ~= nil and rejectionValue
		or Error.new({
			kind = ErrorKindEnum.NotResolvedInTime,
			error = "Promise was not fulfilled in time for :now()",
		})
	return makeSettled("Rejected", nil, reason, traceback)
end

function Promise:timeout(seconds: number, rejectionValue: any?): Promise<any>
	return Promise._timeout(self :: any, seconds, rejectionValue ~= nil and rejectionValue or Error.new({
		kind = ErrorKindEnum.TimedOut,
		error = "Timed out",
		context = string.format("Timeout of %s seconds exceeded.", tostring(seconds)),
	}))
end

function Promise:await(): (boolean, ...any)
	local impl = self :: any
	if impl._status == "Fulfilled" then
		local values = impl._values :: PackedValues
		return true, table.unpack(values, 1, values.n)
	elseif impl._status == "Rejected" or impl._status == "Cancelled" then
		return false, impl._reason
	end

	local thread = coroutine.running()
	if thread == nil then
		error("Promise:await() must be called from within a coroutine")
	end

	local done = false
	local okResult: boolean = false
	local rejectReason: any = nil
	local resolvedValues: PackedValues = { n = 0 }
	(self :: any):andThen(function(...: any)
		if done then
			return
		end
		done = true
		okResult = true
		resolvedValues = table.pack(...)
		taskSpawn(thread)
	end, function(e: any)
		if done then
			return
		end
		done = true
		okResult = false
		rejectReason = e
		taskSpawn(thread)
	end)

	coroutine.yield()
	if okResult then
		return true, table.unpack(resolvedValues, 1, resolvedValues.n)
	end
	return false, rejectReason
end

Promise.Status = StatusEnum
Promise.Error = table.freeze({
	new = Error.new,
	is = Error.is,
	Kind = ErrorKindEnum,
})

-- Public module-level types. Kept at the end of the file so we can refer to
-- locals (`StatusEnum`, `ErrorKindEnum`) via `typeof`, and to keep the runtime
-- surface and its type in sync without duplicating the enum literals.
export type ErrorAPI = {
	new: (options: ErrorOptions?) -> Error,
	is: (value: any) -> boolean,
	Kind: typeof(ErrorKindEnum),
}

-- Each field below mirrors its runtime counterpart byte-for-byte (generics
-- included). Keep them in lockstep when evolving the public API: the cast at
-- `return` is unchecked, so any mismatch here silently misleads consumers.
export type PromiseAPI = {
	-- Constructors
	new: <T>(executor: Executor<T>) -> Promise<T>,
	defer: <T>(executor: Executor<T>) -> Promise<T>,
	resolve: <T>(value: T | Promise<T>) -> Promise<T>,
	reject: <T>(reason: any) -> Promise<T>,
	try: <T>(fn: (...any) -> any, ...any) -> Promise<T>,

	-- Adapters
	promisify: <T>(callback: (...any) -> T) -> (...any) -> Promise<T>,
	fromEvent: <T>(event: any, predicate: ((...any) -> boolean)?) -> Promise<T>,
	delay: (seconds: number) -> Promise<number>,

	-- Combinators
	all: <T>(promises: { Promise<T> }) -> Promise<{ T }>,
	some: <T>(promises: { Promise<T> }, count: number) -> Promise<{ T }>,
	race: <T>(promises: { Promise<T> }) -> Promise<T>,
	any: <T>(promises: { Promise<T> }) -> Promise<T>,
	allSettled: <T>(
		promises: { Promise<T> }
	) -> Promise<{ { status: "fulfilled", value: T } | { status: "rejected", reason: any } }>,
	each: <T, U>(list: { T }, predicate: (value: T, index: number) -> U | Promise<U>) -> Promise<{ U }>,
	fold: <T, U>(
		list: { T },
		reducer: (acc: U, value: T, index: number) -> U | Promise<U>,
		initialValue: U
	) -> Promise<U>,

	-- Retry helpers
	retry: <T>(callback: (...any) -> Promise<T>, times: number, ...any) -> Promise<T>,
	retryWithDelay: <T>(
		callback: (...any) -> Promise<T>,
		times: number,
		seconds: number,
		...any
	) -> Promise<T>,

	-- Introspection / hooks
	is: (value: any) -> boolean,
	onUnhandledRejection: (callback: (promise: PromiseLike, reason: any) -> ()) -> () -> (),

	-- Constants
	Status: typeof(StatusEnum),
	Error: ErrorAPI,
}

return (Promise :: any) :: PromiseAPI
