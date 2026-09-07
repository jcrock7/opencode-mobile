<#
.SYNOPSIS
  Run Qwen coding models locally with llama-server (Windows twin of serve-local-models.sh).

.DESCRIPTION
  Two profiles are defined for a 12 GB VRAM / 32 GB RAM laptop:

    fast   Qwen3.6-35B-A3B (MoE, ~3B active). Experts live in system RAM,
           attention + KV cache live in VRAM. Long context, high tok/s.
    smart  Qwen3.8-27B (dense). Best local coding quality, slower, and it
           needs most of the GPU, so it does not coexist with `fast`.

  Only one profile should run at a time on this hardware. See README.md
  in this directory for the memory budget behind that rule.

.EXAMPLE
  .\serve-local-models.ps1 start fast
  .\serve-local-models.ps1 switch smart
  .\serve-local-models.ps1 stop
  .\serve-local-models.ps1 status
  .\serve-local-models.ps1 cmd fast          # print the llama-server command only

  Settings are read from environment variables with the same names as the
  bash script, e.g.  $env:FAST_CTX = 262144; .\serve-local-models.ps1 start fast
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)] [ValidateSet('start', 'switch', 'stop', 'status', 'cmd', 'help')] [string] $Command = 'help',
  [Parameter(Position = 1)] [string] $Profile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Setting([string] $Name, $Default) {
  $v = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrEmpty($v)) { $Default } else { $v }
}

# ---------------------------------------------------------------- settings --
$LlamaServer   = Get-Setting 'LLAMA_SERVER'   'llama-server.exe'
$env:LLAMA_CACHE = Get-Setting 'LLAMA_CACHE'  (Join-Path $env:LOCALAPPDATA 'llama.cpp')
$BindHost      = Get-Setting 'HOST'           '127.0.0.1'
$StateDir      = Get-Setting 'STATE_DIR'      (Join-Path $env:LOCALAPPDATA 'local-models')
$HealthTimeout = [int](Get-Setting 'HEALTH_TIMEOUT' 1800)
$Mtp           = Get-Setting 'MTP'            '1'
$KvType        = Get-Setting 'KV_TYPE'        'q8_0'

$Profiles = @{
  fast = @{
    HF    = Get-Setting 'FAST_HF'    'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL'
    PORT  = Get-Setting 'FAST_PORT'  '8081'
    CTX   = Get-Setting 'FAST_CTX'   '131072'
    NCMOE = Get-Setting 'FAST_NCMOE' '32'
    ALIAS = Get-Setting 'FAST_ALIAS' 'qwen3.6-35b-a3b'
    RAMGB = 15
  }
  smart = @{
    HF    = Get-Setting 'SMART_HF'    'unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL'
    PORT  = Get-Setting 'SMART_PORT'  '8082'
    CTX   = Get-Setting 'SMART_CTX'   '98304'
    NGL   = Get-Setting 'SMART_NGL'   '32'
    ALIAS = Get-Setting 'SMART_ALIAS' 'qwen3.8-27b'
    RAMGB = 9
  }
}
$Sampling = @('--temp', '0.6', '--top-p', '0.95', '--top-k', '20', '--min-p', '0.0', '--presence-penalty', '0', '--repeat-penalty', '1')

# ------------------------------------------------------------------ helpers --
function Assert-Profile([string] $p) {
  if ($p -notin @('fast', 'smart')) { throw "profile must be 'fast' or 'smart' (got '$p')" }
}
function Get-Other([string] $p) { if ($p -eq 'fast') { 'smart' } else { 'fast' } }
function Get-PidFile([string] $p) { Join-Path $StateDir "$p.pid" }
function Get-LogFile([string] $p) { Join-Path $StateDir "$p.log" }

function Get-RunningPid([string] $p) {
  $f = Get-PidFile $p
  if (-not (Test-Path $f)) { return $null }
  $procId = [int](Get-Content $f -Raw).Trim()
  if (Get-Process -Id $procId -ErrorAction SilentlyContinue) { return $procId }
  Remove-Item $f -Force; return $null
}

function Test-Healthy([string] $p) {
  try {
    $r = Invoke-RestMethod -Uri "http://$BindHost`:$($Profiles[$p].PORT)/health" -TimeoutSec 2
    return ($r.status -eq 'ok')
  } catch { return $false }
}

function Build-Command([string] $p) {
  $c = $Profiles[$p]
  $argList = @('-hf', $c.HF, '--alias', $c.ALIAS, '--host', $BindHost, '--port', $c.PORT,
               '-c', $c.CTX, '-fa', 'on', '--jinja',
               '--cache-type-k', $KvType, '--cache-type-v', $KvType, '--parallel', '1')
  if ($p -eq 'fast') { $argList += @('-ngl', '999', '--n-cpu-moe', $c.NCMOE) } else { $argList += @('-ngl', $c.NGL) }
  if ($Mtp -eq '1') { $argList += @('--spec-type', 'draft-mtp', '--spec-draft-n-max', '2') }
  $argList += $Sampling
  $extra = Get-Setting 'EXTRA_ARGS' ''
  if ($extra) { $argList += ($extra -split '\s+' | Where-Object { $_ }) }
  return $argList
}

