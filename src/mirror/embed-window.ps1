param(
    [Parameter(Mandatory = $true)][ValidateSet('embed', 'move', 'focus', 'calibrate')][string]$Action,
    [string]$Title = '',
    [string]$ProcessId = '',
    [string]$Hwnd = '',
    [string]$ParentHwnd = '',
    [int]$X = 0,
    [int]$Y = 0,
    [int]$W = 0,
    [int]$H = 0
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class UW {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
    [DllImport("user32.dll")]
    public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")]
    public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
public struct RECT { public int Left, Top, Right, Bottom; }
public struct POINT { public int X, Y; }
"@

# Make coordinate interpretation deterministic regardless of the caller's default
# DPI awareness. Prefer per-monitor v2, fall back to system-aware.
try {
    [void][UW]::SetProcessDpiAwarenessContext([IntPtr](-4))
} catch {
    try { [void][UW]::SetProcessDPIAware() } catch { }
}

$script:matchByTitle = [IntPtr]::Zero
$script:firstVisible = [IntPtr]::Zero

$callback = [UW+EnumProc]{
    param($h, $l)
    $sb = New-Object System.Text.StringBuilder 512
    [void][UW]::GetWindowTextW($h, $sb, 512)
    $winTitle = $sb.ToString()
    $winPid = 0
    [void][UW]::GetWindowThreadProcessId($h, [ref]$winPid)
    if ($winPid -eq $script:targetPid -and [UW]::IsWindowVisible($h)) {
        if ($script:firstVisible -eq [IntPtr]::Zero) { $script:firstVisible = $h }
        if ($script:targetTitle -ne '' -and $winTitle -eq $script:targetTitle) {
            $script:matchByTitle = $h
            return $false
        }
    }
    return $true
}

$target = [IntPtr]::Zero
if ($Hwnd -ne '') {
    $target = New-Object System.IntPtr([long]$Hwnd)
} else {
    $script:targetPid = [int]$ProcessId
    $script:targetTitle = $Title
    [void][UW]::EnumWindows($callback, [IntPtr]::Zero)
    if ($script:matchByTitle -ne [IntPtr]::Zero) { $target = $script:matchByTitle }
    elseif ($script:firstVisible -ne [IntPtr]::Zero) { $target = $script:firstVisible }
}

if ($target -eq [IntPtr]::Zero -or -not [UW]::IsWindow($target)) {
    Write-Output 'NOT_FOUND'
    exit 2
}

$parentPtr = [IntPtr]::Zero
if ($ParentHwnd -ne '') {
    $parentPtr = New-Object System.IntPtr([long]$ParentHwnd)
}

if ($Action -eq 'embed') {
    if ($parentPtr -ne [IntPtr]::Zero) {
        [void][UW]::SetParent($target, $parentPtr)
    }
    if ($W -gt 0 -and $H -gt 0) {
        [void][UW]::MoveWindow($target, $X, $Y, $W, $H, $true)
    }
    # A SetParent'd window lands at the BOTTOM of the parent's child Z-order,
    # behind Chromium's webview -> invisible. Raise it above the web content.
    # SWP_NOSIZE(1) | SWP_NOMOVE(2) | SWP_NOACTIVATE(0x10) | SWP_SHOWWINDOW(0x40)
    [void][UW]::SetWindowPos($target, [IntPtr]::Zero, 0, 0, 0, 0, 0x53)
} elseif ($Action -eq 'move') {
    [void][UW]::MoveWindow($target, $X, $Y, $W, $H, $true)
    # Keep it above the webview (SDL may re-order on resize/first frame).
    [void][UW]::SetWindowPos($target, [IntPtr]::Zero, 0, 0, 0, 0, 0x53)
} elseif ($Action -eq 'focus') {
    [void][UW]::SetForegroundWindow($target)
} elseif ($Action -eq 'calibrate') {
    if ($parentPtr -eq [IntPtr]::Zero) {
        Write-Output 'NOT_FOUND'
        exit 2
    }
    $client = New-Object RECT
    [void][UW]::GetClientRect($parentPtr, [ref]$client)
    $origin = New-Object POINT
    [void][UW]::ClientToScreen($parentPtr, [ref]$origin)
    $child = New-Object RECT
    [void][UW]::GetWindowRect($target, [ref]$child)
    $x = $child.Left - $origin.X
    $y = $child.Top - $origin.Y
    $w = $child.Right - $child.Left
    $h = $child.Bottom - $child.Top
    Write-Output ("OK {0} {1} {2} {3}" -f $x, $y, $w, $h)
    exit 0
}

Write-Output ("OK {0}" -f $target.ToInt64())
