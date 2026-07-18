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
export type CastMutationResponseType = z.infer<typeof CastMutationResponse>;
