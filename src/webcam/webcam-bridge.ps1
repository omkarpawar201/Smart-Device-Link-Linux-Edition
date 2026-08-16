# webcam-bridge.ps1
#
# Phone-as-webcam frame pump.
#
# Reads JPEG snapshots from the IP Webcam app on the phone
# (http://<phone-ip>:8080/shot.jpg) and pushes decoded RGBA frames into the
# UnityCapture virtual camera shared memory, which DirectShow exposes to any
# meeting app as a selectable capture device ("Phone Camera").
#
# Protocol implemented from schellingb/UnityCapture Source/shared.inl
# (default single-device install => cap number 0 => object names have no digit):
#   mutex        UnityCapture_Mutx   (open; absent => no app is capturing)
#   event WANT   UnityCapture_Want   (create)
#   event SENT   UnityCapture_Sent   (open)
#   file mapping UnityCapture_Data   (open + map view)
#   header: int maxSize, width, height, stride, format, resizemode, mirrormode,
#           timeout  (data starts at byte 32)
#   pixels: RGBA8, vertically flipped (row 0 of the buffer is the bottom row).
#
# Long-running process. Reports state over stderr as "[STATUS] ..." lines,
# the same convention rfcomm-bridge.ps1 uses.

param(
    [string]$Url = '',
    [string]$User = '',
    [string]$Pass = '',
    [int]$Fps = 12,
    [int]$CapNum = 0,
    [string]$LastFrame = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$csharp = @'
using System;
using System.Runtime.InteropServices;
using System.IO;
using System.Net;
using System.Drawing;
using System.Drawing.Imaging;

public static class HttpFetcher
{
    public static byte[] GetBytes(string url, string user, string pass, int timeoutMs)
    {
        HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
        req.Method = "GET";
        req.Timeout = timeoutMs;
        req.ReadWriteTimeout = timeoutMs;
        req.AllowAutoRedirect = true;
        req.Proxy = null; // never route LAN phone requests through a system proxy
        req.KeepAlive = false;
        if (!string.IsNullOrEmpty(user))
        {
            req.Credentials = new NetworkCredential(user, pass);
            req.PreAuthenticate = true;
        }
        using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
        {
            if ((int)resp.StatusCode >= 400) throw new WebException("HTTP " + (int)resp.StatusCode);
            using (MemoryStream ms = new MemoryStream())
            {
                resp.GetResponseStream().CopyTo(ms);
                return ms.ToArray();
            }
        }
    }
}

public static class JpegDecoder
{
    public static bool TryDecodeToRgba(byte[] jpeg, out int width, out int height, out byte[] rgba)
    {
        width = 0; height = 0; rgba = null;
        try
        {
            using (MemoryStream ms = new MemoryStream(jpeg))
            using (Bitmap bmp = new Bitmap(ms))
            {
                width = bmp.Width; height = bmp.Height;
                Rectangle rect = new Rectangle(0, 0, width, height);
                BitmapData data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                try
                {
                    int stride = data.Stride;
                    byte[] bgra = new byte[stride * height];
                    Marshal.Copy(data.Scan0, bgra, 0, bgra.Length);
                    rgba = new byte[width * height * 4];
                    // BGRA -> RGBA + vertical flip (UnityCapture renders row 0 at the bottom).
                    int srcRow = (height - 1) * stride;
                    for (int y = 0; y < height; y++)
                    {
                        int dst = y * width * 4;
                        int src = srcRow;
                        for (int x = 0; x < width; x++)
                        {
                            rgba[dst] = bgra[src + 2];
                            rgba[dst + 1] = bgra[src + 1];
                            rgba[dst + 2] = bgra[src];
                            rgba[dst + 3] = 255;
                            dst += 4; src += 4;
                        }
                        srcRow -= stride;
                    }
                }
                finally { bmp.UnlockBits(data); }
                return true;
            }
        }
        catch { return false; }
    }
}

public class UnityCaptureClient
{
    const uint SYNCHRONIZE = 0x00100000;
    const uint EVENT_MODIFY_STATE = 0x0002;
    const uint FILE_MAP_WRITE = 0x0002;
    const uint INFINITE = 0xFFFFFFFF;
    const int FORMAT_UINT8 = 0;
    const int RESIZEMODE_LINEAR = 1;
    const int MIRRORMODE_DISABLED = 0;

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    static extern IntPtr OpenMutexA(uint dwDesiredAccess, bool bInheritHandle, string lpName);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    static extern IntPtr CreateEventA(IntPtr lpEventAttributes, bool bManualReset, bool bInitialState, string lpName);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    static extern IntPtr OpenEventA(uint dwDesiredAccess, bool bInheritHandle, string lpName);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    static extern IntPtr OpenFileMappingA(uint dwDesiredAccess, bool bInheritHandle, string lpName);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr MapViewOfFile(IntPtr hFileMappingObject, uint dwDesiredAccess, uint dwFileOffsetHigh, uint dwFileOffsetLow, UIntPtr dwNumberOfBytesToMap);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UnmapViewOfFile(IntPtr lpBaseAddress);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReleaseMutex(IntPtr hMutex);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetEvent(IntPtr hEvent);

    string _prefix;
    IntPtr _mutex = IntPtr.Zero;
    IntPtr _want = IntPtr.Zero;
    IntPtr _sent = IntPtr.Zero;
    IntPtr _file = IntPtr.Zero;
    IntPtr _base = IntPtr.Zero;

    public UnityCaptureClient(int capNum)
    {
        _prefix = (capNum > 0) ? ("UnityCapture_" + capNum) : "UnityCapture_";
    }

    public bool IsReady()
    {
        if (_mutex == IntPtr.Zero) _mutex = OpenMutexA(SYNCHRONIZE, false, _prefix + "Mutx");
        return _mutex != IntPtr.Zero;
    }

    public bool Open()
    {
        if (_base != IntPtr.Zero) return true;
        if (_mutex == IntPtr.Zero) return false;
        if (_want == IntPtr.Zero) _want = CreateEventA(IntPtr.Zero, false, false, _prefix + "Want");
        if (_sent == IntPtr.Zero) _sent = OpenEventA(EVENT_MODIFY_STATE, false, _prefix + "Sent");
        if (_file == IntPtr.Zero) _file = OpenFileMappingA(FILE_MAP_WRITE, false, _prefix + "Data");
        if (_want == IntPtr.Zero || _sent == IntPtr.Zero || _file == IntPtr.Zero) return false;
        _base = MapViewOfFile(_file, FILE_MAP_WRITE, 0, 0, UIntPtr.Zero);
        return _base != IntPtr.Zero;
    }

    public bool Send(int width, int height, byte[] rgba)
    {
        if (_base == IntPtr.Zero) return false;
        int maxSize = Marshal.ReadInt32(_base, 0);
        int dataSize = width * height * 4;
        if (maxSize <= 0 || maxSize < dataSize) return false;
        WaitForSingleObject(_mutex, INFINITE);
        try
        {
            Marshal.WriteInt32(_base, 4, width);
            Marshal.WriteInt32(_base, 8, height);
            Marshal.WriteInt32(_base, 12, width);          // stride (pixels)
            Marshal.WriteInt32(_base, 16, FORMAT_UINT8);   // 8-bit RGBA
            Marshal.WriteInt32(_base, 20, RESIZEMODE_LINEAR);
            Marshal.WriteInt32(_base, 24, MIRRORMODE_DISABLED);
            Marshal.WriteInt32(_base, 28, int.MaxValue - 200); // keep last frame
            Marshal.Copy(rgba, 0, (IntPtr)(_base.ToInt64() + 32), dataSize);
        }
        finally { ReleaseMutex(_mutex); }
        SetEvent(_sent);
        return true;
    }

    public void Close()
    {
        if (_base != IntPtr.Zero) { UnmapViewOfFile(_base); _base = IntPtr.Zero; }
        if (_file != IntPtr.Zero) { CloseHandle(_file); _file = IntPtr.Zero; }
        if (_want != IntPtr.Zero) { CloseHandle(_want); _want = IntPtr.Zero; }
        if (_sent != IntPtr.Zero) { CloseHandle(_sent); _sent = IntPtr.Zero; }
        if (_mutex != IntPtr.Zero) { CloseHandle(_mutex); _mutex = IntPtr.Zero; }
    }
}
'@

Add-Type -TypeDefinition $csharp -ReferencedAssemblies @('System.Drawing')

function Write-Status([string]$msg) {
    [Console]::Error.WriteLine('[STATUS] ' + $msg)
}

if (-not $Url) {
    Write-Status 'error no-url'
    exit 1
}

if ($LastFrame -and (Test-Path -LiteralPath $LastFrame)) {
    try { Remove-Item -LiteralPath $LastFrame -Force } catch { }
}

$client = New-Object UnityCaptureClient($CapNum)

$frameCount = 0
$windowStart = [Environment]::TickCount
$windowFrames = 0
$lastFeedError = 0
$feedWasDown = $false
$idleReported = $false
$intervalMs = [Math]::Max(20, [Math]::Floor(1000 / [Math]::Max(1, $Fps)))

Write-Status "ready cap=$CapNum url=$Url fps=$Fps"

try {
    while ($true) {
        $consumerActive = $client.IsReady()
        if (-not $consumerActive -or -not $client.Open()) {
            if (-not $idleReported) { Write-Status 'idle'; $idleReported = $true }
        } else {
            if ($idleReported) { Write-Status 'consumer'; $idleReported = $false }
        }

        $frameStart = [Environment]::TickCount
        try {
            $jpeg = [HttpFetcher]::GetBytes($Url, $User, $Pass, 2500)
        } catch {
            $feedWasDown = $true
            $now = [Environment]::TickCount
            if ($now - $lastFeedError -gt 4000) {
                Write-Status "feed-down $($_.Exception.Message)"
                $lastFeedError = $now
            }
            Start-Sleep -Milliseconds 300
            continue
        }

        if ($feedWasDown) { Write-Status 'feed-up'; $feedWasDown = $false }

        if ($LastFrame) {
            try { [System.IO.File]::WriteAllBytes($LastFrame, $jpeg) } catch { }
        }

        $w = 0; $h = 0; $rgba = $null
        $ok = [JpegDecoder]::TryDecodeToRgba($jpeg, [ref]$w, [ref]$h, [ref]$rgba)
        if (-not $ok) {
            Start-Sleep -Milliseconds 150
            continue
        }

        # Feed UnityCapture only while a consumer is capturing; the preview
        # frame file is still written (and frames counted) either way.
        if ($consumerActive) {
            $null = $client.Send($w, $h, $rgba)
        }
        $frameCount++
        $windowFrames++

        $elapsed = [Environment]::TickCount - $frameStart
        $sleep = $intervalMs - $elapsed
        if ($sleep -gt 0) { Start-Sleep -Milliseconds $sleep }

        if ([Environment]::TickCount - $windowStart -ge 1000) {
            $dur = [Environment]::TickCount - $windowStart
            $fps = [Math]::Round(($windowFrames * 1000.0) / [Math]::Max(1, $dur), 1)
            Write-Status "frames $frameCount fps $fps size ${w}x${h}"
            $windowStart = [Environment]::TickCount
            $windowFrames = 0
        }
    }
}
finally {
    if ($client) { $client.Close() }
}
