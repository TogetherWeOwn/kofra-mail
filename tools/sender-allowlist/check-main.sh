#!/usr/bin/env bash
set -euo pipefail

# Re-runs keep the original dispatch SHA, which may no longer be safe to deploy.
if ! latest=$(GIT_TERMINAL_PROMPT=0 git -c credential.helper= ls-remote --exit-code origin refs/heads/main 2>/dev/null | cut -f1) \
  || [[ -z "${GITHUB_SHA:-}" || "$latest" != "$GITHUB_SHA" || "$(git rev-parse HEAD 2>/dev/null)" != "$GITHUB_SHA" ]]; then
  printf '%s\n' 'Cannot verify this checkout is current main; start a fresh dispatch.' >&2
  exit 1
fi
