#!/usr/bin/env bash
# Sandbox-restart recovery — idempotent. Run after ANY environment reset:
#   bash scripts/restore-env.sh
# Restores the four things restarts wipe: node_modules, git remote,
# git identity, and SSH key permissions. Safe to run when nothing is broken
# (it detects and skips each part).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -d node_modules/.bin ] && [ -x node_modules/.bin/vitest ]; then
  echo "node_modules   ok"
else
  echo "node_modules   reinstalling…"
  npm install --no-audit --no-fund
fi

if git remote get-url origin >/dev/null 2>&1; then
  echo "git remote     ok ($(git remote get-url origin))"
else
  git remote add origin git@github.com:Darrelongithub/Project-AA.git
  echo "git remote     restored"
fi

git config user.name  >/dev/null 2>&1 || git config user.name  "Arena Agent"
git config user.email >/dev/null 2>&1 || git config user.email "agent@arena.local"
echo "git identity   ok"

if [ -f ~/.ssh/id_ed25519_gh_project_aa ]; then
  chmod 600 ~/.ssh/id_ed25519_gh_project_aa
  echo "ssh key perms  ok"
else
  echo "ssh key        MISSING — push will fail until it is restored"
fi

echo "HEAD $(git log --oneline -1)"