function Show-Memory {
  $os = Get-CimInstance Win32_OperatingSystem
  '{0,-5}total {1,5:N1} GB   available {2,5:N1} GB' -f 'RAM', ($os.TotalVisibleMemorySize / 1MB), ($os.FreePhysicalMemory / 1MB)
  if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader,nounits 2>$null | ForEach-Object {
      $f = $_ -split ',\s*'
      'VRAM {0}   total {1,5:N1} GB   used {2,5:N1} GB' -f $f[0], ([double]$f[1] / 1024), ([double]$f[2] / 1024)
    }
  }
}

function Warn-Ram([string] $p) {
  $os = Get-CimInstance Win32_OperatingSystem
  $availGb = [math]::Floor($os.FreePhysicalMemory / 1MB)
  $need = $Profiles[$p].RAMGB
  if ($availGb -lt ($need + 4)) {
    Write-Warning "$p needs about $need GB of RAM and only $availGb GB is available. Leave ~4 GB for Claude Code and the OS."
  }
}

# ----------------------------------------------------------------- commands --
function Start-Profile([string] $p) {
  Assert-Profile $p
  if (-not (Get-Command $LlamaServer -ErrorAction SilentlyContinue) -and -not (Test-Path $LlamaServer)) {
    throw "llama-server not found. Set `$env:LLAMA_SERVER to the full path of llama-server.exe"
  }
  New-Item -ItemType Directory -Force -Path $StateDir, $env:LLAMA_CACHE | Out-Null

  $existing = Get-RunningPid $p
  if ($existing) { Write-Host "==> $p already running (pid $existing) on port $($Profiles[$p].PORT)"; return }
  $other = Get-Other $p
  if ((Get-RunningPid $other) -and ((Get-Setting 'FORCE' '0') -ne '1')) {
    throw "$other is running. On 12 GB VRAM / 32 GB RAM the two profiles do not fit together. Use 'switch $p', or set FORCE=1 to override."
  }

  Warn-Ram $p
  $argList = Build-Command $p
  $log = Get-LogFile $p
  Write-Host "==> starting $p on http://$BindHost`:$($Profiles[$p].PORT)  (log: $log)"
  Write-Host ("{0} {1}" -f $LlamaServer, ($argList -join ' '))
  $proc = Start-Process -FilePath $LlamaServer -ArgumentList $argList -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  Set-Content -Path (Get-PidFile $p) -Value $proc.Id

  Write-Host "==> waiting for /health (first run downloads the model into $env:LLAMA_CACHE, this can take a while)"
  $waited = 0
  while (-not (Test-Healthy $p)) {
    if ($proc.HasExited) {
      Remove-Item (Get-PidFile $p) -Force -ErrorAction SilentlyContinue
      Get-Content "$log.err" -Tail 30 -ErrorAction SilentlyContinue | Write-Host
      throw "$p exited before becoming healthy. If it ran out of VRAM, raise FAST_NCMOE (fast) or lower SMART_NGL (smart)."
    }
    if ($waited -ge $HealthTimeout) {
      Write-Host "`n==> still loading after ${HealthTimeout}s; leaving it running. Follow: Get-Content -Wait $log"; return
    }
    Start-Sleep -Seconds 5; $waited += 5; Write-Host -NoNewline '.'
  }
  Write-Host "`n==> $p is ready: http://$BindHost`:$($Profiles[$p].PORT)/v1  model id: $($Profiles[$p].ALIAS)"
}

function Stop-Profile([string[]] $targets) {
  if (-not $targets -or -not $targets[0] -or $targets[0] -eq 'all') { $targets = @('fast', 'smart') }
  foreach ($p in $targets) {
    Assert-Profile $p
    $procId = Get-RunningPid $p
    if (-not $procId) { Write-Host "==> $p not running"; continue }
    Write-Host "==> stopping $p (pid $procId)"
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    Remove-Item (Get-PidFile $p) -Force -ErrorAction SilentlyContinue
  }
}

function Show-Status {
  foreach ($p in @('fast', 'smart')) {
    $procId = Get-RunningPid $p
    if ($procId) {
      if (Test-Healthy $p) { '{0,-5} running  pid {1,-7} http://{2}:{3}/v1  ({4})' -f $p, $procId, $BindHost, $Profiles[$p].PORT, $Profiles[$p].HF }
      else { '{0,-5} loading  pid {1,-7} (not healthy yet, see {2})' -f $p, $procId, (Get-LogFile $p) }
    } else { '{0,-5} stopped' -f $p }
  }
  Show-Memory
}

switch ($Command) {
  'start'  { if (-not $Profile) { throw 'start needs a profile' }; Start-Profile $Profile }
  'switch' { if (-not $Profile) { throw 'switch needs a profile' }; Assert-Profile $Profile; Stop-Profile @(Get-Other $Profile); Start-Profile $Profile }
  'stop'   { Stop-Profile @($Profile) }
  'status' { Show-Status }
  'cmd'    { if (-not $Profile) { throw 'cmd needs a profile' }; Assert-Profile $Profile; "{0} {1}" -f $LlamaServer, ((Build-Command $Profile) -join ' ') }
  default  { Get-Help $PSCommandPath -Detailed }
}
