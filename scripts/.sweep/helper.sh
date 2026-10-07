#!/usr/bin/env bash
# Helpers for the config functionality sweep (dev-only, not part of the app).
B=http://localhost:3000
CK=/tmp/ck.txt

csrf() {
  curl -s -b "$CK" -c "$CK" "$B$1" | grep -o 'name="_csrf" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"$//'
}

post() {
  # post <path> <data...>
  local p="$1"; shift
  local t; t=$(csrf "$1")
  curl -s -b "$CK" -c "$CK" -o /tmp/out.html -w "%{http_code} %{redirect_url}\n" -X POST "$B$p" --data-urlencode "_csrf=$t" "$@"
}
