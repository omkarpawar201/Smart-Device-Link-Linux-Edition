#!/usr/bin/env python3
"""Linux-side RFCOMM listener for the DIY Phone Link custom-UUID service.

Windows uses rfcomm-bridge.ps1 (Winsock P/Invoke + WSASetService) to publish an
SDP record for the custom service GUID and accept the phone's RFCOMM link. The
Linux-native equivalent is BlueZ's org.bluez.ProfileManager1: registering a
profile for the same GUID publishes the SDP record and hands us the accepted
socket as a D-Bus file descriptor.

Contract (same as the Windows bridge, so RfcommClient is agnostic):
  * stdout = raw relay bytes (phone -> Node)
  * stdin  = raw relay bytes (Node -> phone)
  * stderr = [STATUS] markers: LISTENING / ACCEPTED / CLOSED / ERROR_LISTEN
  * exit codes: 0 = clean close, 2 = listen/register failed

Usage:  python3 rfcomm-listen.py <service-guid> [channel]
"""

import os
import signal
import socket
import sys
import threading
import time

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

PROFILE_PATH = "/org/bluez/diyphonelink"
SERVICE_NAME = "DIY Phone Link"

# Set in main(); used by the relay so a connection teardown always releases the
# BlueZ profile (avoids leaking RFCOMM server sockets that eventually block
# every channel).
_manager = None


def _unregister():
    global _manager
    if _manager is None:
        return
    try:
        _manager.UnregisterProfile(PROFILE_PATH)
    except Exception:
        pass


def _status(line):
    try:
        os.write(2, ("[STATUS] " + line + "\n").encode("utf-8"))
    except OSError:
        pass


def _unwrap_fd(fd):
    # BlueZ passes the accepted socket as a D-Bus unix fd. python-dbus delivers
    # it as dbus.types.UnixFd (has .take()) or, on some versions, as an int.
    if hasattr(fd, "take"):
        return fd.take()
    return int(fd)


def _relay(raw_fd, device_path):
    mac = ""
    if device_path:
        parts = str(device_path).split("/")
        for p in parts:
            if p.startswith("dev_"):
                mac = p[4:].replace("_", ":").upper()
    if mac:
        _status("ACCEPTED " + mac)
    else:
        _status("ACCEPTED")
    peer = ""
    try:
        peer = str(device_path or "")
    except Exception:
        pass

    def phone_to_stdout():
        # BlueZ hands us the accepted socket in NON-BLOCKING mode, so os.read
        # raises EAGAIN when no data is pending yet. That is NOT end-of-stream:
        # retry instead of bailing (bailing here is why Node saw zero RX bytes
        # while btmon proved the phone was transmitting).
        try:
            while True:
                try:
                    chunk = os.read(raw_fd, 8192)
                except BlockingIOError:
                    time.sleep(0.01)
                    continue
                if not chunk:
                    break
                os.write(1, chunk)
        except OSError:
            pass

    reader = threading.Thread(target=phone_to_stdout, daemon=True)
    reader.start()

    try:
        # stdin -> phone (Node drives the framing: hello/ping/pong/call.*)
        while True:
            try:
                chunk = os.read(0, 8192)
            except BlockingIOError:
                time.sleep(0.01)
                continue
            if not chunk:
                break
            # The socket is non-blocking, so a full send buffer would raise
            # EAGAIN too; retry until every byte is written.
            view = memoryview(chunk)
            while view:
                try:
                    written = os.write(raw_fd, view)
                except BlockingIOError:
                    time.sleep(0.01)
                    continue
                view = view[written:]
    except OSError:
        pass

    try:
        os.close(raw_fd)
    except OSError:
        pass
    _status("CLOSED" + (" from " + peer if peer else ""))
    _unregister()
    os._exit(0)


