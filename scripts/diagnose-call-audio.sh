#!/usr/bin/env bash
# Read-only HFP call-audio diagnostic for Diy Phone Link (Linux/BlueZ + PipeWire).
#
# Run this WHILE A CALL IS TALKING (call audio routed to PC speakers) to capture:
#   1. The negotiated SCO codec / sample rate (8000 = CVSD narrowband = muffled,
#      16000 = mSBC wideband = clear)  -> src/audio/AudioBridge.js + WirePlumber
#   2. The active bluez card profile during the call
#   3. Which PC source/sink is actually linked to the phone (pw-link)
#   4. Mic volume/gain of the captured input
#
# Safe: only runs read-only pw-dump / pactl / pw-link / bluetoothctl queries.

set -u

log() { printf '\n=== %s ===\n' "$*"; }

PHONE_MAC="${1:-DC:B7:2E:2E:31:3B}"

log "Phone (arg 1: $PHONE_MAC)"

log "1. Bluetooth HFP connection state"
bluetoothctl info "$PHONE_MAC" 2>/dev/null | grep -iE "Name:|Connected:|UUID: Handsfree|UUID: Headset" || echo "(bluetoothctl unavailable)"

log "2. Active bluez card profile during the call"
pactl list cards 2>/dev/null | awk '
    /Name: bluez_card/ { inblue=1; next }
    inblue && /^Card #/ { inblue=0 }
    inblue && /Active Profile:/ { sub(/^[[:space:]]*/, ""); print "  " $0 }
'
echo
echo "Available profiles on the card:"
pactl list cards 2>/dev/null | awk '
    /Name: bluez_card/ { inblue=1; next }
    inblue && /^Card #/ { inblue=0 }
    inblue && /^[[:space:]]*[a-z0-9._-]+: / { line=$0; sub(/^[[:space:]]*/, "", line); sub(/:.*/, "", line); print "   " line }
' | sort -u

log "3. Negotiated SCO codec + sample rate (the important bit)"
pw-dump 2>/dev/null | python3 - <<'EOF'
import json, sys, traceback
try:
    arr = json.load(sys.stdin)
except Exception:
    traceback.print_exc()
    sys.exit(1)

HFP_ROLES = ("hfp_hf", "hfp-hf", "hsp_hs", "hsp-hs", "hfp_ag", "hfp-ag", "hsp_ag", "hsp-ag")

def find_rate(o):
    # Rate can live in props (format.rate) or in the node's EnumFormat params.
    p = o.get("info", {}).get("props", {})
    rate = p.get("format.rate")
    if rate:
        return rate
    rates = set()
    for prm in o.get("info", {}).get("params", []):
        if prm.get("key") not in ("EnumFormat", "Format"):
            continue
        val = prm.get("value", {})
        if isinstance(val, list):
            entries = val
        else:
            entries = [val]
        for e in entries:
            if not isinstance(e, dict):
                continue
            r = e.get("rate") or (e.get("info") or {}).get("rate")
            if isinstance(r, list):
                rates.update(str(x) for x in r)
            elif r:
                rates.add(str(r))
    if rates:
        return ",".join(sorted(rates))
    return None

found_any = False
for o in arr:
    if o.get("type") != "PipeWire:Interface:Node":
        continue
    p = o.get("info", {}).get("props", {})
    name = p.get("node.name", "")
    bus = p.get("device.bus", "")
    lname = name.lower()
    if bus != "bluetooth" and "bluez" not in lname:
        continue
    found_any = True
    role = p.get("api.bluez5.role", "")
    profile = p.get("api.bluez5.profile", "")
    media = p.get("media.class", "")
    codec = p.get("api.bluez5.codec", "?")
    addr = p.get("api.bluez5.address", p.get("device.name", "?"))
    rate = find_rate(o)
    is_hfp = (role in HFP_ROLES or profile in HFP_ROLES
              or "sco" in lname or "headset" in lname or "handsfree" in lname)
    tag = "SCO/HFP" if is_hfp else ("MIDI" if "midi" in lname else "other")
    print(f"  [{tag}] node={name}\n    media.class={media or '?'}  role={role or '?'}  profile={profile or '?'}\n"
          f"    codec={codec}  sample_rate={rate}  device={addr}")
    if is_hfp and rate is not None:
        try:
            kbps = int(rate)
            if kbps <= 8000:
                print("    >>> NARROWBAND CVSD (8 kHz) -> this is why outgoing sounds muffled")
            else:
                print("    >>> WIDEBAND mSBC (16 kHz)  -> codec is fine; problem is the mic")
        except (TypeError, ValueError):
            pass
if not found_any:
    print("  (no bluez nodes present — is the call routed to the PC and is the phone connected?)")
EOF

log "4. pw-link links involving the phone (which PC mic/speaker is routed)"
pw-link -l 2>/dev/null | grep -iE "bluez|sco|headset|handsfree|->|<-" | head -40
echo
echo "All currently linked edges (output, input):"
pw-link -l 2>/dev/null | grep -vE "^\s" | head -40

log "5. PC input (mic) that would be captured"
pactl get-default-source 2>/dev/null
pactl list sources 2>/dev/null | grep -iE "Name:|Description:|Volume:|Mute:|State:|Latency" | head -30

log "6. Quick mic audio path sanity check (5s capture, silent = OK)"
def_src="$(pactl get-default-source 2>/dev/null | tr -d '\r\n')"
if [ -n "$def_src" ]; then
    if command -v pw-cat >/dev/null 2>&1; then
        timeout 5 pw-cat --record --channels=1 --rate=16000 --format=s16 "/tmp/dpl-mic-test.wav" 2>/dev/null
        [ -f "/tmp/dpl-mic-test.wav" ] && ls -l "/tmp/dpl-mic-test.wav"
    elif command -v arecord >/dev/null 2>&1; then
        timeout 5 arecord -f cd -t wav -d 5 /tmp/dpl-mic-test.wav >/dev/null 2>&1
        [ -f "/tmp/dpl-mic-test.wav" ] && ls -l "/tmp/dpl-mic-test.wav"
    else
        echo "(no pw-cat/arecord for sample capture)"
    fi
else
    echo "(no default source)"
fi

log "DONE"
echo "Interpretation:"
echo "  * sample_rate 8000  -> CVSD narrowband. Fix = mSBC wideband (WirePlumber/BlueZ)."
echo "  * sample_rate 16000 -> mSBC wideband. Fix = better mic selection/gain."
echo "  * No SCO node listed -> HFP/SCO link is not up during the call."
