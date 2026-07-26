#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# preflight-image-check.sh — compare two fluxer-api images before a deploy.
#
# WHY THIS EXISTS
#   A deploy once shipped an image built from a stale branch. RelocateMessagesController was
#   silently absent, the /channels/relocate-log route 404'd, and it took an emergency rollback to
#   undo. Nothing about the image looked wrong: it built, it started, it passed health checks. The
#   only way to catch that class of failure is to compare what the candidate image CONTAINS against
#   what the currently-deployed image contains, before promoting it.
#
#   This automates the checks that have been run by hand on every deploy since.
#
# WHAT IT CHECKS (all against the images, never against a running container)
#   1. Registration order — that specific controllers register ahead of others whose parameterised
#      routes would otherwise shadow them. Defaults to the exact historical bug:
#      RelocateMessagesController must register before ChannelController, or the literal
#      GET /channels/relocate-log is swallowed by GET /channels/:channel_id.
#   2. Dropped controllers — any controller present in OLD but missing from NEW is a hard failure.
#      This is the generalised form of the original incident: it does not care WHICH feature went
#      missing, only that the candidate is not a regression in surface area. Controllers new in NEW
#      are reported informationally, never as failures.
#   3. Dropped registrations — a controller whose file survives but whose registration call-site
#      disappeared. Same failure mode as a missing file, but invisible to a file listing.
#   4. Dropped ROUTES — the finest-grained check, and the one that most directly matches the
#      incident, which was a lost route rather than a lost file. Controller-level checks are blind
#      to a feature that extends an EXISTING controller: validating this script against the real
#      pre-Cast image found 82 controllers before and after, 0 added, 0 dropped, while the route
#      inventory correctly showed the two genuinely new endpoints. Any route literal in OLD that is
#      absent from NEW is a hard failure.
#      Heuristic: route literals are single-quoted '/...' strings inside *Controller.ts. A route
#      registered elsewhere (e.g. an installer helper) will not be inventoried.
#   5. Known-critical route markers — fixed strings that must appear somewhere in NEW's source.
#      Configurable; the built-in list covers the relocate-messages and Cast/IC routes.
#      CAVEAT: this is a whole-tree fixed-string grep, so a marker can be satisfied by a comment or
#      an unrelated helper that merely mentions the string. Against an image with
#      RelocateMessagesController deliberately deleted, THIS check still passed — the route string
#      survived in a comment and in a repository file — while checks 1-4 all correctly failed. Treat
#      it as a cheap canary for "this feature is entirely absent", never as proof a route is wired
#      up; checks 2-4 are the real safety net.
#
# HOW IT READS THE IMAGES
#   fluxer_api runs its TypeScript directly via tsx (see fluxer_api/Dockerfile: the CMD is
#   `tsx src/AppEntrypoint.ts`), so controllers are plain source files inside the image. The script
#   uses `docker create` + `docker cp` to copy the source tree out of a container that is never
#   started — no image is executed, so a candidate image cannot run any code during preflight.
#
# SCOPE — fluxer-api ONLY
#   fluxer-messages is Rust and compiles to a binary; it has no controller-registration pattern to
#   read, so none of the checks above transfer. Verifying it would need a different technique
#   entirely — e.g. `nm`/`strings` over the compiled binary for expected route or handler symbols,
#   or comparing `--version`/build metadata baked in at compile time. That is deliberately NOT
#   attempted here rather than silently assumed safe: running this script says nothing about
#   fluxer-messages, and a fluxer-messages deploy still needs its own verification.
#
# USAGE
#   scripts/preflight-image-check.sh --old <image> --new <image> [options]
#   scripts/preflight-image-check.sh <old-image> <new-image>
#
#   --old IMAGE          Currently-deployed image (reference, tag, or repo@sha256:...)
#   --new IMAGE          Candidate image to promote
#   --markers FILE       Newline-delimited fixed strings required in NEW (overrides built-ins;
#                        blank lines and #-comments ignored)
#   --order A:B:FILE     Assert A registers before B in FILE (path relative to the api root).
#                        Repeatable. Overrides the built-in default when given at least once.
#   --api-root PATH      Path to the api source dir inside the image
#                        (default: /usr/src/app/fluxer_api/src/api)
#   --pull               docker pull an image if it is not present locally (default: fail instead)
#   --keep               Keep the extracted trees and print where they are
#   -h, --help           This help
#
# EXIT CODES
#   0 = all checks passed, 1 = at least one check failed, 2 = usage or extraction error.

