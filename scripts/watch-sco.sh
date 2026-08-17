#!/usr/bin/env bash
# Watches for the Bluetooth HFP/SCO audio nodes and captures their full
# properties + negotiated codec/sample rate the moment a call goes active.
#
# Usage:   bash scripts/watch-sco.sh [PHONE_MAC]
#
# Start it, then place a call on the phone and route audio to the PC. It
# polls pw-dump once per second and, when the bluez_input/bluez_output SCO
# nodes appear, prints everything needed to determine the codec (CVSD 8 kHz
# vs mSBC 16 kHz) and how the app should match the nodes.
#
# Read-only. Stops automatically ~20s after the call ends or after a timeout.

set -u

PHONE_MAC="${1:-DC:B7:2E:2E:31:3B}"
WANT="$(echo "$PHONE_MAC" | tr '[:lower:]' '[:upper:]' | tr -cd '0-9A-F')"
MAX_IDLE=20
MAX_WAIT=300

echo "Watching for SCO nodes for $PHONE_MAC (every 1s, max ${MAX_WAIT}s)…"
echo "Place a call on the phone and route call audio to the PC now."
echo

started=0
idle=0
for i in $(seq 1 "$MAX_WAIT"); do
    nodes=$(pw-dump 2>/dev/null | python3 - "$WANT" <<'EOF'
import json, sys, re
want = sys.argv[1]
try:
    arr = json.load(sys.stdin)
except Exception:
    sys.exit(0)
hits = []
for o in arr:
    if o.get("type") != "PipeWire:Interface:Node":
        continue
    p = o.get("info", {}).get("props", {})
    name = p.get("node.name", "")
    lname = name.lower()
    if "bluez_input." not in lname and "bluez_output." not in lname:
        continue
    if want:
        m = re.match(r"bluez_(?:input|output)\.([0-9a-f_]+)\.", lname)
        got = m.group(1).replace("_", "").upper() if m else ""
        addr = (p.get("api.bluez5.address") or p.get("device.name") or "").upper().replace(":", "").replace("-", "").replace("_", "")
        if want not in got and want not in addr:
            continue
    hits.append(name)
print("\n".join(hits))
EOF
)
    if [ -n "$nodes" ]; then
        started=1
        idle=0
        break
    fi
    sleep 1
done

if [ "$started" -eq 0 ]; then
    echo "No SCO nodes appeared within ${MAX_WAIT}s. Is the call active and routed to the PC?"
    exit 1
fi

echo "=== SCO nodes detected! Capturing details ==="
pw-dump 2>/dev/null | python3 - "$WANT" <<'EOF'
import json, sys
want = sys.argv[1]
try:
    arr = json.load(sys.stdin)
except Exception:
    sys.exit(1)

for o in arr:
    if o.get("type") != "PipeWire:Interface:Node":
        continue
    p = o.get("info", {}).get("props", {})
    name = p.get("node.name", "")
    lname = name.lower()
    if "bluez_input." not in lname and "bluez_output." not in lname:
        continue
    if want:
        m = re.match(r"bluez_(?:input|output)\.([0-9a-f_]+)\.", lname)
        got = m.group(1).replace("_", "").upper() if m else ""
        addr = (p.get("api.bluez5.address") or p.get("device.name") or "").upper().replace(":", "").replace("-", "").replace("_", "")
        if want not in got and want not in addr:
            continue
    print("=" * 60)
    print("node:", name)
    interesting = ["media.class", "media.name", "media.role", "api.bluez5.role",
                   "api.bluez5.profile", "api.bluez5.codec", "api.bluez5.address",
                   "api.bluez5.features", "api.bluez5.transport", "format.rate",
                   "format.channels", "format.dsp", "device.bus", "device.name",
                   "device.profile.name", "object.linger", "node.description"]
    for k in sorted(p.keys()):
        if any(s in k.lower() for s in interesting) or "codec" in k.lower():
            print(f"    {k} = {p[k]}")
    for prm in o.get("info", {}).get("params", []):
        key = prm.get("key", "")
        if key in ("EnumFormat", "Format"):
            print(f"    param {key}: {json.dumps(prm.get('value'))}")
EOF

echo
echo "=== Active bluez card profile ==="
pactl list cards 2>/dev/null | awk '
    /Name: bluez_card/ { inblue=1; next }
    inblue && /^Card #/ { inblue=0 }
    inblue && /Active Profile:/ { sub(/^[[:space:]]*/, ""); print "  " $0 }
'

echo
echo "=== Link map (call audio routing) ==="
pw-link -l 2>/dev/null | grep -iE "bluez|sco|headset|handsfree" | head -20

echo
echo "=== Watching until the call ends (max ${MAX_IDLE}s idle)… ==="
for i in $(seq 1 30); do
    sleep 1
    if ! pw-dump 2>/dev/null | python3 - "$WANT" <<'EOF' | grep -q .
import json, sys
want = sys.argv[1]
try:
    arr = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for o in arr:
    if o.get("type") != "PipeWire:Interface:Node":
        continue
    p = o.get("info", {}).get("props", {})
    lname = p.get("node.name", "").lower()
    if "bluez_input." in lname or "bluez_output." in lname:
        sys.stdout.write("x")
EOF
    then
        idle=$((idle + 1))
        if [ "$idle" -ge "$MAX_IDLE" ]; then
            echo "Call ended (SCO nodes gone). Done."
            break
        fi
    else
        idle=0
    fi
done
