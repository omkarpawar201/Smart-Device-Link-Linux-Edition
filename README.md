# Smart Device Link (LinkBridge)

An open-source, self-hosted phone-to-PC integration platform built with **Electron** and **React**. LinkBridge mirrors your Android phone's notifications, messages, calls, contacts, photos and files onto your Linux desktop — and lets you control them right from the PC, without cloud services.

## Features

- **Home dashboard** — battery, network, signal and device status at a glance, with quick actions and a "now playing" widget
- **Notifications** — live mirroring, per-notification dismissal and quick replies (where the source app supports them)
- **Messages** — browse SMS threads, read conversations and send replies from your desktop
- **Calls** — recent call history, dial pad, incoming-call overlay, mute / audio-target / ringer controls over Bluetooth HFP
- **Contacts** — synced address book with search and grouping
- **Photos** — thumbnail gallery with lazy photo streaming over the `photo-cache://` protocol and one-click download
- **Files** — full phone storage browser with drag-and-drop upload, download, folder creation and deletion over SFTP
- **Shared clipboard** — automatic cross-device text sync with history, send/copy/pin
- **Media control** — bidirectional playback control, seek and volume between phone and PC (KDE Connect media + Windows SMTC)
- **Screen mirroring** — full control of your phone from the PC via `scrcpy` over adb Wi-Fi
- **Remote camera** — remote shutter control UI
- **AI Assistant** — local context summaries, smart replies and file/photo search helpers
- **Unified activity timeline** — notifications, calls and clipboard events in one feed
- **Frameless acrylic window** — custom title bar, theme toggle and system tray support

## Tech Stack

| Layer      | Technology |
| ---------- | ---------- |
| Desktop    | Electron 29 |
| UI         | React 18, JSX, Tailwind CSS v4, Vite 5, lucide-react |
| Backend    | Node.js IPC (`src/ipc/bridge.js`), KDE Connect protocol |
| Connectivity | Local network (KDE Connect / UDP discovery), Bluetooth RFCOMM (HFP), SFTP (SSH2) |
| Mirroring  | scrcpy + adb over Wi-Fi |

## Architecture

```
main.js              Electron main process (window, tray, protocol, bridge boot)
preload.js           contextBridge — exposes a safe window.api surface to the renderer
src/ipc/bridge.js    KDE Connect bridge: discovery, pairing, notifications, SMS,
                     telephony, media, files, clipboard + photo streaming
src/kdeconnect/      KDE Connect protocol plugins
src/bluetooth/       RFCOMM client + HFP call audio plumbing (native helper)
src/mirror/          scrcpy/adb screen-mirroring backend
src/system/          media control (MPRIS on Linux, SMTC/media-keys on Windows)
renderer/            React app (Vite): AppShell + 15 pages + design system
```

The renderer talks to the backend exclusively through the `window.api` bridge exposed by `preload.js` — no Node APIs are exposed to the UI directly (`contextIsolation` is on).

## Requirements

- **Node.js 18+** and npm
- **Windows 10/11** or **Linux (KDE/GNOME, Wayland or X11)** — Linux uses native BlueZ, MPRIS/PulseAudio and v4l2loopback backends
- **Phone companion** — the LinkBridge Android app (or KDE Connect) running on the same Wi-Fi network
- **scrcpy + adb** (optional, for screen mirroring):
  ```
  # Windows
  winget install Genymobile.scrcpy

  # Linux (Kubuntu/Debian/Ubuntu)
  sudo apt install scrcpy adb
  ```
- **Bluetooth RFCOMM (Linux)** — requires `python3` with `python3-dbus` and `bluez` (the app publishes a BlueZ service profile and listens; the phone dials in over SDP)
- **Phone-as-webcam (Linux)** — requires `ffmpeg` and the `v4l2loopback` kernel module (`sudo apt install ffmpeg v4l2loopback-dkms`); the app loads it with a `pkexec` prompt
- **Media keys (Linux)** — any MPRIS-compatible player (VLC, Spotify, etc.) + PulseAudio/PipeWire; volume is controlled via `pactl`
- Android **Wireless Debugging** enabled for mirroring (`adb connect <ip>:<port>`)

> **KDE Connect conflict (Linux):** the app runs its own KDE Connect server on UDP/TCP port 1716. If the native `kdeconnectd` is already running it will hold those ports — stop it with
> `systemctl --user stop kdeconnectd` (the app shows a toast explaining this when it detects the conflict).

## Getting Started

```bash
# 1. Install dependencies
npm install

# 2. Run in development (Vite dev server + Electron)
npm run dev

# 3. Production build
npm run build:vite        # bundles the renderer into dist/
npm run build             # renderer build + electron-builder package
```

## Connecting a Phone

1. Install the companion app on your Android phone and make sure both devices are on the same network.
2. Open **Settings → Discovered devices** in LinkBridge, hit **Scan** and **Pair** your phone.
3. Approve the pairing request on either side.
4. Grant the phone app the permissions you want to use (notifications, SMS, contacts, files).

> The link uses the KDE Connect protocol over your local network. No accounts, no cloud — pairing is direct between your PC and phone.

## Notes

- File transfers use SFTP with a self-signed certificate generated at runtime.
- Photo thumbnails are downloaded on demand through a custom `photo-cache://` protocol.
- Call audio routing (PC speakers vs. phone earpiece) requires the Bluetooth HFP link.
- The `android/` companion app lives in its own repository.

## Platform Notes

- **Windows** — HFP call audio, SMTC now-playing, DirectShow virtual camera (UnityCapture), and Win32 docked mirroring are Windows-native.
- **Linux** — RFCOMM uses a BlueZ `ProfileManager1` listener (`src/bluetooth/rfcomm-listen.py`); now-playing/transport and volume use MPRIS over D-Bus + `pactl`; mirroring docks via a borderless scrcpy window positioned over the phone placeholder (respawned on move); webcam uses `ffmpeg` → v4l2loopback (`Phone Camera`).
- **Packaging** — `npm run build` produces `.AppImage`/`.deb` on Linux and NSIS on Windows. Spawned helper scripts are copied to `resources` at build time (they can't run from inside `app.asar`).

## License

MIT — see `package.json`.
