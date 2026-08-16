$ErrorActionPreference = 'Stop'

# Compile the native helpers once (media keys via user32, real master volume via WASAPI).
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace MediaNative {
    public static class MediaKeys {
        [DllImport("user32.dll")]
        public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

        public const byte VK_NEXT_TRACK = 0xB0;
        public const byte VK_PREV_TRACK = 0xB1;
        public const byte VK_STOP = 0xB2;
        public const byte VK_PLAY_PAUSE = 0xB3;

        public static void Press(byte vk) {
            keybd_event(vk, 0, 0, UIntPtr.Zero);
            keybd_event(vk, 0, 0x0002, UIntPtr.Zero); // KEYEVENTF_KEYUP
        }

        [ComImport]
        [Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioEndpointVolume {
            int RegisterControlChangeNotify(IntPtr pNotify);
            int UnregisterControlChangeNotify(IntPtr pNotify);
            int GetChannelCount(out int pnCount);
            int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
            int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
            int GetMasterVolumeLevel(out float pfLevelDB);
            int GetMasterVolumeLevelScalar(out float pfLevel);
            int SetChannelVolumeLevel(int nChannel, float fLevelDB, ref Guid pguidEventContext);
            int SetChannelVolumeLevelScalar(int nChannel, float fLevel, ref Guid pguidEventContext);
            int GetChannelVolumeLevel(int nChannel, out float pfLevelDB);
            int GetChannelVolumeLevelScalar(int nChannel, out float pfLevel);
            int SetMute(bool bMute, ref Guid pguidEventContext);
            int GetMute(out bool pbMute);
            int GetVolumeStepInfo(out int pnStep, out int pnStepCount);
            int VolumeStepUp(ref Guid pguidEventContext);
            int VolumeStepDown(ref Guid pguidEventContext);
        }

        [ComImport]
        [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDevice {
            int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
            int OpenPropertyStore(int stgmAccess, out IntPtr ppProperties);
            int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
            int GetState(out int pdwState);
        }

        [ComImport]
        [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDeviceEnumerator {
            int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr ppDevices);
            int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
            int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
            int RegisterEndpointNotificationCallback(IntPtr pClient);
            int UnregisterEndpointNotificationCallback(IntPtr pClient);
        }

        [ComImport]
        [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
        private class MMDeviceEnumeratorComObject { }

        private static IAudioEndpointVolume _endpoint = null;

        private static IAudioEndpointVolume Endpoint() {
            if (_endpoint == null) {
                IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(object)new MMDeviceEnumeratorComObject();
                IMMDevice device;
                int hr = enumerator.GetDefaultAudioEndpoint(0 /*eRender*/, 1 /*eMultimedia*/, out device);
                if (hr != 0) throw new Exception("GetDefaultAudioEndpoint failed: 0x" + hr.ToString("X8"));
                Guid iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
                object iface;
                device.Activate(ref iid, 1 /*CLSCTX_INPROC_SERVER*/, IntPtr.Zero, out iface);
                _endpoint = (IAudioEndpointVolume)iface;
            }
            return _endpoint;
        }

        public static int GetVolume() {
            float level;
            Endpoint().GetMasterVolumeLevelScalar(out level);
            return (int)Math.Round(level * 100.0);
        }

        public static void SetVolume(int percent) {
            float level = Math.Max(0, Math.Min(100, percent)) / 100.0f;
            Guid ctx = Guid.Empty;
            Endpoint().SetMasterVolumeLevelScalar(level, ref ctx);
        }

        public static bool GetMute() {
            bool mute;
            Endpoint().GetMute(out mute);
            return mute;
        }

        public static void SetMute(bool mute) {
            Guid ctx = Guid.Empty;
            Endpoint().SetMute(mute, ref ctx);
        }
    }
}
'@
} catch {
    [Console]::Error.WriteLine("ADDTYPE_ERROR: $_")
    exit 1
}

# --- Real media-session control + readback (SMTC). Gives precise Play/Pause/Next/Prev/Stop/Seek
# --- on the actual Windows media session plus real metadata/timeline. Falls back to synthetic
# --- media keys (below) when no session is available.
$script:smctLoaded = $false

function Invoke-AsTask([Type]$resultType, $asyncOperation) {
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 } |
        Select-Object -First 1
    $generic = $method.MakeGenericMethod($resultType)
    return $generic.Invoke($null, @($asyncOperation))
}

# Resolve the SMTC session manager (null when unavailable).
function Get-SmtcManager {
    try {
        if (-not $script:smctLoaded) {
            Add-Type -AssemblyName System.Runtime.WindowsRuntime
            $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
            $script:smctLoaded = $true
        }
        $managerTask = Invoke-AsTask ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync())
        $managerTask.Wait(3000) | Out-Null
        if (-not $managerTask.IsCompleted) { return $null }
        return $managerTask.Result
    } catch {
        return $null
    }
}

