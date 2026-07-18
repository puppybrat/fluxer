#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Reapplies the working-tree-only dev patches this VPS needs.
#
# These patches are deliberately never committed (they would break production
# builds), which means they do not survive a branch switch, rebase, or
# `git restore`. Losing one silently broke the fluxer-dev.obyr.us gateway
# handshake on 2026-07-18; this script exists so recovery is one command
# instead of an investigation.
#
# The GatewayCompression patch that motivated this script was removed once
# upstream adopted the same dev-mode behaviour in getPreferredCompression().
#
# Idempotent: every patch checks its own state first, so running this twice is
# a no-op. It never touches git — leaving the edits uncommitted is the point.
#
# Usage: scripts/apply-dev-patches.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RSPACK_CONFIG="$REPO_ROOT/fluxer_app/rspack.config.mjs"

applied=()
skipped=()

fail() {
	echo "ERROR: $*" >&2
	exit 1
}

# Patch 1 — readable CSS class names in devtools.
#
# Uses plain [local] in development instead of the hashed name, so devtools
# shows `container` rather than `SelectModePanel.module__container___ZjAxND`.
# Production is unaffected: isProduction keeps the hashed form. Applies to both
# the css/module and css/auto generator entries.
patch_rspack_local_ident_name() {
	[[ -f "$RSPACK_CONFIG" ]] || fail "not found: $RSPACK_CONFIG"

	if grep -q "localIdentName: isProduction ?" "$RSPACK_CONFIG"; then
		echo "  rspack.config.mjs         already applied — skipped"
		skipped+=("rspack.config.mjs")
		return
	fi

	grep -q "isProduction" "$RSPACK_CONFIG" ||
		fail "rspack.config.mjs has no isProduction binding — refusing to patch"

	sed -i "s/localIdentName: '\[name\]__\[local\]___\[hash:base64:6\]'/localIdentName: isProduction ? '[name]__[local]___[hash:base64:6]' : '[local]'/g" "$RSPACK_CONFIG"

	local count
	count="$(grep -c "localIdentName: isProduction ?" "$RSPACK_CONFIG" || true)"
	[[ "$count" == "2" ]] ||
		fail "rspack.config.mjs: expected 2 patched localIdentName entries (css/module, css/auto), found $count"

	echo "  rspack.config.mjs         applied"
	applied+=("rspack.config.mjs")
}

echo "Applying dev-only working-tree patches..."
echo
patch_rspack_local_ident_name
echo
echo "Summary: ${#applied[@]} applied, ${#skipped[@]} already present"

if [[ ${#applied[@]} -gt 0 ]]; then
	echo
	echo "Applied:"
	for name in "${applied[@]}"; do echo "  - $name"; done
	echo
	echo "Files modified (left uncommitted, as intended):"
	for name in "${applied[@]}"; do
		case "$name" in
			rspack.config.mjs) echo "  $RSPACK_CONFIG" ;;
		esac
	done
	echo
	echo "Rebuild for changes to take effect:"
	echo "  cd $REPO_ROOT/fluxer_app && rspack build --mode development --watch"
	echo "  cd ~/fluxer && docker compose restart app-proxy-dev"
fi

if [[ ${#skipped[@]} -gt 0 ]]; then
	echo
	echo "Already present (no change):"
	for name in "${skipped[@]}"; do echo "  - $name"; done
fi
