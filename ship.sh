#!/usr/bin/env bash
# ship.sh — one-command deploy: bump version, commit, pull, push, verify.
# Usage: ./ship.sh "your commit message"
set -e

if [ -z "$1" ]; then
  echo "Usage: ./ship.sh \"commit message\""
  echo "Example: ./ship.sh \"fix: triage dropdown\""
  exit 1
fi

MSG="$1"

# Detect if any app code changed (HTML, JS, _worker.js) — only bump version then.
# Data-only commits (CSV, JSON in /data) don't need a cache-bust.
APP_CHANGED=$(git diff --name-only HEAD 2>/dev/null | grep -E '\.(html|js|sql)$|^_worker\.js$' | head -1)

if [ -n "$APP_CHANGED" ]; then
  echo "▸ App code changed — bumping version"
  ./bump.sh patch
else
  echo "▸ No app code changes — skipping version bump"
fi

# Stage everything
git add -A

# Allow empty commit if just pulling
if git diff --cached --quiet; then
  echo "▸ Nothing to commit"
  exit 0
fi

# Commit
git -c user.email=alshudukhi.a@gmail.com \
    -c user.name="Ahmed Alshudukhi" \
    commit -m "$MSG"

# Pull (no rebase, allow merge if needed)
git pull --no-rebase origin main 2>&1 | tail -2

# Push
echo "▸ Pushing to origin/main..."
git push origin main 2>&1 | tail -2

# Wait for Cloudflare Pages deploy
if [ -n "$APP_CHANGED" ]; then
  echo "▸ Waiting 100s for Cloudflare deploy..."
  sleep 100

  # Verify via version.js
  PROD_V=$(curl -s "https://hajj.shuki.tech/assets/version.js?nocache=$RANDOM" | grep -oE '"[0-9]+\.[0-9]+\.[0-9]+"' | tr -d '"')
  LOCAL_V=$(cat VERSION)

  if [ "$PROD_V" = "$LOCAL_V" ]; then
    echo "✅ Deployed: v$PROD_V is live at https://hajj.shuki.tech"
  else
    echo "⚠️  Mismatch — local: v$LOCAL_V, prod: v$PROD_V (deploy may still be running)"
  fi
else
  echo "✓ Pushed (no deploy verification needed)"
fi
