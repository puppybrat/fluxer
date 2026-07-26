// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure resolver that merges per-scope cast rows (server / category / channel) into the effective
 * cast for one channel. Deliberately free of any database, framework, or model dependency — every
 * input is a plain value — so it can be unit-tested in complete isolation.
 *
 * Scoping model (confirmed): a category is literally a channel, nesting is exactly one level deep.
 * A row's channel_id identifies its scope: null is server-wide, a value equal to the target
 * channel's parent category id is the category scope, a value equal to the channel id is the
 * channel scope. Scopes are considered most-specific first: channel -> category -> server.
 */

/** A raw-but-normalised character_primaries row. `is_primary` is already a boolean. */
export interface ScopedPrimaryRow {
	character_id: string;
	channel_id: string | null;
	is_primary: boolean;
}

/** A raw-but-normalised character_cast_overrides row. `excluded` is already a boolean. */
export interface ScopedOverrideRow {
	character_id: string;
	channel_id: string | null;
	nickname: string | null;
	pfp_url: string | null;
	reference_image_url: string | null;
	excluded: boolean;
}

export interface EffectiveCharacter {
	character_id: string;
	is_primary: boolean;
	nickname: string | null;
	pfp_url: string | null;
	reference_image_url: string | null;
}

// Composite map key. '|' cannot appear in a snowflake id, and the empty string stands in for the
// null (server-wide) scope, which is likewise never a real channel id.
function scopeKey(characterId: string, scope: string | null): string {
	return `${characterId}|${scope ?? ''}`;
}

function firstNonNull(values: ReadonlyArray<string | null | undefined>): string | null {
	for (const value of values) {
		if (value != null) {
			return value;
		}
	}
	return null;
}

/**
 * Resolves the effective cast for a channel:
 *
 * PRESENCE — for each candidate, walk channel -> category -> server, most specific first. At each
 * scope: an override with excluded=true means NOT present (stop); a primaries row means present
 * (stop) with is_primary taken from THAT row; neither defers to the next broader scope. Reaching
 * the server scope with neither means not present.
 *
 * PER-FIELD OVERRIDES — nickname, pfp_url and reference_image_url each independently take the value
 * from the most specific scope that has a non-null value for THAT field, falling through per field
 * rather than per row.
 *
 * CANDIDATES — the union of every character_id with any primaries OR override row (excluded or not)
 * at the server, category, or channel scope.
 */
export function resolveEffectiveCast(params: {
	primaries: ReadonlyArray<ScopedPrimaryRow>;
	overrides: ReadonlyArray<ScopedOverrideRow>;
	channelId: string | null;
	categoryId: string | null;
}): Array<EffectiveCharacter> {
	// Most-specific-first: channel, then its category, then server (null), which always terminates
	// the walk. Non-null scopes are only added when present and distinct (a top-level channel has no
	// category, so the category hop is skipped entirely).
	const scopes: Array<string | null> = [];
	const seenScopes = new Set<string>();
	if (params.channelId != null) {
		seenScopes.add(params.channelId);
		scopes.push(params.channelId);
	}
	if (params.categoryId != null && !seenScopes.has(params.categoryId)) {
		seenScopes.add(params.categoryId);
		scopes.push(params.categoryId);
	}
	scopes.push(null);
	const relevantScopes = new Set(scopes);

	const primaryByKey = new Map<string, ScopedPrimaryRow>();
	const overrideByKey = new Map<string, ScopedOverrideRow>();
	const candidates = new Set<string>();

	for (const row of params.primaries) {
		if (!relevantScopes.has(row.channel_id)) {
			continue;
		}
		primaryByKey.set(scopeKey(row.character_id, row.channel_id), row);
		candidates.add(row.character_id);
	}
	for (const row of params.overrides) {
		if (!relevantScopes.has(row.channel_id)) {
			continue;
		}
		overrideByKey.set(scopeKey(row.character_id, row.channel_id), row);
		candidates.add(row.character_id);
	}

	const result: Array<EffectiveCharacter> = [];
	for (const characterId of candidates) {
		let present = false;
		let isPrimary = false;
		for (const scope of scopes) {
			const override = overrideByKey.get(scopeKey(characterId, scope));
			if (override?.excluded) {
				present = false;
				break;
			}
			const primary = primaryByKey.get(scopeKey(characterId, scope));
			if (primary) {
				present = true;
				isPrimary = primary.is_primary;
				break;
			}
		}
		if (!present) {
			continue;
		}
		result.push({
			character_id: characterId,
			is_primary: isPrimary,
			nickname: firstNonNull(scopes.map((scope) => overrideByKey.get(scopeKey(characterId, scope))?.nickname)),
			pfp_url: firstNonNull(scopes.map((scope) => overrideByKey.get(scopeKey(characterId, scope))?.pfp_url)),
			reference_image_url: firstNonNull(
				scopes.map((scope) => overrideByKey.get(scopeKey(characterId, scope))?.reference_image_url),
			),
		});
	}

	// Stable order so callers and tests do not depend on Set iteration order.
	result.sort((a, b) => (a.character_id < b.character_id ? -1 : a.character_id > b.character_id ? 1 : 0));
	return result;
}