class DiyPhoneLinkProfile(dbus.service.Object):
    def __init__(self, bus, path):
        super().__init__(bus, path)

    @dbus.service.method("org.bluez.Profile1", in_signature="oha{sv}")
    def NewConnection(self, device, fd, properties):
        threading.Thread(target=lambda: _relay(_unwrap_fd(fd), device), daemon=True).start()

    @dbus.service.method("org.bluez.Profile1", in_signature="")
    def RequestDisconnection(self, device):
        pass

    @dbus.service.method("org.bluez.Profile1", in_signature="")
    def Release(self):
        pass


ADAPTER_ADDR = "10:5B:AD:53:2C:DA"


def _adapter_address(bus):
    # Kernel RFCOMM bind conflicts are per (bdaddr, channel), so probes must use
    # the same local address bluetoothd binds, not BDADDR_ANY.
    try:
        om = dbus.Interface(bus.get_object("org.bluez", "/"),
                            "org.freedesktop.DBus.ObjectManager")
        for path, ifaces in om.GetManagedObjects().items():
            if "org.bluez.Adapter1" in ifaces:
                return str(ifaces["org.bluez.Adapter1"]["Address"])
    except Exception:
        pass
    return ADAPTER_ADDR


def _rfcomm_bound(local, channel):
    s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
    try:
        s.bind((local, channel))
        return False
    except OSError:
        return True
    finally:
        s.close()


def find_free_channel(local, candidates):
    for ch in candidates:
        if not _rfcomm_bound(local, ch):
            return ch
    return None


def main():
    guid = sys.argv[1] if len(sys.argv) > 1 else "8f2d9c40-1a2b-4b8e-9f2c-3d4e5f6a7b8c"
    channel = None
    if len(sys.argv) > 2:
        try:
            channel = int(sys.argv[2])
        except ValueError:
            channel = None

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()

    profile = DiyPhoneLinkProfile(bus, PROFILE_PATH)

    try:
        manager = dbus.Interface(bus.get_object("org.bluez", "/org/bluez"), "org.bluez.ProfileManager1")
    except Exception as e:
        _status("ERROR_LISTEN: bluez unavailable: " + str(e))
        sys.exit(2)
    global _manager
    _manager = manager

    # Let the OS reap us quickly on SIGTERM (Node's disconnect path), but
    # unregister first so bluetoothd releases the server socket instead of
    # leaking it (accumulated leaks block every RFCOMM channel).
    def _term(signum, frame):
        _unregister()
        os._exit(0)

    signal.signal(signal.SIGTERM, _term)
    signal.signal(signal.SIGINT, _term)

    # Clear a stale registration if a previous instance died uncleanly.
    try:
        manager.UnregisterProfile(PROFILE_PATH)
    except Exception:
        pass

    options = {
        "Name": SERVICE_NAME,
        "Role": "server",
        "AutoConnect": False,
    }

    # BlueZ only starts the RFCOMM server when an explicit "Channel" option is
    # given (external profiles default to no RFCOMM at all, which leaves the SDP
    # record without a protocol entry the phone could dial). Pick a free channel
    # with a raw-socket probe (RegisterProfile itself reports success even when
    # the bind silently fails, so we re-probe afterwards to confirm the channel
    # is actually held).
    candidates = [channel] if channel else []
    candidates += [5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29]

    local = _adapter_address(bus)
    tried = set()
    for ch in candidates:
        if ch in tried:
            continue
        tried.add(ch)
        if _rfcomm_bound(local, ch):
            continue
        options["Channel"] = dbus.UInt16(ch)
        try:
            manager.RegisterProfile(PROFILE_PATH, guid, options)
        except dbus.exceptions.DBusException as e:
            _status("WARN channel " + str(ch) + " busy (" + str(e.get_dbus_message() or e) + ")")
            continue
        if _rfcomm_bound(local, ch):
            channel = ch
            break
        try:
            manager.UnregisterProfile(PROFILE_PATH)
        except Exception:
            pass
        _status("WARN channel " + str(ch) + " registered but not bound; retrying")
    else:
        _status("ERROR_LISTEN: no free RFCOMM channel available")
        sys.exit(2)

    _status("LISTENING on service " + guid + " (channel " + str(channel) + ")")
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
