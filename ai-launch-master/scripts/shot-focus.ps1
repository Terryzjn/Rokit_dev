Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$signature = @'
[DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
public const byte VK_TAB = 0x09;
public const uint KEYEVENTF_KEYUP = 0x0002;
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
'@
Add-Type -MemberDefinition $signature -Name "FocusUtil" -Namespace "Native3" -UsingNamespace System.Text

# 找 Rokit 窗口
$rokitHwnd = [IntPtr]::Zero
$cb = { param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [void][Native3.FocusUtil]::GetWindowText($h, $sb, 256)
  if ($sb.ToString() -match 'Rokit') { Set-Variable -Name rokitHwnd -Value $h -Scope 1; return $false }
  return $true
}
[void][Native3.FocusUtil]::EnumWindows($cb, [IntPtr]::Zero)
if ($rokitHwnd -eq [IntPtr]::Zero) { Write-Host "[focus] 未找到 Rokit"; exit 1 }
Write-Host "[focus] HWND=$rokitHwnd"

# 把 Rokit 窗口设为前台
[void][Native3.FocusUtil]::ShowWindow($rokitHwnd, 9)  # SW_RESTORE = 9
[void][Native3.FocusUtil]::SetForegroundWindow($rokitHwnd)
Start-Sleep -Milliseconds 400

# 多次 Tab 键聚焦窗口控制按钮（从 titleBar 焦点开始，Tab 几次后会落在 wc-ctrls 区）
# 顺序大致：titleBar 内的 brand → 首秀向导航 → 数据看板 → ... → wcMin → wcMax → wcClose
for ($i = 0; $i -lt 10; $i++) {
  [Native3.FocusUtil]::keybd_event([Native3.FocusUtil]::VK_TAB, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [Native3.FocusUtil]::keybd_event([Native3.FocusUtil]::VK_TAB, 0, [Native3.FocusUtil]::KEYEVENTF_KEYUP, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 60
}

Start-Sleep -Milliseconds 400

# 截屏
$rect = New-Object Native3.FocusUtil+RECT
[void][Native3.FocusUtil]::GetWindowRect($rokitHwnd, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][Native3.FocusUtil]::PrintWindow($rokitHwnd, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$out = Join-Path $PSScriptRoot 'shot-focus.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "[focus] saved $out"