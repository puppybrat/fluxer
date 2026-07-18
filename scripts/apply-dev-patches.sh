#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Reapplies the working-tree-only dev patches this VPS needs.
#
# These patches are deliberately never committed (they would break production
# builds), which means they do not survive a branch switch, rebase, or
# `git restore`. Losing the GatewayCompression one silently broke the
# fluxer-dev.obyr.us gateway handshake on 2026-07-18; this script exists so
# recovery is one command instead of an investigation.
#
# Idempotent: every patch checks its own state first, so running this twice is
# a no-op. It never touches git — leaving the edits uncommitted is the point.
#
# Usage: scripts/apply-dev-patches.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GATEWAY_COMPRESSION="$REPO_ROOT/fluxer_app/src/features/gateway/transport/GatewayCompression.ts"
RSPACK_CONFIG="$REPO_ROOT/fluxer_app/rspack.config.mjs"

applied=()
skipped=()

fail() {
	echo "ERROR: $*" >&2
	exit 1
}

# Patch 1 — force gateway compression to 'none' in development.
#
# The zstd decompression WASM in this environment is a hand-encoded no-op stub
# (the real one needs the Rust toolchain, which only exists inside Docker), so
# negotiating zstd-stream makes the HELLO handshake time out and the client
# reconnect-loops on the splash screen.
patch_gateway_compression() {
	[[ -f "$GATEWAY_COMPRESSION" ]] || fail "not found: $GATEWAY_COMPRESSION"

	if grep -q "process.env.NODE_ENV === 'development'" "$GATEWAY_COMPRESSION"; then
		echo "  GatewayCompression.ts     already applied — skipped"
		skipped+=("GatewayCompression.ts")
		return
	fi

	perl -0777 -pi -e '
		s{(export function getPreferredCompression\(\): CompressionType \{\n)(\treturn \x27zstd-stream\x27;\n\})}
		 {$1\t// DEV-ONLY WORKING-TREE PATCH — DO NOT COMMIT. The zstd decompression WASM is a stub\n\t// no-op in this dev environment, so negotiating zstd-stream hangs the HELLO handshake.\n\tif (process.env.NODE_ENV === \x27development\x27) {\n\t\treturn \x27none\x27;\n\t}\n$2}
	' "$GATEWAY_COMPRESSION"

	grep -q "process.env.NODE_ENV === 'development'" "$GATEWAY_COMPRESSION" ||
		fail "GatewayCompression.ts patch did not apply — getPreferredCompression() may have changed upstream"

	echo "  GatewayCompression.ts     applied"
	applied+=("GatewayCompression.ts")
}

# Patch 2 — readable CSS class names in devtools.
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
patch_gateway_compression
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
			GatewayCompression.ts) echo "  $GATEWAY_COMPRESSION" ;;
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
