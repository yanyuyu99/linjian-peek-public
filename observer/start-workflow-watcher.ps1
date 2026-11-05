param(
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js was not found in PATH. Start the watcher with the Node executable you normally use for solune-watcher.mjs."
}

if ($DryRun) {
  & $node.Source ".\workflow-inbox-watcher.mjs" --watch
} else {
  & $node.Source ".\workflow-inbox-watcher.mjs" --watch --live
}
