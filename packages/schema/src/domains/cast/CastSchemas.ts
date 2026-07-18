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

export type CastCharacterResponseType = z.infer<typeof CastCharacterResponse>;
export type CastPrimaryResponseType = z.infer<typeof CastPrimaryResponse>;
export type CastCategoryResponseType = z.infer<typeof CastCategoryResponse>;
export type CastResponseType = z.infer<typeof CastResponse>;
