# install-webcam.ps1
#
# Installs / uninstalls the UnityCapture virtual camera DirectShow filter and
# reports registered devices.
#
# The two UnityCaptureFilter DLLs are vendored in resources/unitycapture/ and
# copied to a stable location (%ProgramData%\PhoneLink\UnityCapture) so the
# registration stays valid across app updates.
#
# Actions:
#   status    - enumerate installed UnityCapture capture devices (no admin needed)
#   install   - copy DLLs + regsvr32 with a custom friendly name (self-elevates)
#   uninstall - unregister + remove DLLs (self-elevates)
#
# install/uninstall write the result to -ResultPath (a temp file the main
# process polls) because the UAC-elevated child cannot pipe stdout back.

param(
    [ValidateSet('status', 'install', 'uninstall')]
    [string]$Action = 'status',
    [string]$Name = 'Phone Camera',
    [int]$Devices = 1,
    [string]$DllDir = '',
    [string]$ResultPath = ''
)

$ErrorActionPreference = 'Stop'

# DirectShow "Video Input Devices" filter category.  Each registered capture
# device appears as an Instance subkey naming the filter's CLSID.
$CATEGORY_GUID = '{860BB310-5D01-11D0-BD3B-00A0C911CE86}'

# UnityCapture service CLSIDs share this prefix (64-bit 0x10-range and 32-bit
# 0x20-range last byte; 0x11/0x21 are the property-page CLSIDs).
$PREFIX = '{5C2CD55C-92AD-4999-8666-912BD3E7'

function Write-Result([string]$text) {
    if ($ResultPath) {
        try { Set-Content -LiteralPath $ResultPath -Value $text -Encoding UTF8 } catch { }
    }
    Write-Output $text
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Enumerates the DirectShow capture-device category in both the 64-bit and
# 32-bit registry views.  Returns [pscustomobject]@{ Name; Clsid; View }.
function Get-DeviceList {
    $found = New-Object System.Collections.Generic.List[object]
    $views = @(
        'HKLM:\SOFTWARE\Classes\CLSID',
        'HKLM:\SOFTWARE\WOW6432Node\Classes\CLSID'
    )
    foreach ($base in $views) {
        $instance = Join-Path $base "$CATEGORY_GUID\Instance"
        if (-not (Test-Path -LiteralPath $instance)) { continue }
        foreach ($sub in Get-ChildItem -LiteralPath $instance) {
            $key = $sub.PSChildName
            if (-not $key.StartsWith($PREFIX, [StringComparison]::OrdinalIgnoreCase)) { continue }
            try {
                $props = Get-ItemProperty -LiteralPath $sub.PSPath
                $name = $props.FriendlyName
                if (-not $name) { $name = $props.'(default)' }
                $found.Add([pscustomobject]@{
                    Name  = $name
                    Clsid = $key
                    View  = if ($base -like '*WOW6432Node*') { '32' } else { '64' }
                }) | Out-Null
            } catch { }
        }
    }
    return ,$found
}

# Copies a vendored DLL into the stable install dir.  If the destination is
# already the right file it is left alone; if it exists but is locked by a
# process that loaded the DirectShow filter, the existing copy is kept (the
# registration step below is what actually matters).
function Update-Dll {
    param([string]$Src, [string]$Dst)
    if (Test-Path -LiteralPath $Dst) {
        try {
            $same = (Get-FileHash -LiteralPath $Dst -Algorithm SHA256).Hash -eq
                    (Get-FileHash -LiteralPath $Src -Algorithm SHA256).Hash
            if ($same) { return }
        } catch { }
        try {
            Copy-Item -LiteralPath $Src -Destination $Dst -Force
            return
        } catch {
            Write-Warning "Could not overwrite $Dst (in use by another process); keeping existing copy."
            return
        }
    }
    Copy-Item -LiteralPath $Src -Destination $Dst -Force
}

if ($Action -eq 'status') {
    $allDevices = Get-DeviceList
    Write-Result ($allDevices | ConvertTo-Json -Compress)
    exit 0
}

# install / uninstall need admin. Self-elevate and wait for the child so the
# caller gets a deterministic exit code.
if (-not (Test-Admin)) {
    $psi = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Action ' + $Action + ' -Name "' + $Name + '" -Devices ' + $Devices
    if ($DllDir)     { $psi += ' -DllDir "' + $DllDir + '"' }
    if ($ResultPath) { $psi += ' -ResultPath "' + $ResultPath + '"' }
    $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList $psi
    exit $p.ExitCode
}

try {
    $installDir = Join-Path $env:ProgramData 'PhoneLink\UnityCapture'
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null

    if ($Action -eq 'install') {
        $dll64 = Join-Path $installDir 'UnityCaptureFilter64.dll'
        $dll32 = Join-Path $installDir 'UnityCaptureFilter32.dll'
        if (-not $DllDir -or -not (Test-Path -LiteralPath (Join-Path $DllDir 'UnityCaptureFilter64.dll'))) {
            throw "UnityCapture DLLs not found at '$DllDir'"
        }
        Update-Dll -Src (Join-Path $DllDir 'UnityCaptureFilter64.dll') -Dst $dll64
        Update-Dll -Src (Join-Path $DllDir 'UnityCaptureFilter32.dll') -Dst $dll32

        # Custom name argument.  regsvr32 passes the raw command line through, so
        # quote the whole /i argument to preserve spaces in the friendly name.
        $nameArg = '"/i:UnityCaptureName=' + $Name + '"'
        $countArg = "/i:UnityCaptureDevices=$Devices"

        # 64-bit filter with native regsvr32, 32-bit filter with the WOW64 one.
        & regsvr32 /s $nameArg $countArg $dll64
        if ($LASTEXITCODE -ne 0) { throw "regsvr32 (64-bit) failed with code $LASTEXITCODE" }
        $reg32 = Join-Path $env:WINDIR 'SysWOW64\regsvr32.exe'
        if (Test-Path -LiteralPath $reg32) {
            & $reg32 /s $nameArg $countArg $dll32
            if ($LASTEXITCODE -ne 0) { throw "regsvr32 (32-bit) failed with code $LASTEXITCODE" }
        } else {
            & regsvr32 /s $nameArg $countArg $dll32
        }

        Write-Result "OK $Name"
    }
    elseif ($Action -eq 'uninstall') {
        $dll64 = Join-Path $installDir 'UnityCaptureFilter64.dll'
        $dll32 = Join-Path $installDir 'UnityCaptureFilter32.dll'
        if (Test-Path -LiteralPath $dll64) { & regsvr32 /s /u $dll64 }
        $reg32 = Join-Path $env:WINDIR 'SysWOW64\regsvr32.exe'
        if (Test-Path -LiteralPath $dll32) {
            if (Test-Path -LiteralPath $reg32) { & $reg32 /s /u $dll32 }
            else { & regsvr32 /s /u $dll32 }
        }
        Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Result 'OK removed'
    }
}
catch {
    Write-Result "ERR $($_.Exception.Message)"
    exit 1
}
exit 0
