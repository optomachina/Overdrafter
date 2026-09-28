param(
  [Parameter(Mandatory=$true)][string]$BenchmarkRoot,
  [Parameter(Mandatory=$true)][string]$OutputRoot
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$pythonPath = 'C:\Python312\python.exe'
$identity = & $pythonPath -c "import json,psutil; p=[p for p in psutil.process_iter(['name']) if p.info['name'].lower()=='sldworks.exe']; assert len(p)==1,'Exactly one SolidWorks process required'; print(json.dumps({'pid':p[0].pid,'started':p[0].create_time()}))" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Cannot retain SolidWorks identity' }
if (Get-NetTCPConnection -State Listen -LocalPort 8091 -ErrorAction SilentlyContinue) { throw 'Port 8091 already has an owner' }
$env:OVD_SAMPLE_PLATE_DEMO_ENABLED = '1'
$env:VITE_ENABLE_ENGINEERING_WORKBENCH = '1'
$env:OVD_SAMPLE_OUTPUT_ROOT = [IO.Path]::GetFullPath($OutputRoot)
$env:OVD_SAMPLE_PYTHON = $pythonPath
$env:OVD_SAMPLE_HELPER = Join-Path $BenchmarkRoot 'work\repairs\solidworks2022_ops.py'
$env:OVD_SAMPLE_JEV_HELPER = Join-Path $env:USERPROFILE '.codex\skills\typesafe-ai\scripts\jev-windows.py'
$env:OVD_SAMPLE_SW_PID = [string]$identity.pid
$env:OVD_SAMPLE_SW_STARTED = [string]$identity.started
Set-Location -LiteralPath $repoRoot
Write-Output "Local launch link will be saved in $OutputRoot\launch-url.txt. Keep it private."
& npm.cmd run dev -- --host 127.0.0.1 --port 8091 --strictPort
