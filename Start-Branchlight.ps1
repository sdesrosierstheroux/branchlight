param(
    [Parameter(Mandatory = $true)]
    [string]$Repository,
    [ValidateRange(1024, 65535)]
    [int]$Port = 48765
)

$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop
Get-Command git -CommandType Application -ErrorAction Stop | Out-Null
& $nodeCommand.Source (Join-Path $PSScriptRoot 'server.mjs') $Repository "--port=$Port" --open
exit $LASTEXITCODE
