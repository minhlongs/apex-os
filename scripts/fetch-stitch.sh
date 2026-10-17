#!/usr/bin/env bash
# Reliable GCS HTML/Screenshot Downloader for Stitch-Loop
set -euo pipefail

URL="${1:-}"
DEST="${2:-}"

if [ -z "$URL" ] || [ -z "$DEST" ]; then
  echo "Usage: $0 <downloadUrl> <destPath>" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
curl -fsSL -L "$URL" -o "$DEST"
echo "Downloaded $(wc -c < "$DEST" | tr -d ' ') bytes -> $DEST"
