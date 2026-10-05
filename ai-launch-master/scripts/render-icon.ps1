#Requires -Version 5.1
<#
.SYNOPSIS
  编译并执行 IconRenderer.cs，生成 1024×1024 深色/亮色 PNG icon。

.DESCRIPTION
  自动发现 csc.exe（顺序：-CscPath 参数 → %WINDIR%\Framework64\v4.0.30319 →
  %ProgramFiles%\dotnet\sdk\*\Roslyn\bincore），避免硬编码单一路径在
  .NET-only / .NET 8 SDK-only / PowerShell 7+ 环境下失效。
  编译与运行都用 $LASTEXITCODE 判断，失败时返回非零值给调用方。

.PARAMETER CscPath
  可选：csc.exe 的绝对路径。未提供则按上述顺序自动发现。

.PARAMETER Root
  可选：项目根目录（含 assets/ 与 scripts/）。默认取脚本上一层。

.EXAMPLE
  powershell -File scripts/render-icon.ps1
  powershell -File scripts/render-icon.ps1 -CscPath "C:\Program Files\dotnet\sdk\8.0.100\Roslyn\bincore\csc.exe"
#>
param(
  [string]$CscPath,
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'

$ASSETS = Join-Path $Root 'assets'
$SCRIPTS = Join-Path $Root 'scripts'
$CS_FILE = Join-Path $SCRIPTS 'IconRenderer.cs'
$EXE_FILE = Join-Path $SCRIPTS 'IconRenderer.exe'
$DARK = Join-Path $ASSETS 'icon.png'
$LIGHT = Join-Path $ASSETS 'icon-light.png'

# ---- 自动发现 csc.exe ----
if (-not $CscPath) {
  $candidates = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    "${env:ProgramFiles}\dotnet\sdk\*\Roslyn\bincore\csc.exe"
  )
  foreach ($p in $candidates) {
    $resolved = $null
    if ($p.Contains('*')) {
      $resolved = Get-Item $p -ErrorAction SilentlyContinue | Select-Object -First 1
    } elseif (Test-Path $p) {
      $resolved = Get-Item $p
    }
    if ($resolved) {
      $CscPath = $resolved.FullName
      break
    }
  }
}
if (-not $CscPath) {
  Write-Error "[render-icon] 找不到 csc.exe。请安装 .NET Framework 4.x 或 .NET SDK，或用 -CscPath 显式传入"
  exit 2
}
Write-Host "[render-icon] using csc: $CscPath"

if (-not (Test-Path $CS_FILE)) {
  Write-Error "[render-icon] 源文件缺失: $CS_FILE"
  exit 2
}

# ---- 编译 ----
$refPres = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\WPF\PresentationCore.dll"
$refFw   = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\WPF\PresentationFramework.dll"
$refWb   = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\WPF\WindowsBase.dll"
$refXaml = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\System.Xaml.dll"

Write-Host "[render-icon] compiling $CS_FILE"
& $CscPath /nologo /target:exe /out:$EXE_FILE `
  /reference:$refPres `
  /reference:$refFw `
  /reference:$refWb `
  /reference:$refXaml `
  $CS_FILE
if ($LASTEXITCODE -ne 0) {
  Write-Error "[render-icon] 编译失败 (exit=$LASTEXITCODE)"
  exit $LASTEXITCODE
}
Write-Host "[render-icon] compiled $EXE_FILE"

# ---- 渲染（PowerShell 默认 MTA；启动的 exe 自身标了 [STAThread]，独立 STA 线程自洽）----
Write-Host "[render-icon] generating PNG..."
& $EXE_FILE $DARK $LIGHT
if ($LASTEXITCODE -ne 0) {
  Write-Error "[render-icon] 渲染失败 (exit=$LASTEXITCODE)"
  exit $LASTEXITCODE
}
Write-Host "[render-icon] done"