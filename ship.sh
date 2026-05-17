#!/usr/bin/env bash
# ship.sh — branch-aware deploy with hard guardrails.
# Testing branch -> hajj-ops-test Worker (testhajj.shuki.tech)
# Main branch    -> Cloudflare Pages (hajj.shuki.tech)
set -e

if [ -z "$1" ]; then
  echo "Usage: ./ship.sh \"commit message\""
  exit 1
fi

MSG="$1"
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# === HARD GUARDRAIL: wrangler.jsonc must target hajj-ops-test ===
WRANGLER_NAME=$(python3 -c "import re, sys; m=re.search(r'\"name\"\s*:\s*\"([^\"]+)\"', open('wrangler.jsonc').read()); print(m.group(1) if m else '')")
if [ "$WRANGLER_NAME" != "hajj-ops-test" ]; then
  echo "ABORT: wrangler.jsonc 'name' is '$WRANGLER_NAME', expected 'hajj-ops-test'."
  echo "This protects against accidentally deploying testing code to production."
  exit 1
fi

APP_CHANGED=$(git diff --name-only HEAD 2>/dev/null | grep -E '\.(html|js|sql|jsonc)$|^_worker\.js$' | head -1)
if [ -n "$APP_CHANGED" ]; then
  echo "App code changed -> bumping version"
  ./bump.sh patch
fi

git add -A
if git diff --cached --quiet; then
  echo "Nothing to commit"
  exit 0
fi

git -c user.email=alshudukhi.a@gmail.com \
    -c user.name="Ahmed Alshudukhi" \
    commit -m "$MSG"

echo "Pulling $BRANCH (no rebase)..."
git pull --no-rebase origin "$BRANCH" 2>&1 | tail -2 || true

echo "Pushing $BRANCH to origin..."
git push origin "$BRANCH" 2>&1 | tail -2

if [ "$BRANCH" = "testing" ]; then
  echo "Local wrangler deploy to hajj-ops-test..."
  wrangler deploy 2>&1 | tail -8
  VERIFY_URL="https://hajj-ops-test.alshudukhi-a.workers.dev"
  sleep 10
elif [ "$BRANCH" = "main" ]; then
  VERIFY_URL="https://hajj.shuki.tech"
  echo "Cloudflare Pages auto-deploys from main; waiting 100s..."
  sleep 100
fi

if [ -n "$APP_CHANGED" ] && [ -n "$VERIFY_URL" ]; then
  RAND="ship-$(date +%s%N)-$RANDOM"
  PROD_V=$(curl -sH "Cache-Control: no-cache" "$VERIFY_URL/assets/version.js?$RAND" | grep -oE '"[0-9]+\.[0-9]+\.[0-9]+"' | head -1 | tr -d '"')
  LOCAL_V=$(cat VERSION)
  if [ "$PROD_V" = "$LOCAL_V" ]; then
    echo "OK deployed: v$PROD_V live at $VERIFY_URL"
    [ "$BRANCH" = "testing" ] && echo "   Custom domain: https://testhajj.shuki.tech (Cloudflare direct)"
  else
    echo "MISMATCH: local v$LOCAL_V, prod v$PROD_V (edge cache may need 1-2 min)"
  fi
fi