# Resolve the current SMTC media session (null when nothing is playing / SMTC unavailable).
function Get-SmtcSession {
    $mgr = Get-SmtcManager
    if ($null -eq $mgr) { return $null }
    try {
        return $mgr.GetCurrentSession()
    } catch {
        return $null
    }
}

# Resolve the session that is actually producing sound (PlaybackStatus Playing), if any.
# With several registered sessions a stale/paused one can otherwise swallow commands meant
# for the real audio source (e.g. YouTube in a browser without an SMTC session).
function Get-SmtcPlayingSession {
    $mgr = Get-SmtcManager
    if ($null -eq $mgr) { return $null }
    try {
        foreach ($s in $mgr.GetSessions()) {
            try {
                if ($s.GetPlaybackInfo().PlaybackStatus -eq 4) { return $s }
            } catch { }
        }
    } catch { }
    return $null
}

# Run a session Try*Async() method (TryPlayAsync, TryPauseAsync, TrySeekAsync, ...) to
# completion; returns $true when the operation succeeded.
function Invoke-SmtcAction {
    param(
        [Parameter(Mandatory)]
        [object]$Session,
        [Parameter(Mandatory)]
        [string]$Method,
        [object]$Argument = $null
    )
    try {
        if ($null -eq $Session) { return $false }
        $op = if ($null -eq $Argument) { $Session.$Method() } else { $Session.$Method($Argument) }
        $task = Invoke-AsTask ([bool]) $op
        $task.Wait(3000) | Out-Null
        return ($task.IsCompleted -and $task.Result)
    } catch {
        return $false
    }
}

function Get-PcNowPlaying {
    $result = @{ title = ''; artist = ''; album = ''; playing = $false; pos = 0; length = 0 }
    try {
        # Prefer the session that is actually playing so metadata/state reflect the real
        # audio source when multiple sessions are registered.
        $sess = Get-SmtcPlayingSession
        if ($null -eq $sess) { $sess = Get-SmtcSession }
        if ($null -eq $sess) { return $result }
        $propsTask = Invoke-AsTask ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) ($sess.TryGetMediaPropertiesAsync())
        $propsTask.Wait(3000) | Out-Null
        if (-not $propsTask.IsCompleted) { return $result }
        $props = $propsTask.Result
        $result.title = $props.Title
        $result.artist = $props.Artist
        $result.album = $props.AlbumTitle
        # PlaybackStatus: Closed=0 Opened=1 Changing=2 Stopped=3 Playing=4 Paused=5
        $result.playing = ($sess.GetPlaybackInfo().PlaybackStatus -eq 4)
        try {
            $tl = $sess.GetTimelineProperties()
            $result.pos = [long]$tl.Position.TotalMilliseconds
            $result.length = [long]$tl.EndTime.TotalMilliseconds
        } catch { }
    } catch {
        # SMTC unavailable or request failed; return the empty defaults.
    }
    return $result
}

