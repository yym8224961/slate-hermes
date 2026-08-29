#!/bin/sh
set -eu

RENEWLET_FINANCE_HOME=${RENEWLET_FINANCE_HOME:-/vol1/1000/Docker/slate-ready/data/renewlet-finance-sync}
RENEWLET_FINANCE_ENV_FILE=${RENEWLET_FINANCE_ENV_FILE:-$RENEWLET_FINANCE_HOME/finance.env}
RENEWLET_FINANCE_RUNTIME=${RENEWLET_FINANCE_RUNTIME:-$RENEWLET_FINANCE_HOME/renewlet-finance-bun}
RENEWLET_FINANCE_PROGRAM=${RENEWLET_FINANCE_PROGRAM:-$RENEWLET_FINANCE_HOME/renewlet-finance-sync.js}
RENEWLET_FINANCE_LOG=${RENEWLET_FINANCE_LOG:-$RENEWLET_FINANCE_HOME/finance-sync.log}
RENEWLET_FINANCE_LOCK=${RENEWLET_FINANCE_LOCK:-$RENEWLET_FINANCE_HOME/finance-sync.lock}

if [ ! -r "$RENEWLET_FINANCE_ENV_FILE" ]; then
  echo "Missing finance sync environment file: $RENEWLET_FINANCE_ENV_FILE" >&2
  exit 1
fi

RENEWLET_FINANCE_ENV_MODE=$(stat -c '%a' "$RENEWLET_FINANCE_ENV_FILE" 2>/dev/null || stat -f '%Lp' "$RENEWLET_FINANCE_ENV_FILE" 2>/dev/null || true)
case "$RENEWLET_FINANCE_ENV_MODE" in
  ''|*[!0-7]*)
    echo "Unable to verify finance sync environment file permissions." >&2
    exit 1
    ;;
  *[1-7][0-7]|*[0-7][1-7])
    echo "Finance sync environment file must not grant group or world permissions (expected mode 600)." >&2
    exit 1
    ;;
esac

if [ ! -x "$RENEWLET_FINANCE_RUNTIME" ]; then
  echo "Missing finance sync runtime: $RENEWLET_FINANCE_RUNTIME" >&2
  exit 1
fi

if [ ! -r "$RENEWLET_FINANCE_PROGRAM" ]; then
  echo "Missing finance sync program: $RENEWLET_FINANCE_PROGRAM" >&2
  exit 1
fi

umask 077
set -a
# shellcheck disable=SC1090
. "$RENEWLET_FINANCE_ENV_FILE"
set +a

if [ -f "$RENEWLET_FINANCE_LOG" ]; then
  RENEWLET_FINANCE_LOG_BYTES=$(wc -c < "$RENEWLET_FINANCE_LOG")
  if [ "$RENEWLET_FINANCE_LOG_BYTES" -gt 1048576 ]; then
    mv -f "$RENEWLET_FINANCE_LOG" "$RENEWLET_FINANCE_LOG.1"
  fi
fi

if command -v flock >/dev/null 2>&1; then
  flock -n "$RENEWLET_FINANCE_LOCK" "$RENEWLET_FINANCE_RUNTIME" "$RENEWLET_FINANCE_PROGRAM" >> "$RENEWLET_FINANCE_LOG" 2>&1
  exit $?
fi

"$RENEWLET_FINANCE_RUNTIME" "$RENEWLET_FINANCE_PROGRAM" >> "$RENEWLET_FINANCE_LOG" 2>&1
