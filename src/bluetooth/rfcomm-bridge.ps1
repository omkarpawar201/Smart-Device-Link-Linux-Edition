# rfcomm-bridge.ps1
# Windows-side raw RFCOMM client for the DIY Phone Link custom-UUID service.
#
# Node.js has no built-in Bluetooth API, and .NET Framework (which PowerShell
# 5.1 runs on) never shipped the BCL Bluetooth types either — AddressFamily.
# Bluetooth / BluetoothEndPoint are .NET Core only. So this helper talks
# directly to Winsock via P/Invoke:
#   socket(AF_BTH=32, SOCK_STREAM=1, BTHPROTO_RFCOMM=3)
#   connect() against SOCKADDR_BTH with port = BT_PORT_ANY, which makes the
#   Windows Bluetooth stack resolve the RFCOMM channel through an SDP query
#   of the service GUID automatically.
#
# Some phones do not answer live SDP queries, so BT_PORT_ANY can time out even
# though a direct channel connect would succeed. Use -Scan to probe channels
# 1..30 with a fast non-blocking connect on each; the channel that answers is
# used directly, bypassing SDP.
#
# Use -Listen to run the PC as the RFCOMM server instead: the phone then
# initiates the baseband link (the direction this phone reliably answers) by
# resolving the service GUID over SDP and connecting to it.
#
# This deliberately does NOT use Windows virtual COM ports (those are only
# mapped for the SPP service) and does NOT rely on HFP or any native
# call-audio profile, mirroring how Microsoft Phone Link works.
#
# Usage:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#     -File rfcomm-bridge.ps1 -Mac AABBCCDDEEFF -Guid <service-uuid>
#   powershell ... -Mac AABBCCDDEEFF -Guid <uuid> -Channel 8
#   powershell ... -Mac AABBCCDDEEFF -Guid <uuid> -Scan
#   powershell ... -Mac AABBCCDDEEFF -Guid <uuid> -Listen
#
# Contract:
#   * stdout = raw relay bytes (phone -> Node)
#   * stdin  = raw relay bytes (Node -> phone)
#   * stderr = human diagnostics prefixed with [STATUS] markers
#
# Exit codes: 0 = clean close, 2 = connect failed, 3 = relay error

param(
    [Parameter(Mandatory = $false)][string]$Mac = '',
    [Parameter(Mandatory = $true)][string]$Guid,
    [int]$Channel = -1,
    [switch]$Scan,
    [switch]$Listen
)

$ErrorActionPreference = 'Stop'

