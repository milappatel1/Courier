#!/bin/sh
# Decode a saved REA capture_web_screenshot result to PNG (+ a downscaled copy for review).
# usage: shot.sh <result.txt> <out.png>
set -e
jq -r '.normalized_result.artifact.data_base64' "$1" | base64 -d > "$2"
sips -Z 1200 "$2" --out "${2%.png}-small.png" >/dev/null
