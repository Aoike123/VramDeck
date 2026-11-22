[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$InstallDir = $(if ($env:VRAMDECK_INSTALL_DIR) { $env:VRAMDECK_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.vramdeck' })
)

$ErrorActionPreference = 'Stop'

function Get-NodeSemver {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) {
    return $null
  }
  $raw = & $cmd.Source -p "process.versions.node" 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
    $raw = (& $cmd.Source -v 2>$null)
  }
  if ($raw -match '(\d+)\.(\d+)\.(\d+)') {
    return [pscustomobject]@{
      Raw   = "$($Matches[1]).$($Matches[2]).$($Matches[3])"
      Major = [int]$Matches[1]
      Minor = [int]$Matches[2]
      Patch = [int]$Matches[3]
      Source = $cmd.Source
    }
  }
  return $null
}

Write-Output '==> VramDeck Windows Installer (Target: Node.js >= 22.19)'

$nodeInfo = Get-NodeSemver
if (-not $nodeInfo) {
  Write-Error 'Node.js >= 22.19 is required for VramDeck. Install Node.js 22.19+ from https://nodejs.org or via winget install OpenJS.NodeJS.LTS'
  exit 1
}

if ($nodeInfo.Major -lt 22 -or ($nodeInfo.Major -eq 22 -and $nodeInfo.Minor -lt 19)) {
  Write-Error "Detected Node.js v$($nodeInfo.Raw) at '$($nodeInfo.Source)', but VramDeck requires Node.js >= 22.19. Please upgrade Node.js."
  exit 1
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$workbenchDir = Join-Path $repoRoot 'platforms\workbench'
$mcpDir = Join-Path $repoRoot 'platforms\mcp'

Write-Output "Detected Node.js v$($nodeInfo.Raw)"
Write-Output "Install directory: $InstallDir"
Write-Output "Workbench root: $workbenchDir"

if ($DryRun) {
  Write-Output '[DryRun] Would create install state directory, install npm dependencies under platforms\workbench and platforms\mcp, build Next.js console, and configure VramDeck.'
  Write-Output '[DryRun] Service URLs once started: Console http://127.0.0.1:13000 | API Gateway http://127.0.0.1:18982'
  exit 0
}

New-Item -ItemType Directory -Path "$InstallDir" -Force | Out-Null

$npmInfo = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($npmInfo) { $npmCmd = $npmInfo.Source } else { $npmCmd = 'npm' }

& $npmCmd --prefix "$workbenchDir" ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (Test-Path (Join-Path $mcpDir 'package.json')) {
  & $npmCmd --prefix "$mcpDir" ci
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$env:WORKBENCH_NEXT_DIST = '.next-workbench'
& $npmCmd --prefix "$workbenchDir" run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Output ''
Write-Output 'VramDeck installation completed!'
Write-Output '  Console UI : http://127.0.0.1:13000'
Write-Output '  API / MCP  : http://127.0.0.1:18982'
Write-Output '  Start now  : node platforms/workbench/cli.mjs start'
