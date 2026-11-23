param([switch]$Check)
$ErrorActionPreference = 'Stop'
$root = if ($env:X2_INSTALL_DIR) { $env:X2_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'X2' }
$sourceUrl = 'https://raw.githubusercontent.com/Stanleyzrice/x2/main/ops/install'
$runtime = Join-Path $root 'runtime'
$manifest = Join-Path $runtime 'pixi.toml'
$app = Join-Path $root 'app'
$env:PIXI_HOME = Join-Path $root 'pixi'
$env:PIXI_NO_PATH_UPDATE = 'true'
$env:PIXI_NO_TELEMETRY = 'true'
$pixi = Join-Path $env:PIXI_HOME 'bin\pixi.exe'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null

function Invoke-X2Runtime {
    & $pixi run --manifest-path $manifest @args
    if ($LASTEXITCODE -ne 0) { throw "X2 install step failed (exit $LASTEXITCODE): $($args[0])" }
}

if (-not (Test-Path $pixi)) {
    & ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing 'https://pixi.sh/install.ps1').Content))
}
if (-not (Test-Path $pixi)) { throw 'Pixi did not install.' }
if (-not (Test-Path $manifest)) {
    Invoke-WebRequest -UseBasicParsing "$sourceUrl/pixi.toml" -OutFile "$manifest.tmp"
    Move-Item -LiteralPath "$manifest.tmp" -Destination $manifest
}

if (-not (Test-Path (Join-Path $app '.git'))) {
    Invoke-X2Runtime git clone --depth 1 https://github.com/Stanleyzrice/x2.git $app
}

& $pixi install --manifest-path $manifest
if ($LASTEXITCODE -ne 0) { throw 'Could not install the X2 runtime.' }
$gitShell = Join-Path $runtime '.pixi\envs\default\Library\usr\bin\sh.exe'
if (-not (Test-Path $gitShell)) { throw 'Git sh.exe was not installed by the runtime.' }
$previousShell = $env:npm_config_script_shell
Push-Location $app
try {
    $env:npm_config_script_shell = $gitShell
    Invoke-X2Runtime npm exec --yes --package pnpm@10.18.3 -- pnpm --dir $app install --frozen-lockfile
    $launch = @('node', (Join-Path $app 'ops\install\start.mjs'), $root)
    if ($Check) { $launch += '--check' }
    Invoke-X2Runtime @launch
} finally {
    Pop-Location
    $env:npm_config_script_shell = $previousShell
}