# Signal readiness, then serve one command per stdin line.
[Console]::Out.WriteLine("ready")
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0) { continue }

    $parts = $trimmed -split ' ', 2
    $cmd = $parts[0]
    try {
        switch ($cmd) {
            'playpause' {
                $sess = Get-SmtcPlayingSession
                if ($null -eq $sess) { $sess = Get-SmtcSession }
                if (-not (Invoke-SmtcAction $sess 'TryTogglePlayPauseAsync')) { [MediaNative.MediaKeys]::Press([MediaNative.MediaKeys]::VK_PLAY_PAUSE) }
                [Console]::Out.WriteLine("ok")
            }
            'play'      {
                $sess = Get-SmtcPlayingSession
                if ($null -eq $sess) { $sess = Get-SmtcSession }
                if (-not (Invoke-SmtcAction $sess 'TryPlayAsync')) { [MediaNative.MediaKeys]::Press([MediaNative.MediaKeys]::VK_PLAY_PAUSE) }
                [Console]::Out.WriteLine("ok")
            }
            'pause'     {
                # Only pause a session that is actually producing sound; if none is visible
                # (e.g. a browser tab), fall back to the system media key so the real audio
                # source pauses instead of a stale already-paused session no-op'ing.
                $sess = Get-SmtcPlayingSession
                if (-not (Invoke-SmtcAction $sess 'TryPauseAsync')) { [MediaNative.MediaKeys]::Press([MediaNative.MediaKeys]::VK_PLAY_PAUSE) }
                [Console]::Out.WriteLine("ok")
            }
            'next'      {
                $sess = Get-SmtcPlayingSession
                if ($null -eq $sess) { $sess = Get-SmtcSession }
                if (-not (Invoke-SmtcAction $sess 'TrySkipNextAsync')) { [MediaNative.MediaKeys]::Press([MediaNative.MediaKeys]::VK_NEXT_TRACK) }
                [Console]::Out.WriteLine("ok")
            }
            'prev'      {
                $sess = Get-SmtcPlayingSession
                if ($null -eq $sess) { $sess = Get-SmtcSession }
                if (-not (Invoke-SmtcAction $sess 'TrySkipPreviousAsync')) { [MediaNative.MediaKeys]::Press([MediaNative.MediaKeys]::VK_PREV_TRACK) }
                [Console]::Out.WriteLine("ok")
            }
            'stop'      {
                $sess = Get-SmtcPlayingSession
                if ($null -eq $sess) { $sess = Get-SmtcSession }
                if (-not (Invoke-SmtcAction $sess 'TryStopAsync')) { [MediaNative.MediaKeys]::Press([MediaNative.MediaKeys]::VK_STOP) }
                [Console]::Out.WriteLine("ok")
            }
            'getvol'    { [Console]::Out.WriteLine("vol=$([MediaNative.MediaKeys]::GetVolume());mute=$([MediaNative.MediaKeys]::GetMute())") }
            'setvol'    {
                $v = [int]($parts[1])
                [MediaNative.MediaKeys]::SetVolume($v)
                [Console]::Out.WriteLine("vol=$([MediaNative.MediaKeys]::GetVolume());mute=$([MediaNative.MediaKeys]::GetMute())")
            }
            'mute'      { [MediaNative.MediaKeys]::SetMute(-not [MediaNative.MediaKeys]::GetMute()); [Console]::Out.WriteLine("ok") }
            'getnp'     {
                $np = Get-PcNowPlaying
                [Console]::Out.WriteLine("np_title=$([System.Uri]::EscapeDataString($np.title));np_artist=$([System.Uri]::EscapeDataString($np.artist));np_album=$([System.Uri]::EscapeDataString($np.album));playing=$($np.playing);pos=$($np.pos);length=$($np.length)")
            }
            # Relative seek: jump the current track by <ms>.
            'seek'      {
                $ms = [long]($parts[1])
                $sess = Get-SmtcSession
                if ($null -ne $sess) {
                    try {
                        $tl = $sess.GetTimelineProperties()
                        $target = [Math]::Max(0, [Math]::Min([long]$tl.EndTime.TotalMilliseconds, [long]$tl.Position.TotalMilliseconds + $ms))
                        # TryChangePlaybackPositionAsync takes the position in 100ns ticks.
                        $null = Invoke-SmtcAction $sess 'TryChangePlaybackPositionAsync' ([TimeSpan]::FromMilliseconds($target).Ticks)
                        [Console]::Out.WriteLine("ok")
                    } catch {
                        [Console]::Out.WriteLine("err=seek failed")
                    }
                } else {
                    [Console]::Out.WriteLine("err=seek unavailable")
                }
            }
            # Absolute seek: jump to <ms> within the current track.
            'setpos'    {
                $ms = [long]($parts[1])
                $sess = Get-SmtcSession
                if ($null -ne $sess) {
                    try {
                        $tl = $sess.GetTimelineProperties()
                        $target = [Math]::Max(0, [Math]::Min([long]$tl.EndTime.TotalMilliseconds, $ms))
                        # TryChangePlaybackPositionAsync takes the position in 100ns ticks.
                        $null = Invoke-SmtcAction $sess 'TryChangePlaybackPositionAsync' ([TimeSpan]::FromMilliseconds($target).Ticks)
                        [Console]::Out.WriteLine("ok")
                    } catch {
                        [Console]::Out.WriteLine("err=seek failed")
                    }
                } else {
                    [Console]::Out.WriteLine("err=seek unavailable")
                }
            }
            'quit'      { break }
            default     { [Console]::Out.WriteLine("err=unknown command: $cmd") }
        }
    } catch {
        [Console]::Out.WriteLine("err=$($_.Exception.Message)")
    }
    [Console]::Out.Flush()
}

exit 0
