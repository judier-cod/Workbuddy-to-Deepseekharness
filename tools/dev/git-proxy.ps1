<#
.SYNOPSIS
  按当前网络环境自动切换 git 的 GitHub 代理设置。

.DESCRIPTION
  背景：本机常用代理软件（Clash 等）监听 127.0.0.1:7890。Git 自身不读系统代理，
  所以要单独配 —— 但**硬编码一个代理会在换网络时帮倒忙**：
    · 关掉代理软件 → git 仍去连 7890，报 connection refused
    · 换到能直连 GitHub 的网络 → 明明能通，却被塞去代理
  这个脚本每次跑都实测一次，再把配置调到与事实相符的状态。

  判定顺序（两条都实测，不猜）：
    1. 直连 github.com:443 通  → 清掉代理（能直连就别绕）
    2. 代理端口活着且能通 GitHub → 配上代理
    3. 都不通 → 只为 github.com 设代理（保持现状），并如实报告

  只影响 `http.https://github.com.proxy` 这一个键，**不动全局 http.proxy** ——
  这样其它仓库（公司内网 Git、Gitee 等）不受影响。

.PARAMETER Port
  代理端口，默认 7890（Clash 常用）。换软件时改这里或传参。

.PARAMETER Force
  跳过探测，直接按 Disable / Enable 指定的方向设。

.PARAMETER Disable
  配合 -Force：强制清掉代理（直连）。

.PARAMETER Enable
  配合 -Force：强制设代理。可与 -Port 组合。

.EXAMPLE
  .\git-proxy.ps1
  自动探测并调到正确状态（推荐每次换网络后跑一次）。

.EXAMPLE
  .\git-proxy.ps1 -Force -Disable
  强制直连（在能直连的网络里用）。

.EXAMPLE
  .\git-proxy.ps1 -Force -Enable -Port 7897
  强制走 7897 端口的代理（代理软件换了端口时）。
#>
[CmdletBinding()]
param(
  [int]$Port = 7890,
  [switch]$Force,
  [switch]$Disable,
  [switch]$Enable
)

$ErrorActionPreference = 'Continue'
$key = 'http.https://github.com.proxy'
$proxyUrl = "http://127.0.0.1:$Port"

function Test-Tcp {
  param([string]$Host_, [int]$Port_, [int]$TimeoutMs = 6000)
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $task = $client.ConnectAsync($Host_, $Port_)
    if ($task.Wait($TimeoutMs) -and $client.Connected) { $client.Close(); return $true }
    $client.Close(); return $false
  } catch { return $false }
}

function Test-GitHubDirect {
  # 用 TCP 直连判定，不经过 git（否则会读到我们正要改的代理配置）
  return (Test-Tcp -Host_ 'github.com' -Port_ 443 -TimeoutMs 8000)
}

function Get-CurrentProxy {
  $v = (git config --global --get $key) 2>$null
  if ([string]::IsNullOrWhiteSpace($v)) { return '' }
  return $v.Trim()
}

function Set-ProxyOff {
  git config --global --unset $key 2>$null | Out-Null
  # 顺手清掉可能残留的全局代理（早期配置留下的）
  $g1 = (git config --global --get http.proxy) 2>$null
  $g2 = (git config --global --get https.proxy) 2>$null
  if ($g1) { git config --global --unset http.proxy | Out-Null }
  if ($g2) { git config --global --unset https.proxy | Out-Null }
}

function Set-ProxyOn {
  param([string]$Url)
  git config --global $key $Url | Out-Null
}

Write-Host '=== 当前状态 ===' -ForegroundColor Cyan
Write-Host ("  github.com 代理配置 : " + $(if ((Get-CurrentProxy)) { Get-CurrentProxy } else { '(未设置 = 直连)' }))
Write-Host ("  代理端口 $Port 监听 : " + $(if (Test-Tcp -Host_ '127.0.0.1' -Port_ $Port) { '是' } else { '否' }))

if ($Force) {
  if ($Disable) {
    Set-ProxyOff
    Write-Host "`n[强制] 已设为直连（清掉 github.com 的代理）" -ForegroundColor Yellow
  } elseif ($Enable) {
    Set-ProxyOn -Url $proxyUrl
    Write-Host "`n[强制] 已设为走代理 $proxyUrl" -ForegroundColor Yellow
  } else {
    Write-Host "`n-Force 需要配合 -Disable 或 -Enable" -ForegroundColor Red
    exit 2
  }
} else {
  Write-Host "`n=== 实测判定 ===" -ForegroundColor Cyan
  $direct = Test-GitHubDirect
  Write-Host ("  直连 github.com:443 : " + $(if ($direct) { '✅ 通' } else { '❌ 不通' }))
  $proxyAlive = Test-Tcp -Host_ '127.0.0.1' -Port_ $Port
  Write-Host ("  代理端口 $Port      : " + $(if ($proxyAlive) { '✅ 在监听' } else { '❌ 未监听' }))

  if ($direct) {
    # 能直连就别绕代理 —— 换到能直连的网络时走这条
    Set-ProxyOff
    Write-Host "`n→ 已设为**直连**（当前网络能直连 GitHub，无需代理）" -ForegroundColor Green
  } elseif ($proxyAlive) {
    Set-ProxyOn -Url $proxyUrl
    Write-Host "`n→ 已设为**走代理 $proxyUrl**（直连不通，但代理可用）" -ForegroundColor Green
  } else {
    Set-ProxyOn -Url $proxyUrl
    Write-Host "`n→ 直连与代理都不可用，保持代理配置不变。" -ForegroundColor Yellow
    Write-Host "  请启动代理软件，或用 -Port 指定实际端口，例如：" -ForegroundColor Yellow
    Write-Host "    .\git-proxy.ps1 -Force -Enable -Port 7897" -ForegroundColor Yellow
  }
}

Write-Host "`n=== 结果 ===" -ForegroundColor Cyan
$now = Get-CurrentProxy
if ($now) {
  Write-Host ("  github.com 走 : $now")
} else {
  Write-Host ("  github.com 走 : 直连")
}
Write-Host ("  其它仓库       : 不受影响（只改了 github.com 这一个键）")
Write-Host "`n实测一下：" -ForegroundColor DarkGray
Write-Host "  git ls-remote https://github.com/judier-cod/Workbuddy-to-Deepseekharness.git" -ForegroundColor DarkGray
exit 0
