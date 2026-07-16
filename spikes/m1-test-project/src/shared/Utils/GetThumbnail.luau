local Players = game:GetService("Players")
local GetThumbnail = {}

function GetThumbnail.AvatarBurst(Player: Player)
	local userId = Player.UserId
	local thumbnailType = Enum.ThumbnailType.AvatarBust
	local thumbnailSize = Enum.ThumbnailSize.Size420x420

	local success, content, isReady = pcall(function()
		return Players:GetUserThumbnailAsync(userId, thumbnailType, thumbnailSize)
	end)

	if success then
		return content, isReady
	else
		warn("Failed to get AvatarBurst for", Player.Name, ":", content)
		return nil, false
	end
end

function GetThumbnail.AvatarThumbnail(Player: Player, size: Enum.ThumbnailSize?)
	local userId = Player.UserId
	local thumbnailType = Enum.ThumbnailType.AvatarThumbnail
	local thumbnailSize = size or Enum.ThumbnailSize.Size150x150

	local success, content, isReady = pcall(function()
		return Players:GetUserThumbnailAsync(userId, thumbnailType, thumbnailSize)
	end)

	if success then
		return content, isReady
	else
		warn("Failed to get AvatarThumbnail for", Player.Name, ":", content)
		return nil, false
	end
end

function GetThumbnail.HeadShot(Player: Player, size: Enum.ThumbnailSize?)
	local userId = Player.UserId
	local thumbnailType = Enum.ThumbnailType.HeadShot
	local thumbnailSize = size or Enum.ThumbnailSize.Size150x150

	local success, content, isReady = pcall(function()
		return Players:GetUserThumbnailAsync(userId, thumbnailType, thumbnailSize)
	end)

	if success then
		return content, isReady
	else
		warn("Failed to get HeadShot for", Player.Name, ":", content)
		return nil, false
	end
end

return GetThumbnail
