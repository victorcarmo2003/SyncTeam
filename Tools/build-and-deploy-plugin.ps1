# Builda plugin/ com Rojo e implanta em:
# %LOCALAPPDATA%\Roblox\Plugins
#
# Remove o plugin antigo antes de copiar para facilitar o auto-refresh
# do Roblox Studio.
#
# Uso:
# powershell -ExecutionPolicy Bypass -File .\Tools\build-and-deploy-plugin.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Tools/ fica dentro da raiz do repositório.
$RepoRoot = Split-Path -Parent $PSScriptRoot
$PluginDir = Join-Path $RepoRoot "plugin"

$PluginsFolder = Join-Path $env:LOCALAPPDATA "Roblox\Plugins"
$PluginName = "SyncTeam.rbxm"
$DistDir = Join-Path $RepoRoot "dist-plugin"
$DistName = "SyncTeam.rbxmx"

function Find-LatestExecutable {
    param(
        [Parameter(Mandatory)]
        [string]$SearchPath,

        [Parameter(Mandatory)]
        [string]$ExecutableName
    )

    $Executables = Get-ChildItem `
        -Path $SearchPath `
        -Filter $ExecutableName `
        -File `
        -Recurse `
        -ErrorAction SilentlyContinue |
        Sort-Object {
            try {
                [version]$_.Directory.Name
            }
            catch {
                [version]"0.0.0"
            }
        } -Descending

    return $Executables | Select-Object -First 1
}

$RokitStorage = Join-Path $HOME ".rokit\tool-storage"

$RojoExecutable = Find-LatestExecutable `
    -SearchPath (Join-Path $RokitStorage "rojo-rbx\rojo") `
    -ExecutableName "rojo.exe"

if (-not $RojoExecutable) {
    throw @"
erro: rojo.exe não encontrado em:
$RokitStorage\rojo-rbx\rojo\*\rojo.exe

Ajuste a localização manualmente ou instale o Rojo pelo Rokit.
"@
}

$WallyExecutable = Find-LatestExecutable `
    -SearchPath $RokitStorage `
    -ExecutableName "wally.exe"

if (-not $WallyExecutable) {
    throw @"
erro: wally.exe não encontrado em:
$RokitStorage\*\wally\*\wally.exe

Ajuste a localização manualmente ou instale o Wally pelo Rokit.
"@
}

if (-not (Test-Path $PluginDir)) {
    throw "erro: diretório do plugin não encontrado: $PluginDir"
}

if (-not (Test-Path $PluginsFolder)) {
    Write-Host "== criando pasta de plugins =="
    New-Item -ItemType Directory -Path $PluginsFolder -Force | Out-Null
}

Write-Host "== wally install ($($WallyExecutable.FullName)) =="

Push-Location $PluginDir

try {
    & $WallyExecutable.FullName install

    if ($LASTEXITCODE -ne 0) {
        throw "wally install falhou com código $LASTEXITCODE"
    }

    Write-Host "== rojo build ($($RojoExecutable.FullName)) =="

    & $RojoExecutable.FullName build -o $PluginName

    if ($LASTEXITCODE -ne 0) {
        throw "rojo build falhou com código $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

$BuiltPlugin = Join-Path $PluginDir $PluginName
$DeployedPlugin = Join-Path $PluginsFolder $PluginName

if (-not (Test-Path $BuiltPlugin)) {
    throw "erro: o arquivo gerado não foi encontrado: $BuiltPlugin"
}

Write-Host "== implantando em $PluginsFolder =="

if (Test-Path $DeployedPlugin) {
    Remove-Item $DeployedPlugin -Force
}

Copy-Item `
    -Path $BuiltPlugin `
    -Destination $DeployedPlugin `
    -Force

# Companion plugin em XML (.rbxmx), commitado em dist-plugin/ - pra quem
# clonar o repo ja ter um plugin pronto pra instalar manualmente (arrastar
# pra pasta de Plugins do Studio), sem precisar de rojo/wally instalados.
Write-Host "== gerando companion em $DistDir\$DistName =="

if (-not (Test-Path $DistDir)) {
    New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
}

Push-Location $PluginDir
try {
    & $RojoExecutable.FullName build -o (Join-Path $DistDir $DistName)

    if ($LASTEXITCODE -ne 0) {
        throw "rojo build (companion) falhou com código $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "OK - plugin implantado."
Write-Host "Studios abertos devem detectar o refresh automaticamente."