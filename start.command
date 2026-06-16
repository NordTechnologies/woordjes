#!/bin/bash
# Woordjes v0 — local test server.
# Double-click this file (or run it) to serve the app on your Wi-Fi.
# Then open the printed http://<your-mac-ip>:8000 link in Safari on your iPhone
# (iPhone must be on the same Wi-Fi network).
cd "$(dirname "$0")/public" || exit 1
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "localhost")
echo ""
echo "  Woordjes is running."
echo "  On your iPhone (same Wi-Fi), open Safari and go to:"
echo ""
echo "      http://$IP:8000"
echo ""
echo "  Then tap Share -> 'Add to Home Screen' to use it like an app."
echo "  Press Control-C here to stop the server."
echo ""
python3 -m http.server 8000 --bind 0.0.0.0