# Normalize MAC to a bare 12-hex-digit form. The MAC is only needed to dial
# OUT to the phone; in -Listen mode the phone initiates, so it can be empty.
$rawMac = ($Mac -replace '[^0-9a-fA-F]', '').ToUpperInvariant()
if ($rawMac.Length -ne 12 -and -not $Listen) {
    [Console]::Error.WriteLine('[STATUS] ERROR_INVALID_MAC')
    exit 1
}

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class RfcommRelay
{
    private const int AF_BTH = 32;
    private const int SOCK_STREAM = 1;
    private const int BTHPROTO_RFCOMM = 3;
    private const uint BT_PORT_ANY = 0;
    private const int SD_SEND = 1;
    private const int WSAEWOULDBLOCK = 10035;
    private const int WSA_WAIT_TIMEOUT = 258;
    private const int FD_CONNECT = 0x10;
    private const int FD_CLOSE = 0x20;

    private static readonly object s_sendLock = new object();
    private static readonly System.Collections.Generic.List<byte> s_protoBuf =
        new System.Collections.Generic.List<byte>();

    // Matches the Windows SDK _SOCKADDR_BTH layout, which is declared under
    // pshpack1 (packed): addressFamily @0 (2), btAddr @2 (8), serviceClassId
    // @10 (16), port @26 (4). Total 30 bytes. Passing the aligned 36/40-byte
    // variant makes the stack misread btAddr and return WSAEADDRNOTAVAIL.
    [StructLayout(LayoutKind.Explicit, Pack = 1)]
    private struct SOCKADDR_BTH
    {
        [FieldOffset(0)] public ushort addressFamily;
        [FieldOffset(2)] public ulong btAddr;
        [FieldOffset(10)] public Guid serviceClassId;
        [FieldOffset(26)] public uint port;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WSANETWORKEVENTS
    {
        public int lNetworkEvents;
        // FD_READ..FD_CONNECT etc; index 4 == FD_CONNECT
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 10)] public int[] iErrorCode;
    }

    [DllImport("ws2_32.dll")]
    private static extern int WSAStartup(ushort wVersionRequested, [Out] byte[] lpWSAData);

    [DllImport("ws2_32.dll")]
    private static extern IntPtr socket(int af, int type, int protocol);

    [DllImport("ws2_32.dll", SetLastError = true)]
    private static extern int connect(IntPtr s, ref SOCKADDR_BTH name, int namelen);

    [DllImport("ws2_32.dll", SetLastError = true)]
    private static extern int send(IntPtr s, byte[] buf, int len, int flags);

    [DllImport("ws2_32.dll", SetLastError = true)]
    private static extern int recv(IntPtr s, [Out] byte[] buf, int len, int flags);

    [DllImport("ws2_32.dll")]
    private static extern int shutdown(IntPtr s, int how);

    [DllImport("ws2_32.dll")]
    private static extern int closesocket(IntPtr s);

    [DllImport("ws2_32.dll")]
    private static extern int WSAGetLastError();

    [DllImport("ws2_32.dll", SetLastError = true)]
    private static extern IntPtr WSACreateEvent();

    [DllImport("ws2_32.dll", SetLastError = true)]
    private static extern int WSACloseEvent(IntPtr hEvent);

    [DllImport("ws2_32.dll", SetLastError = true)]
    private static extern int WSAEventSelect(IntPtr s, IntPtr hEvent, int lNetworkEvents);

    [DllImport("ws2_32.dll", SetLastError = true)]
    private static extern int WSAWaitForMultipleEvents(int cEvents, IntPtr[] lphEvents, bool fWaitAll, int dwTimeout, bool fAlertable);

    [DllImport("ws2_32.dll", SetLastError = true)]
    private static extern int WSAEnumNetworkEvents(IntPtr s, IntPtr hEvent, out WSANETWORKEVENTS lpNetworkEvents);

    [DllImport("ws2_32.dll", SetLastError = true)]
    private static extern int bind(IntPtr s, ref SOCKADDR_BTH name, int namelen);

    [DllImport("ws2_32.dll", SetLastError = true)]
    private static extern int listen(IntPtr s, int backlog);

    [DllImport("ws2_32.dll", SetLastError = true)]
    private static extern IntPtr accept(IntPtr s, ref SOCKADDR_BTH addr, ref int addrlen);

    [DllImport("ws2_32.dll", SetLastError = true)]
    private static extern int getsockname(IntPtr s, ref SOCKADDR_BTH name, ref int namelen);

    [StructLayout(LayoutKind.Sequential)]
    private struct CSADDR_INFO
    {
        public IntPtr LocalAddr;
        public int LocalAddrLength;
        public IntPtr RemoteAddr;
        public int RemoteAddrLength;
        public int iSocketType;
        public int iProtocol;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WSAQUERYSETW
    {
        public int dwSize;
        public IntPtr lpszServiceInstanceName;
        public IntPtr lpServiceClassId;
        public IntPtr lpVersion;
        public IntPtr lpszComment;
        public int dwNameSpace;
        public IntPtr lpNSProviderId;
        public IntPtr lpszContext;
        public int dwNumberOfProtocols;
        public IntPtr lpafpProtocols;
        public IntPtr lpszQueryString;
        public int dwNumberOfCsAddrs;
        public IntPtr lpcsaBuffer;
        public int dwOutputFlags;
        public IntPtr lpBlob;
    }

    [DllImport("ws2_32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int WSASetService(ref WSAQUERYSETW lpqsRegInfo, int essOperation, int dwControlFlags);

    private const int NS_BTH = 16;
    private const int RNRSERVICE_REGISTER = 0;
    private const int RNRSERVICE_DELETE = 1;

    // BTH_ADDR is a 64-bit value holding the 48-bit MAC, LSB first: the first
    // octet of the MAC is the least significant byte.
    private static ulong MacToBthAddr(string mac)
    {
        ulong value = 0;
        for (int i = 0; i < 6; i++)
        {
            byte b = Convert.ToByte(mac.Substring(i * 2, 2), 16);
            value |= ((ulong)b) << (i * 8);
        }
        return value;
    }

    private static string WinsockError(int code)
    {
        switch (code)
        {
            case 10049: return "WSAEADDRNOTAVAIL (unrecognised MAC)";
            case 10051: return "WSAENETUNREACH (device unreachable / not paired)";
            case 10060: return "WSAETIMEDOUT (no response)";
            case 10061: return "WSAECONNREFUSED (service GUID not in device SDP)";
            default: return "Winsock error " + code;
        }
    }

    private static SOCKADDR_BTH BuildAddr(string mac, string guid, uint port)
    {
        SOCKADDR_BTH addr = new SOCKADDR_BTH();
        addr.addressFamily = AF_BTH;
        addr.btAddr = MacToBthAddr(mac);
        addr.serviceClassId = new Guid(guid);
        addr.port = port;
        return addr;
    }

    // Non-blocking connect with timeout, using an event object. Returns true
    // only when FD_CONNECT completes without error. Leaves the socket in
    // blocking mode afterwards (clearing the event association does that).
    private static bool TryConnect(IntPtr s, ref SOCKADDR_BTH addr, int timeoutMs)
    {
        IntPtr hEvent = WSACreateEvent();
        try
        {
            WSAEventSelect(s, hEvent, FD_CONNECT | FD_CLOSE);
            int rc = connect(s, ref addr, Marshal.SizeOf(typeof(SOCKADDR_BTH)));
            if (rc == 0) return true;
            if (WSAGetLastError() != WSAEWOULDBLOCK) return false;

            int w = WSAWaitForMultipleEvents(1, new IntPtr[] { hEvent }, true, timeoutMs, false);
            if (w == WSA_WAIT_TIMEOUT) return false;

            WSANETWORKEVENTS events = new WSANETWORKEVENTS();
            events.iErrorCode = new int[10];
            WSAEnumNetworkEvents(s, hEvent, out events);
            if ((events.lNetworkEvents & FD_CONNECT) != 0 && events.iErrorCode[4] == 0)
                return true;
            return false;
        }
        finally
        {
            WSAEventSelect(s, hEvent, 0);
            WSACloseEvent(hEvent);
        }
    }

    private static int SendAll(IntPtr s, byte[] buf, int len)
    {
        lock (s_sendLock)
        {
            int offset = 0;
            while (offset < len)
            {
                int chunk = len - offset;
                byte[] slice = new byte[chunk];
                Array.Copy(buf, offset, slice, 0, chunk);
                int sent = send(s, slice, chunk, 0);
                if (sent <= 0) return -1;
                offset += sent;
            }
            return 0;
        }
    }

    // Builds a 4-byte-length + JSON frame, matching the phone's Protocol.kt.
    private static byte[] BuildFrame(string json)
    {
        byte[] payload = System.Text.Encoding.UTF8.GetBytes(json);
        byte[] frame = new byte[4 + payload.Length];
        frame[0] = (byte)(payload.Length >> 24);
        frame[1] = (byte)(payload.Length >> 16);
        frame[2] = (byte)(payload.Length >> 8);
        frame[3] = (byte)payload.Length;
        Array.Copy(payload, 0, frame, 4, payload.Length);
        return frame;
    }

    // Keeps the link alive when the bridge runs standalone (no Node protocol
    // engine attached): the phone sends {"t":"ping"} every heartbeat and drops
    // the link if nobody answers with {"t":"pong"} within ~15s. Scans the
    // phone->PC byte stream for complete ping frames and replies locally. The
    // raw bytes still flow to stdout untouched for the Node layer.
    private static void FeedProtocol(IntPtr s, byte[] chunk, int len)
    {
        for (int i = 0; i < len; i++) s_protoBuf.Add(chunk[i]);
        while (s_protoBuf.Count >= 4)
        {
            int flen = (s_protoBuf[0] << 24) | (s_protoBuf[1] << 16) | (s_protoBuf[2] << 8) | s_protoBuf[3];
            if (flen < 0 || flen > 0x100000) { s_protoBuf.Clear(); return; }
            if (s_protoBuf.Count < 4 + flen) return;
            string payload = System.Text.Encoding.UTF8.GetString(s_protoBuf.ToArray(), 4, flen);
            s_protoBuf.RemoveRange(0, 4 + flen);
            if (payload.IndexOf("\"t\":\"ping\"", StringComparison.Ordinal) >= 0)
            {
                byte[] pong = BuildFrame("{\"t\":\"pong\"}");
                SendAll(s, pong, pong.Length);
            }
        }
    }

    // Relay once a socket is connected: stdin -> phone, phone -> stdout.
    private static int Relay(IntPtr s)
    {
        try
        {
            // PC-initiated handshake so the phone marks the link ready.
            byte[] hello = BuildFrame("{\"t\":\"hello\",\"v\":1}");
            SendAll(s, hello, hello.Length);

            Stream stdin = new FileStream(new SafeFileHandle(GetStdHandle(-10), false), FileAccess.Read);
            Stream stdout = new FileStream(new SafeFileHandle(GetStdHandle(-11), false), FileAccess.Write);

            Thread up = new Thread(delegate()
            {
                byte[] b = new byte[8192];
                int n;
                while ((n = stdin.Read(b, 0, b.Length)) > 0)
                {
                    if (SendAll(s, b, n) != 0) break;
                }
                try { shutdown(s, SD_SEND); } catch { }
            });
            up.IsBackground = true;
            up.Start();

            byte[] buf = new byte[8192];
            int r;
            while ((r = recv(s, buf, buf.Length, 0)) > 0)
            {
                stdout.Write(buf, 0, r);
                stdout.Flush();
                FeedProtocol(s, buf, r);
            }

            if (r == 0)
                Console.Error.WriteLine("[STATUS] CLOSED (peer closed connection)");
            else
                Console.Error.WriteLine("[STATUS] CLOSED (recv error " + WSAGetLastError() + ")");

            up.Join(2000);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[STATUS] ERROR: " + ex.Message);
            return 3;
        }
        finally
        {
            try { closesocket(s); } catch { }
        }
    }

    private static int ScanAndRelay(string mac, string guid)
    {
        for (int ch = 1; ch <= 30; ch++)
        {
            IntPtr s = socket(AF_BTH, SOCK_STREAM, BTHPROTO_RFCOMM);
            if ((long)s == -1)
            {
                Console.Error.WriteLine("[STATUS] ERROR_CONNECT: socket() failed (" + WSAGetLastError() + ")");
                return 2;
            }
            SOCKADDR_BTH addr = BuildAddr(mac, guid, (uint)ch);
            Console.Error.WriteLine("[STATUS] SCAN channel " + ch + "...");
            if (!TryConnect(s, ref addr, 1200))
            {
                closesocket(s);
                continue;
            }
            Console.Error.WriteLine("[STATUS] CONNECTED on channel " + ch);
            return Relay(s);
        }
        Console.Error.WriteLine("[STATUS] ERROR_CONNECT: no channel answered (tried 1..30)");
        return 2;
    }

    // Server mode: the phone initiates the baseband link (which is the
    // direction this phone actually answers). Windows does NOT advertise the
    // service from bind() alone — the SDP record must be published explicitly
    // with WSASetService so the phone can resolve the GUID via SDP.
    private const string ProtocolServiceName = "DIY Phone Link";

    // BTH_SET_SERVICE header size on x64: pSdpVersion(8) + pRecordHandle(8)
    // + fCodService(4) + Reserved[5](20) + ulRecordLength(4) = 44 bytes.
    private const int BTH_SET_SERVICE_HEADER = 44;

    // Output handle written by WSASetService for RNRSERVICE_DELETE. Kept for
    // the life of the process (the OS also drops the record when we exit).
    private static IntPtr s_recordHandlePtr = IntPtr.Zero;
    private static IntPtr s_sdpVersionPtr = IntPtr.Zero;

    // Builds the SDP record in the exact layout the Windows BTH namespace
    // provider accepts (it returns WSAEINVAL for a bare 0x35 SEQ8 record):
    // a top-level SEQ16 (0x36) wrapping ServiceClassIdList,
    // ProtocolDescriptorList (L2CAP + RFCOMM + channel), the
    // LanguageBaseAttributeIDList and ServiceName (STRING16).
    private static byte[] BuildSdpRecord(string guid, string name, uint channel)
    {
        // SDP UUID128 is network byte order, i.e. the canonical hex of the GUID.
        string hex = new Guid(guid).ToString("N");
        byte[] uuid = new byte[16];
        for (int i = 0; i < 16; i++)
            uuid[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);

        byte[] nameBytes = System.Text.Encoding.UTF8.GetBytes(name);

        System.Collections.Generic.List<byte> content = new System.Collections.Generic.List<byte>();
        // ServiceClassIdList (attr 0x0001)
        content.Add(0x09); content.Add(0x00); content.Add(0x01);
        content.Add(0x36); content.Add(0x00); content.Add(0x11);
        content.Add(0x1C);
        foreach (byte b in uuid) content.Add(b);
        // ProtocolDescriptorList (attr 0x0004): L2CAP then RFCOMM + channel
        content.Add(0x09); content.Add(0x00); content.Add(0x04);
        content.Add(0x36); content.Add(0x00); content.Add(0x0E);
        content.Add(0x36); content.Add(0x00); content.Add(0x03);
        content.Add(0x19); content.Add(0x01); content.Add(0x00);
        content.Add(0x36); content.Add(0x00); content.Add(0x05);
        content.Add(0x19); content.Add(0x00); content.Add(0x03);
        content.Add(0x08); content.Add((byte)channel);
        // LanguageBaseAttributeIDList (attr 0x0006)
        content.Add(0x09); content.Add(0x00); content.Add(0x06);
        content.Add(0x36); content.Add(0x00); content.Add(0x09);
        content.Add(0x09); content.Add(0x65); content.Add(0x6E);
        content.Add(0x09); content.Add(0x00); content.Add(0x6A);
        content.Add(0x09); content.Add(0x01); content.Add(0x00);
        // ServiceName (attr 0x0100), STRING16
        content.Add(0x09); content.Add(0x01); content.Add(0x00);
        content.Add(0x26); content.Add(0x00); content.Add((byte)nameBytes.Length);
        foreach (byte b in nameBytes) content.Add(b);

        byte[] rec = new byte[3 + content.Count];
        rec[0] = 0x36;
        rec[1] = (byte)(content.Count >> 8);
        rec[2] = (byte)(content.Count & 0xFF);
        content.CopyTo(rec, 3);
        return rec;
    }

    private static void RegisterService(string guid, string name, uint channel)
    {
        SOCKADDR_BTH regAddr = new SOCKADDR_BTH();
        regAddr.addressFamily = AF_BTH;
        regAddr.port = channel;
        regAddr.serviceClassId = new Guid(guid);

        IntPtr addrPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SOCKADDR_BTH)));
        Marshal.StructureToPtr(regAddr, addrPtr, false);

        CSADDR_INFO csa = new CSADDR_INFO();
        csa.LocalAddr = addrPtr;
        csa.LocalAddrLength = Marshal.SizeOf(typeof(SOCKADDR_BTH));
        csa.RemoteAddr = IntPtr.Zero;
        csa.RemoteAddrLength = 0;
        csa.iSocketType = SOCK_STREAM;
        csa.iProtocol = BTHPROTO_RFCOMM;

        IntPtr csaPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CSADDR_INFO)));
        Marshal.StructureToPtr(csa, csaPtr, false);

        byte[] record = BuildSdpRecord(guid, name, channel);

        // Packed BTH_SET_SERVICE: header at 0, raw SDP record at offset 44.
        IntPtr setSvc = Marshal.AllocHGlobal(BTH_SET_SERVICE_HEADER + record.Length);
        s_sdpVersionPtr = Marshal.AllocHGlobal(4);
        Marshal.WriteInt32(s_sdpVersionPtr, 0, 1);
        s_recordHandlePtr = Marshal.AllocHGlobal(8);
        Marshal.WriteInt64(s_recordHandlePtr, 0, 0);
        Marshal.WriteIntPtr(setSvc, 0, s_sdpVersionPtr);
        Marshal.WriteIntPtr(setSvc, 8, s_recordHandlePtr);
        Marshal.WriteInt32(setSvc, 16, 0); // fCodService
        for (int i = 0; i < 5; i++) Marshal.WriteInt32(setSvc, 20 + i * 4, 0);
        Marshal.WriteInt32(setSvc, 40, record.Length);
        for (int i = 0; i < record.Length; i++) Marshal.WriteByte(setSvc, BTH_SET_SERVICE_HEADER + i, record[i]);

        IntPtr blob = Marshal.AllocHGlobal(16);
        Marshal.WriteInt32(blob, 0, BTH_SET_SERVICE_HEADER + record.Length);
        Marshal.WriteIntPtr(blob, 8, setSvc);

        WSAQUERYSETW wqs = new WSAQUERYSETW();
        wqs.dwSize = Marshal.SizeOf(typeof(WSAQUERYSETW));
        wqs.dwNameSpace = NS_BTH;
        wqs.dwNumberOfCsAddrs = 1;
        wqs.lpcsaBuffer = csaPtr;
        wqs.lpBlob = blob;

        int rc = WSASetService(ref wqs, RNRSERVICE_REGISTER, 0);
        int err = rc == 0 ? 0 : WSAGetLastError();

        Marshal.FreeHGlobal(addrPtr);
        Marshal.FreeHGlobal(csaPtr);
        Marshal.FreeHGlobal(setSvc);
        Marshal.FreeHGlobal(blob);

        // WSAEALREADY: an identical record is already registered; the
        // persistent registration means the GUID resolves to this channel.
        if (rc != 0 && err != 10037)
            throw new InvalidOperationException("WSASetService failed (" + err + ")");
    }

    private static void DeleteService()
    {
        if (s_recordHandlePtr == IntPtr.Zero) return;
        if (Marshal.ReadInt64(s_recordHandlePtr) == 0) return;

        IntPtr setSvc = Marshal.AllocHGlobal(BTH_SET_SERVICE_HEADER + 1);
        Marshal.WriteIntPtr(setSvc, 0, s_sdpVersionPtr);
        Marshal.WriteIntPtr(setSvc, 8, s_recordHandlePtr);
        Marshal.WriteInt32(setSvc, 16, 0);
        for (int i = 0; i < 5; i++) Marshal.WriteInt32(setSvc, 20 + i * 4, 0);
        Marshal.WriteInt32(setSvc, 40, 0);

        IntPtr blob = Marshal.AllocHGlobal(16);
        Marshal.WriteInt32(blob, 0, BTH_SET_SERVICE_HEADER + 1);
        Marshal.WriteIntPtr(blob, 8, setSvc);

        WSAQUERYSETW wqs = new WSAQUERYSETW();
        wqs.dwSize = Marshal.SizeOf(typeof(WSAQUERYSETW));
        wqs.dwNameSpace = NS_BTH;
        wqs.lpBlob = blob;

        WSASetService(ref wqs, RNRSERVICE_DELETE, 0);

        Marshal.FreeHGlobal(setSvc);
        Marshal.FreeHGlobal(blob);
        s_recordHandlePtr = IntPtr.Zero;
    }

    private static int ListenAndRelay(string guid)
    {
        // Bind on a fixed channel so the SDP record is deterministic and the
        // phone always resolves the same RFCOMM channel across runs.
        uint[] channels = { 22, 23, 24, 21, 20, 19, 18 };
        IntPtr s = IntPtr.Zero;
        uint boundChannel = 0;
        foreach (uint ch in channels)
        {
            IntPtr t = socket(AF_BTH, SOCK_STREAM, BTHPROTO_RFCOMM);
            if ((long)t == -1)
            {
                Console.Error.WriteLine("[STATUS] ERROR_LISTEN: socket() failed (" + WSAGetLastError() + ")");
                return 2;
            }
            SOCKADDR_BTH addr = new SOCKADDR_BTH();
            addr.addressFamily = AF_BTH;
            addr.port = ch;
            if (bind(t, ref addr, Marshal.SizeOf(typeof(SOCKADDR_BTH))) == 0)
            {
                s = t;
                boundChannel = ch;
                break;
            }
            closesocket(t);
        }
        if (s == IntPtr.Zero)
        {
            Console.Error.WriteLine("[STATUS] ERROR_LISTEN: no free RFCOMM channel");
            return 2;
        }

        if (listen(s, 1) != 0)
        {
            Console.Error.WriteLine("[STATUS] ERROR_LISTEN: listen failed (" + WSAGetLastError() + ")");
            closesocket(s);
            return 2;
        }

        try
        {
            RegisterService(guid, ProtocolServiceName, boundChannel);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[STATUS] ERROR_LISTEN: " + ex.Message);
            closesocket(s);
            return 2;
        }

        Console.Error.WriteLine("[STATUS] LISTENING on service " + guid + " (channel " + boundChannel + ")");

        try
        {
            SOCKADDR_BTH remote = new SOCKADDR_BTH();
            int rlen = Marshal.SizeOf(typeof(SOCKADDR_BTH));
            IntPtr client = accept(s, ref remote, ref rlen);
            if ((long)client == -1)
            {
                Console.Error.WriteLine("[STATUS] ERROR_LISTEN: accept failed (" + WSAGetLastError() + ")");
                return 2;
            }
            Console.Error.WriteLine("[STATUS] ACCEPTED");
            return Relay(client);
        }
        finally
        {
            DeleteService();
            closesocket(s);
        }
    }

    public static int Run(string mac, string guid, int channel, bool scan, bool listen)
    {
        // .NET only calls WSAStartup lazily when a *managed* socket API is used.
        // Since we P/Invoke ws2_32 directly, initialize Winsock explicitly or
        // socket(AF_BTH) fails with WSAGetLastError() == 2.
        byte[] wsadata = new byte[512];
        if (WSAStartup(0x0202, wsadata) != 0)
        {
            Console.Error.WriteLine("[STATUS] ERROR_CONNECT: WSAStartup failed (" + WSAGetLastError() + ")");
            return 2;
        }

        if (listen)
            return ListenAndRelay(guid);

        if (scan)
            return ScanAndRelay(mac, guid);

        IntPtr s = socket(AF_BTH, SOCK_STREAM, BTHPROTO_RFCOMM);
        if ((long)s == -1)
        {
            Console.Error.WriteLine("[STATUS] ERROR_CONNECT: socket() failed (" + WSAGetLastError() + ")");
            return 2;
        }

        uint port = channel > 0 ? (uint)channel : BT_PORT_ANY;
        SOCKADDR_BTH addr = BuildAddr(mac, guid, port);

        try
        {
            Console.Error.WriteLine("[STATUS] CONNECTING");
            int rc = connect(s, ref addr, Marshal.SizeOf(typeof(SOCKADDR_BTH)));
            if (rc != 0)
            {
                int err = WSAGetLastError();
                Console.Error.WriteLine("[STATUS] ERROR_CONNECT: " + WinsockError(err));
                return 2;
            }
            Console.Error.WriteLine("[STATUS] CONNECTED");
            return Relay(s);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[STATUS] ERROR_CONNECT: " + ex.Message);
            return 2;
        }
    }

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int nStdHandle);
}
'@

try {
    $code = [RfcommRelay]::Run($rawMac, $Guid, $Channel, [bool]$Scan, [bool]$Listen)
    exit $code
}
catch {
    [Console]::Error.WriteLine("[STATUS] ERROR: " + $_.Exception.Message)
    exit 3
}