set -uo pipefail

readonly DEFAULT_API_ROOT='/usr/src/app/fluxer_api/src/api'

# Registration-order assertions: "BEFORE:AFTER:FILE" — BEFORE must register earlier than AFTER.
DEFAULT_ORDER_SPECS=(
	'RelocateMessagesController:ChannelController:channel/controllers/index.ts'
)

# Fixed strings that must be present somewhere in NEW's api source. Route literals mostly, but any
# fixed string works — a service class name is a fine marker for a feature with no single route.
DEFAULT_MARKERS=(
	'/channels/relocate-log'
	'/channels/relocate-messages'
	"'/guilds/:guild_id/cast'"
	'/guilds/:guild_id/cast/all-characters'
	'/guilds/:guild_id/cast/owner-accounts'
	'/guilds/:guild_id/cast/characters/:character_id'
	'/guilds/:guild_id/cast/characters/:character_id/primary'
	'MessageIcResolutionService'
	'resolveEffectiveCast'
)

OLD_IMAGE=''
NEW_IMAGE=''
MARKERS_FILE=''
API_ROOT="${DEFAULT_API_ROOT}"
DO_PULL=0
KEEP=0
ORDER_SPECS=()

WORKDIR=''
FAILURES=0
CHECKS_RUN=0

# ---------------------------------------------------------------------------- output helpers

if [[ -t 1 ]]; then
	C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_BLU=$'\033[36m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else
	C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_B=''; C_0=''
fi

section() { printf '\n%s=== %s ===%s\n' "${C_B}" "$1" "${C_0}"; }
pass()    { printf '  %s[PASS]%s %s\n' "${C_GRN}" "${C_0}" "$1"; }
fail()    { printf '  %s[FAIL]%s %s\n' "${C_RED}" "${C_0}" "$1"; FAILURES=$((FAILURES + 1)); }
info()    { printf '  %s[INFO]%s %s\n' "${C_BLU}" "${C_0}" "$1"; }
warn()    { printf '  %s[WARN]%s %s\n' "${C_YEL}" "${C_0}" "$1"; }
detail()  { printf '         %s\n' "$1"; }
die()     { printf '%serror:%s %s\n' "${C_RED}" "${C_0}" "$1" >&2; exit 2; }

# Prints the whole header block, however long it grows: everything from line 3 up to the first line
# that is not a comment. A hardcoded line range silently truncates the moment the header is edited.
usage() { awk 'NR<3{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; exit 0; }

cleanup() {
	if [[ -n "${WORKDIR}" && -d "${WORKDIR}" ]]; then
		if (( KEEP )); then
			printf '\nExtracted trees kept at: %s\n' "${WORKDIR}"
		else
			rm -rf "${WORKDIR}"
		fi
	fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------- args

while (( $# )); do
	case "$1" in
		--old)      OLD_IMAGE="${2:-}"; shift 2 ;;
		--new)      NEW_IMAGE="${2:-}"; shift 2 ;;
		--markers)  MARKERS_FILE="${2:-}"; shift 2 ;;
		--order)    ORDER_SPECS+=("${2:-}"); shift 2 ;;
		--api-root) API_ROOT="${2:-}"; shift 2 ;;
		--pull)     DO_PULL=1; shift ;;
		--keep)     KEEP=1; shift ;;
		-h|--help)  usage ;;
		-*)         die "unknown option: $1 (try --help)" ;;
		*)
			if   [[ -z "${OLD_IMAGE}" ]]; then OLD_IMAGE="$1"
			elif [[ -z "${NEW_IMAGE}" ]]; then NEW_IMAGE="$1"
			else die "unexpected argument: $1"
			fi
			shift ;;
	esac
