--!strict

local Sera = require(game.ReplicatedStorage.Sera)

-- Defining a schema:

local CustomType = table.freeze({
	Name = "TwoNumbers",
	Ser = function(b: buffer, offset: number, value: {number}): number
		buffer.writef64(b, offset, value[1])
		buffer.writef64(b, offset + 8, value[2])
		return offset + 16
	end,
	Des = function(b: buffer, offset: number): ({number}, number)
		return {
			buffer.readf64(b, offset),
			buffer.readf64(b, offset + 8)
		}, offset + 16
	end,
})

local TestSchema = Sera.Schema({
	Health = Sera.Int16,
	Position = Sera.Vector3,
	Name = Sera.String8,
	TwoNumbers = CustomType
})

-- Trying out serialization of a dictionary with all fields present:

do

	local serialized, error_message = Sera.Serialize(TestSchema, {
		Health = 150,
		Position = Vector3.new(1001, 69, 0.1),
		Name = "loleris",
		TwoNumbers = {1234.56, 0.001},
	})

	if error_message ~= nil then
		error(error_message)
	end
	
	local deserialized1, offset = Sera.Deserialize(TestSchema, serialized :: buffer)

	local b = buffer.create(offset + 10)
	Sera.Push(TestSchema, deserialized1, b, 10)

	local deserialized2 = Sera.Deserialize(TestSchema, b, 10)
	
	print(`All field serialization:`)
	print(`Serialized buffer size: {buffer.len(serialized :: buffer)} bytes`)
	print(`Deserialized result #1:`, deserialized1)
	print(`Deserialized result #2:`, deserialized2)
	
end

-- Trying out serialization of a dictionary with only some fields present:

do

	local serialized, error_message = Sera.DeltaSerialize(TestSchema, {
		Position = Vector3.new(900, 60, 3),
		TwoNumbers = {-20, -1.5},
	})

	if error_message ~= nil then
		error(error_message)
	end
	
	local deserialized1, offset = Sera.DeltaDeserialize(TestSchema, serialized :: buffer)

	local b = buffer.create(offset + 10)
	Sera.DeltaPush(TestSchema, deserialized1, b, 10)

	local deserialized2 = Sera.DeltaDeserialize(TestSchema, b, 10)
	
	print(`Partial field serialization:`)
	print(`Serialized buffer size: {buffer.len(serialized :: buffer)} bytes`)
	print(`Deserialized result #1:`, deserialized1)
	print(`Deserialized result #2:`, deserialized2)
	
end