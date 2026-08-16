#!/usr/bin/env bash
# Sets up full-duplex phone call audio (HFP) on Linux for Diy Phone Link.
#
# Modern BlueZ delegates HFP/HSP to PipeWire's native bluez5 backend, which
# registers the Hands-Free profile itself. To avoid a profile conflict, the
# Bluetooth daemon must run WITHOUT its built-in hfp-hf/hfp-ag plugins.
#
# When a call is active on the paired phone, PipeWire creates SCO audio nodes
# (mSBC, 16 kHz mono) that the app routes to/from the PC speakers + microphone
# via pw-link. Media audio (A2DP) is unaffected.
#
# Idempotent: safe to re-run (e.g. after a BlueZ/WirePlumber upgrade).

set -euo pipefail

BLUETOOTHD=/usr/libexec/bluetooth/bluetoothd
PHONE_MAC="${1:-DC:B7:2E:2E:31:3B}"

echo "=== Diy Phone Link: Linux HFP audio setup ==="

# 1. Bluetooth daemon drop-in: hand HFP/HSP to PipeWire
BT_DROP=/etc/systemd/system/bluetooth.service.d
echo "[1/4] Configuring bluetoothd (--noplugin=hfp-hf,hfp-ag)..."
sudo mkdir -p "$BT_DROP"
sudo tee "$BT_DROP/hfp-noplugin.conf" >/dev/null <<EOF
[Service]
ExecStart=
ExecStart=$BLUETOOTHD --noplugin=hfp-hf,hfp-ag
EOF

# 2. WirePlumber drop-in: explicitly enable the HF role + mSBC wideband codec
WP_DROP="$HOME/.config/wireplumber/wireplumber.conf.d"
echo "[2/4] Configuring WirePlumber bluez5 roles (hfp_hf + msbc)..."
mkdir -p "$WP_DROP"
cat > "$WP_DROP/50-bluez-hfp.conf" <<'EOF'
monitor.bluez.properties = {
    bluez5.roles = [ a2dp_sink a2dp_source hfp_hf hfp_ag ]
    bluez5.enable-msbc = true
}
EOF

# 3. Restart the audio/Bluetooth stack
echo "[3/4] Restarting bluetooth + PipeWire stack..."
sudo systemctl daemon-reload
sudo systemctl restart bluetooth
systemctl --user restart pipewire pipewire-pulse wireplumber
sleep 3

# 4. Ensure the phone is trusted and connected (HFP authorization auto-accepted)
echo "[4/4] Ensuring phone $PHONE_MAC is trusted and connected..."
bluetoothctl trust "$PHONE_MAC" || true
# Use an agent to auto-answer any "Authorize service" prompt the HFP connect raises.
{
    sleep 1
    echo "agent on"
    sleep 1
    echo "default-agent"
    sleep 1
    echo "connect $PHONE_MAC"
    sleep 8
    echo "quit"
} | bluetoothctl >/dev/null 2>&1 || true

echo ""
echo "=== Status ==="
wpctl status 2>/dev/null | sed -n '1,25p'
echo ""
echo "NOTE:"
echo "  - With HFP active the phone streams call audio to the PC automatically."
echo "  - Earbuds/headphones sharing this adapter cannot stream media (A2DP)"
echo "    at the same time as phone call audio (HFP) — disconnect them first."
echo "  - On the phone, ensure the PC is enabled under Settings > Bluetooth"
echo "    > <PC name> > 'Call audio' (and 'Media audio' for A2DP)."
