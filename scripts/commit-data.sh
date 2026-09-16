#!/usr/bin/env bash
set -euo pipefail
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
if git diff --cached --quiet; then exit 0; fi
git commit -m "${1:-Update generated site data}"
for attempt in 1 2 3; do
  git pull --rebase origin main
  if git push origin HEAD:main; then exit 0; fi
  sleep "$((attempt * 2))"
done
echo "Push failed after three attempts; no force push was attempted." >&2
exit 1
