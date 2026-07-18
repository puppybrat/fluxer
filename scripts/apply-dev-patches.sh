#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Reapplies the working-tree-only dev patches this VPS needs.
#
# There are currently NO patches to apply. Both original ones are gone:
#
#   GatewayCompression.ts — removed once upstream adopted the same dev-mode
#   behaviour in getPreferredCompression(), making the patch a permanent no-op.
#
#   rspack.config.mjs (localIdentName '[local]') — removed because it is
#   actively harmful, not merely obsolete. Dropping the [name]__ prefix and
#   [hash] suffix collapses every CSS module's classes into bare names, and at
#   this codebase's size they collide en masse: the 2026-07-18 build had 121
#   distinct `.container` rules in main.css alone, all resolving to one class.
#   Last-rule-wins then silently overwrites most component layout, which is what
#   rendered fluxer-dev.obyr.us without its server rail or channel list styling.
#   CSS collisions raise no console errors, so it presents as inexplicable
#   visual breakage. Readable devtools class names are not worth that.
#
# The script is kept as the documented home for any future working-tree-only
# patch, and as a record of why these two are not coming back. If you add one,
# follow the old shape: a function that checks its own state first so the script
# stays idempotent, and never touch git — leaving the edits uncommitted is the
# point, since committing them would break production builds.
#
# Usage: scripts/apply-dev-patches.sh

set -euo pipefail

echo "Applying dev-only working-tree patches..."
echo
echo "  no patches are currently defined — nothing to do"
echo
echo "See the comment at the top of this file for why the previous two were removed."
