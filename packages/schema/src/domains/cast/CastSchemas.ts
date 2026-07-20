// SPDX-License-Identifier: AGPL-3.0-or-later

import {z} from 'zod';

/**
 * Cast data is sourced from an external personal-site endpoint whose table carries many
 * columns Fluxer has no business exposing (visibility_states, designer, acquired,
 * base_value, ...). These schemas define the trimmed projection Fluxer serves: adding a
 * field here is a deliberate act, not an accident of upstream schema drift.
 */
export const CastCharacterResponse = z.object({
	id: z.string().describe('The external identifier for this character'),
	name: z.string().nullable().describe('The display name of this character'),
	alias: z.string().nullable().describe('An alternate name for this character'),
	ship: z.string().nullable().describe('The ship this character belongs to'),
	/**
	 * Which person owns this character on the personal site. Every row carries 1 or 2 today,
	 * but this is a plain nullable number rather than a 1 | 2 literal union on purpose: a
	 * third owner appearing upstream would make a strict union fail validation and take down
	 * the whole cast read, which is a poor trade for a field nothing branches on yet.
	 */
	owner: z.number().nullable().describe('The personal-site owner this character belongs to'),
	/**
	 * Null rather than empty string when unset. The personal site clears an override by
	 * writing null, and an empty string reaching a client would be indistinguishable from a
	 * deliberate blank nickname — so the projection normalises '' to null on the way out.
	 */
	nickname: z
		.string()
		.nullable()
		.describe('The per-guild nickname for this character, or null when no override is set'),
	pfp_url: z
		.string()
		.nullable()
		.describe('The per-guild avatar URL for this character, or null when no override is set'),
});

export const CastPrimaryResponse = z.object({
	character_id: z.string().describe('The character this primary assignment refers to'),
	channel_id: z.string().nullable().describe('The channel this character is primary in, if channel-scoped'),
	is_primary: z.boolean().describe('Whether this character is primary for the scope'),
});

export const CastCategoryResponse = z.object({
	pair_slug: z.string().nullable().describe('The pair this category belongs to'),
	au_slug: z.string().nullable().describe('The alternate universe this category belongs to'),
	category_id: z.string().describe('The channel category this mapping applies to'),
});

export const CastResponse = z.object({
	characters: z.array(CastCharacterResponse).describe('Characters available for this guild'),
	primaries: z.array(CastPrimaryResponse).describe('Primary character assignments for this guild'),
	categories: z.array(CastCategoryResponse).describe('Category to pair/AU mappings for this guild'),
});

/**
 * The full character roster, not scoped to any guild — what a picker needs to offer
 * characters that are not in the cast yet. Reuses CastCharacterResponse so the trimmed
 * projection stays defined in exactly one place.
 */
export const CastAllCharactersResponse = z.object({
	characters: z.array(CastCharacterResponse).describe('Every character available on the personal site'),
});

/**
 * Per-guild display overrides for a cast character. `nickname` is capped at 100 to match
 * the personal site's column width — a longer value is rejected here rather than silently
 * truncated on write.
 */
export const CastOverrideResponse = z.object({
	character_id: z.string().describe('The character this override applies to'),
	nickname: z.string().nullable().describe('The nickname shown for this character in this guild'),
	pfp_url: z.string().nullable().describe('The avatar URL shown for this character in this guild'),
});

export const CastOverrideUpdateRequest = z.object({
	nickname: z.string().max(100).nullish().describe('The nickname to show, or null to clear it'),
	pfp_url: z.string().url().max(2048).nullish().describe('The avatar URL to show, or null to clear it'),
});

/**
 * Maps each personal-site owner index onto the Fluxer account that owns it — the lookup an
 * IC/OOC resolver needs to answer "whose character is this". Its own shape rather than a
 * reuse of the character schemas: it describes people, not characters.
 *
 * `fluxer_user_id` is a string because it is a snowflake; serialising it as a number would
 * lose precision past 2^53.
 */
export const CastOwnerAccountResponse = z.object({
	fluxer_user_id: z.string().describe('The Fluxer user this owner index corresponds to'),
	owner_index: z.number().describe('The owner index used by the personal site characters table'),
});

export const CastOwnerAccountsResponse = z.object({
	owner_accounts: z.array(CastOwnerAccountResponse).describe('Every configured owner index to Fluxer account mapping'),
});

export const CastSetPrimaryRequest = z.object({
	is_primary: z.boolean().describe('Whether this character is a primary for the guild'),
});

/**
 * Shared confirmation shape for every write action. `override` is populated only by the
 * update action; add, remove and set-primary report the character they acted on and nothing
 * more, since the personal site owns the row and Fluxer has no business echoing it back.
 */
export const CastMutationResponse = z.object({
	success: z.boolean().describe('Whether the personal site applied the change'),
	character_id: z.string().describe('The character the action applied to'),
	override: CastOverrideResponse.nullable().describe('The resulting override, for update actions only'),
});

export type CastCharacterResponseType = z.infer<typeof CastCharacterResponse>;
export type CastPrimaryResponseType = z.infer<typeof CastPrimaryResponse>;
export type CastCategoryResponseType = z.infer<typeof CastCategoryResponse>;
export type CastResponseType = z.infer<typeof CastResponse>;
export type CastOverrideResponseType = z.infer<typeof CastOverrideResponse>;
export type CastOverrideUpdateRequestType = z.infer<typeof CastOverrideUpdateRequest>;
export type CastSetPrimaryRequestType = z.infer<typeof CastSetPrimaryRequest>;
export type CastAllCharactersResponseType = z.infer<typeof CastAllCharactersResponse>;
export type CastOwnerAccountResponseType = z.infer<typeof CastOwnerAccountResponse>;
export type CastOwnerAccountsResponseType = z.infer<typeof CastOwnerAccountsResponse>;
export type CastMutationResponseType = z.infer<typeof CastMutationResponse>;
