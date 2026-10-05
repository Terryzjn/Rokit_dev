Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 找到 Rokit 主窗口
$signature = @'
[DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
[DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
[DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
'@
Add-Type -MemberDefinition $signature -Name "Win32Util" -Namespace "Native" -UsingNamespace System.Text

# 枚举所有顶层窗口找 Rokit
$rokitHwnd = [IntPtr]::Zero
$callback = {
    param($hWnd, $lParam)
    $sb = New-Object System.Text.StringBuilder 256
    [void][Native.Win32Util]::GetWindowText($hWnd, $sb, 256)
    $title = $sb.ToString()
    if ($title -match 'Rokit') {
        Set-Variable -Name rokitHwnd -Value $hWnd -Scope 1
        return $false
    }
    return $true
}
[void][Native.Win32Util]::EnumWindows($callback, [IntPtr]::Zero)

if ($rokitHwnd -eq [IntPtr]::Zero) {
    Write-Host "[shot] 未找到 Rokit 窗口"
    exit 1
}

Write-Host "[shot] 找到 Rokit 窗口 HWND=$rokitHwnd"

# 获取窗口尺寸
$rect = New-Object Native.Win32Util+RECT
[void][Native.Win32Util]::GetWindowRect($rokitHwnd, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
Write-Host "[shot] 窗口尺寸: ${w}x${h}"

# 用 PrintWindow 截图窗口
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][Native.Win32Util]::PrintWindow($rokitHwnd, $hdc, 2)  # PW_RENDERFULLCONTENT = 2
$g.ReleaseHdc($hdc)
$g.Dispose()

$outPath = Join-Path $PSScriptRoot 'shot-app.png'
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "[shot] 已保存 $outPath"