done

[[ -n "${OLD_IMAGE}" && -n "${NEW_IMAGE}" ]] || die "both --old and --new are required (try --help)"
(( ${#ORDER_SPECS[@]} )) || ORDER_SPECS=("${DEFAULT_ORDER_SPECS[@]}")

MARKERS=()
if [[ -n "${MARKERS_FILE}" ]]; then
	[[ -r "${MARKERS_FILE}" ]] || die "markers file not readable: ${MARKERS_FILE}"
	while IFS= read -r line; do
		[[ -z "${line}" || "${line}" == \#* ]] && continue
		MARKERS+=("${line}")
	done < "${MARKERS_FILE}"
else
	MARKERS=("${DEFAULT_MARKERS[@]}")
fi

command -v docker >/dev/null 2>&1 || die "docker not found on PATH"

# ---------------------------------------------------------------------------- extraction

# Prints the image's identity (image ID + any repo digests) so the report is unambiguous about
# exactly what was compared — tags like :latest move, IDs do not.
describe_image() {
	local image="$1"
	local id digests
	id=$(docker image inspect "${image}" --format '{{.Id}}' 2>/dev/null) || return 1
	digests=$(docker image inspect "${image}" --format '{{range .RepoDigests}}{{.}} {{end}}' 2>/dev/null)
	printf '%s\n' "${id}"
	[[ -n "${digests// /}" ]] && printf '%s\n' "${digests}"
	return 0
}

ensure_image() {
	local image="$1"
	if docker image inspect "${image}" >/dev/null 2>&1; then
		return 0
	fi
	if (( DO_PULL )); then
		printf 'pulling %s ...\n' "${image}" >&2
		docker pull "${image}" >/dev/null 2>&1 || die "failed to pull ${image}"
		return 0
	fi
	die "image not present locally: ${image}
       pull it first:  docker pull ${image}
       or re-run with --pull"
}

# Copies API_ROOT out of the image WITHOUT starting it: docker create makes a container filesystem
# available to docker cp, and the container is removed immediately afterwards. `true` replaces the
# image CMD purely so create has something valid to record; it is never executed.
extract_api_tree() {
	local image="$1" dest="$2" cid=''
	cid=$(docker create "${image}" true 2>/dev/null) || return 1
	mkdir -p "${dest}"
	if ! docker cp "${cid}:${API_ROOT}" "${dest}/" >/dev/null 2>&1; then
		docker rm -f "${cid}" >/dev/null 2>&1
		return 1
	fi
	docker rm -f "${cid}" >/dev/null 2>&1
	return 0
}

# Controller identity is the file's basename without .ts — that is what maps to a set of routes, and
# it survives a file being moved between directories, so a refactor does not read as a regression.
list_controller_names() {
	find "$1" -type f -name '*Controller.ts' -printf '%f\n' 2>/dev/null | sed 's/\.ts$//' | sort -u
}

# Registration call-sites: `SomeController(app);` / `registerSomeControllers(routes);`. Function
# DEFINITIONS are not matched, since those read `(app: HonoApp)` — the type annotation means they
# never look like a bare call.
list_registered_controllers() {
	grep -rhoE '\b(register[A-Za-z0-9_]+Controllers|[A-Za-z0-9_]+Controller)\((app|routes)\);' "$1" 2>/dev/null \
		| sed -E 's/\((app|routes)\);$//' | sort -u
}

# Route inventory: single-quoted '/...' literals inside controller files. Deliberately scoped to
# *Controller.ts so unrelated path-shaped strings in services and repositories do not pollute it.
list_route_literals() {
	grep -rhoE "'/[A-Za-z0-9_:/.@-]+'" "$1" --include='*Controller.ts' 2>/dev/null | sort -u
}

# ---------------------------------------------------------------------------- run

printf '%spreflight-image-check%s — fluxer-api\n' "${C_B}" "${C_0}"

ensure_image "${OLD_IMAGE}"
ensure_image "${NEW_IMAGE}"

WORKDIR=$(mktemp -d -t preflight-image-check.XXXXXX) || die "could not create temp dir"

section 'IMAGES UNDER COMPARISON'
printf '  OLD  %s\n' "${OLD_IMAGE}"
while IFS= read -r l; do detail "${l}"; done < <(describe_image "${OLD_IMAGE}")
printf '  NEW  %s\n' "${NEW_IMAGE}"
while IFS= read -r l; do detail "${l}"; done < <(describe_image "${NEW_IMAGE}")
printf '  api root inside image: %s\n' "${API_ROOT}"

extract_api_tree "${OLD_IMAGE}" "${WORKDIR}/old" \
	|| die "could not extract ${API_ROOT} from OLD image ${OLD_IMAGE} (wrong --api-root?)"
extract_api_tree "${NEW_IMAGE}" "${WORKDIR}/new" \
	|| die "could not extract ${API_ROOT} from NEW image ${NEW_IMAGE} (wrong --api-root?)"

OLD_API="${WORKDIR}/old/$(basename "${API_ROOT}")"
NEW_API="${WORKDIR}/new/$(basename "${API_ROOT}")"
[[ -d "${OLD_API}" ]] || die "extracted OLD tree not found at ${OLD_API}"
[[ -d "${NEW_API}" ]] || die "extracted NEW tree not found at ${NEW_API}"

# ---- CHECK 1: registration order in NEW -----------------------------------------------------

section 'CHECK 1 — registration order (NEW)'
for spec in "${ORDER_SPECS[@]}"; do
	CHECKS_RUN=$((CHECKS_RUN + 1))
	IFS=':' read -r first second relpath <<< "${spec}"
	if [[ -z "${first}" || -z "${second}" || -z "${relpath}" ]]; then
		fail "malformed --order spec: ${spec} (expected BEFORE:AFTER:FILE)"
		continue
	fi

	target="${NEW_API}/${relpath}"
	if [[ ! -f "${target}" ]]; then
		fail "${relpath} not found in NEW image — cannot verify ${first} before ${second}"
		detail "this file is where the ordering is enforced; its absence is itself a regression"
		continue
	fi

	first_line=$(grep -nE "^[[:space:]]*${first}\((app|routes)\);" "${target}" | head -1 | cut -d: -f1)
	second_line=$(grep -nE "^[[:space:]]*${second}\((app|routes)\);" "${target}" | head -1 | cut -d: -f1)

	if [[ -z "${first_line}" ]]; then
		fail "${first} is NOT registered in ${relpath} of the NEW image"
		detail "the historical incident: its routes will 404 because nothing registers them"
		continue
	fi
	if [[ -z "${second_line}" ]]; then
		warn "${second} not registered in ${relpath} — ordering is moot, but this is unexpected"
		continue
	fi
	if (( first_line < second_line )); then
		pass "${first} (line ${first_line}) registers before ${second} (line ${second_line}) in ${relpath}"
	else
		fail "${first} (line ${first_line}) registers AFTER ${second} (line ${second_line}) in ${relpath}"
		detail "${second}'s parameterised route will shadow ${first}'s literal route"
	fi
done

# ---- CHECK 2: controller files present in OLD but missing from NEW ---------------------------

section 'CHECK 2 — controller coverage (OLD vs NEW)'
CHECKS_RUN=$((CHECKS_RUN + 1))
list_controller_names "${OLD_API}" > "${WORKDIR}/old-controllers.txt"
list_controller_names "${NEW_API}" > "${WORKDIR}/new-controllers.txt"
old_count=$(wc -l < "${WORKDIR}/old-controllers.txt")
new_count=$(wc -l < "${WORKDIR}/new-controllers.txt")
info "controller names — OLD: ${old_count}, NEW: ${new_count} (deduped by basename)"

comm -23 "${WORKDIR}/old-controllers.txt" "${WORKDIR}/new-controllers.txt" > "${WORKDIR}/dropped.txt"
comm -13 "${WORKDIR}/old-controllers.txt" "${WORKDIR}/new-controllers.txt" > "${WORKDIR}/added.txt"

if [[ -s "${WORKDIR}/dropped.txt" ]]; then
	fail "$(wc -l < "${WORKDIR}/dropped.txt") controller(s) present in OLD are MISSING from NEW:"
	while IFS= read -r c; do detail "- ${c}"; done < "${WORKDIR}/dropped.txt"
	detail "a candidate must never lose surface area — this is the stale-branch signature"
else
	pass "no controller present in OLD is missing from NEW"
fi

if [[ -s "${WORKDIR}/added.txt" ]]; then
	info "$(wc -l < "${WORKDIR}/added.txt") controller(s) new in NEW (informational, not a failure):"
	while IFS= read -r c; do detail "+ ${c}"; done < "${WORKDIR}/added.txt"
fi

# ---- CHECK 3: registration call-sites present in OLD but missing from NEW --------------------

section 'CHECK 3 — registration coverage (OLD vs NEW)'
CHECKS_RUN=$((CHECKS_RUN + 1))
list_registered_controllers "${OLD_API}" > "${WORKDIR}/old-registered.txt"
list_registered_controllers "${NEW_API}" > "${WORKDIR}/new-registered.txt"
info "registration call-sites — OLD: $(wc -l < "${WORKDIR}/old-registered.txt"), NEW: $(wc -l < "${WORKDIR}/new-registered.txt")"

comm -23 "${WORKDIR}/old-registered.txt" "${WORKDIR}/new-registered.txt" > "${WORKDIR}/dropped-reg.txt"
comm -13 "${WORKDIR}/old-registered.txt" "${WORKDIR}/new-registered.txt" > "${WORKDIR}/added-reg.txt"

if [[ -s "${WORKDIR}/dropped-reg.txt" ]]; then
	fail "$(wc -l < "${WORKDIR}/dropped-reg.txt") controller(s) registered in OLD are NO LONGER registered in NEW:"
	while IFS= read -r c; do detail "- ${c}"; done < "${WORKDIR}/dropped-reg.txt"
	detail "the file may still exist, but nothing wires its routes up"
else
	pass "every controller registered in OLD is still registered in NEW"
fi

if [[ -s "${WORKDIR}/added-reg.txt" ]]; then
	info "$(wc -l < "${WORKDIR}/added-reg.txt") newly registered in NEW (informational):"
	while IFS= read -r c; do detail "+ ${c}"; done < "${WORKDIR}/added-reg.txt"
fi

# A controller file that exists but is never registered is dead surface area — worth flagging, but
# not a deploy blocker, since it may be registered indirectly or intentionally staged.
comm -23 "${WORKDIR}/new-controllers.txt" "${WORKDIR}/new-registered.txt" > "${WORKDIR}/unregistered.txt"
if [[ -s "${WORKDIR}/unregistered.txt" ]]; then
	warn "$(wc -l < "${WORKDIR}/unregistered.txt") controller file(s) in NEW with no direct registration call-site:"
	while IFS= read -r c; do detail "? ${c}"; done < "${WORKDIR}/unregistered.txt"
	detail "expected for controllers registered via an aggregator or a non-standard call shape"
fi

# ---- CHECK 4: route literals present in OLD but missing from NEW -----------------------------

section 'CHECK 4 — route coverage (OLD vs NEW)'
CHECKS_RUN=$((CHECKS_RUN + 1))
list_route_literals "${OLD_API}" > "${WORKDIR}/old-routes.txt"
list_route_literals "${NEW_API}" > "${WORKDIR}/new-routes.txt"
old_routes=$(wc -l < "${WORKDIR}/old-routes.txt")
new_routes=$(wc -l < "${WORKDIR}/new-routes.txt")
info "route literals in controllers — OLD: ${old_routes}, NEW: ${new_routes}"

comm -23 "${WORKDIR}/old-routes.txt" "${WORKDIR}/new-routes.txt" > "${WORKDIR}/lost-routes.txt"
comm -13 "${WORKDIR}/old-routes.txt" "${WORKDIR}/new-routes.txt" > "${WORKDIR}/new-routes-only.txt"

if [[ -s "${WORKDIR}/lost-routes.txt" ]]; then
	fail "$(wc -l < "${WORKDIR}/lost-routes.txt") route(s) served by OLD are ABSENT from NEW:"
	while IFS= read -r r; do detail "- ${r}"; done < "${WORKDIR}/lost-routes.txt"
	detail "these will 404 after deploy — the exact shape of the original incident"
else
	pass "no route served by OLD is missing from NEW"
fi

if [[ -s "${WORKDIR}/new-routes-only.txt" ]]; then
	info "$(wc -l < "${WORKDIR}/new-routes-only.txt") route(s) new in NEW (informational):"
	while IFS= read -r r; do detail "+ ${r}"; done < "${WORKDIR}/new-routes-only.txt"
fi

# ---- CHECK 5: known-critical route markers in NEW --------------------------------------------

section 'CHECK 5 — known-critical markers (NEW)'
missing_markers=0
for marker in "${MARKERS[@]}"; do
	CHECKS_RUN=$((CHECKS_RUN + 1))
	if hits=$(grep -rlF -- "${marker}" "${NEW_API}" 2>/dev/null) && [[ -n "${hits}" ]]; then
		pass "${marker}"
		hit_count=$(printf '%s\n' "${hits}" | wc -l)
		shown=$(printf '%s\n' "${hits}" | sed "s#^${NEW_API}/##" | head -3 | paste -sd, - | sed 's/,/, /g')
		if (( hit_count > 3 )); then
			detail "in ${shown} (+$((hit_count - 3)) more)"
		else
			detail "in ${shown}"
		fi
	else
		fail "marker MISSING from NEW image: ${marker}"
		missing_markers=$((missing_markers + 1))
	fi
done
(( missing_markers == 0 )) && info "all ${#MARKERS[@]} markers present"
info "markers are a whole-tree string grep — a comment can satisfy one; checks 2-4 are the real gate"

# ---- summary ---------------------------------------------------------------------------------

section 'SUMMARY'
printf '  OLD : %s\n' "${OLD_IMAGE}"
printf '  NEW : %s\n' "${NEW_IMAGE}"
printf '  controllers : %s -> %s  (dropped %s, added %s)\n' \
	"${old_count}" "${new_count}" \
	"$(wc -l < "${WORKDIR}/dropped.txt")" "$(wc -l < "${WORKDIR}/added.txt")"
printf '  routes      : %s -> %s  (lost %s, new %s)\n' \
	"${old_routes}" "${new_routes}" \
	"$(wc -l < "${WORKDIR}/lost-routes.txt")" "$(wc -l < "${WORKDIR}/new-routes-only.txt")"
printf '  assertions  : %s\n' "${CHECKS_RUN}"

if (( FAILURES )); then
	printf '\n%s%s  PREFLIGHT FAILED — %s check(s) failed. DO NOT DEPLOY.  %s\n\n' \
		"${C_B}" "${C_RED}" "${FAILURES}" "${C_0}"
	exit 1
fi

printf '\n%s%s  PREFLIGHT PASSED — candidate loses no surface area.  %s\n' "${C_B}" "${C_GRN}" "${C_0}"
printf '  NOTE: fluxer-api only. fluxer-messages (Rust) is NOT covered — see header.\n\n'
exit 0
