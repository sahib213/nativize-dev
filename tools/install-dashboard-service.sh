#!/bin/bash
# Install the Nativize dashboard as an always-on background service (macOS launchd).
# It starts automatically at login and restarts itself if it ever stops —
# so the dashboard is always available on your Mac / WiFi.
#
#   Run once:   bash tools/install-dashboard-service.sh
#   Stop/remove: bash tools/install-dashboard-service.sh uninstall
#
# Secrets are NOT stored here — the service reads ~/nativize/.env.local at runtime.
set -e

LABEL="com.nativize.dashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
LOG="$DIR/dashboard.log"

if [ "$1" = "uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Dashboard service removed. (It will no longer start on its own.)"
  exit 0
fi

if [ -z "$NODE" ]; then echo "node not found in PATH"; exit 1; fi
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/tools/dashboard.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 1
echo "Installed and started: $LABEL"
echo "  • Starts automatically at login, restarts itself if it stops."
echo "  • Logs: $LOG"
echo "  • Stop/remove any time:  bash tools/install-dashboard-service.sh uninstall"
