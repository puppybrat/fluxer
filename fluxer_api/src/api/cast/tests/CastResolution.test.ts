// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it} from 'vitest';
import {
	type EffectiveCharacter,
	resolveEffectiveCast,
	type ScopedOverrideRow,
	type ScopedPrimaryRow,
} from '../CastResolution';

const CHANNEL = '9000000000000000001';
const CATEGORY = '9000000000000000002';

function primary(character_id: string, channel_id: string | null, is_primary: boolean): ScopedPrimaryRow {
	return {character_id, channel_id, is_primary};
}

function override(
	character_id: string,
	channel_id: string | null,
	fields: Partial<Omit<ScopedOverrideRow, 'character_id' | 'channel_id'>> = {},
): ScopedOverrideRow {
	return {
		character_id,
		channel_id,
		nickname: fields.nickname ?? null,
		pfp_url: fields.pfp_url ?? null,
		reference_image_url: fields.reference_image_url ?? null,
		excluded: fields.excluded ?? false,
	};
}

function byId(result: Array<EffectiveCharacter>): Map<string, EffectiveCharacter> {
	return new Map(result.map((row) => [row.character_id, row]));
}

describe('resolveEffectiveCast', () => {
	it('includes a character present only at server scope', () => {
		const result = resolveEffectiveCast({
			primaries: [primary('A', null, true)],
			overrides: [],
			channelId: CHANNEL,
			categoryId: CATEGORY,
		});
		expect(result).toEqual([
			{character_id: 'A', is_primary: true, nickname: null, pfp_url: null, reference_image_url: null},
		]);
	});

	it('includes a character added at category scope that is absent at server scope', () => {
		const result = resolveEffectiveCast({
			primaries: [primary('B', CATEGORY, false)],
			overrides: [],
			channelId: CHANNEL,
			categoryId: CATEGORY,
		});
		expect(byId(result).get('B')).toMatchObject({character_id: 'B', is_primary: false});

		// The same rows resolved for a channel in a DIFFERENT category (no category hop to this cat)
		// must not surface B — its only row is at a scope that does not apply.
		const otherChannel = resolveEffectiveCast({
			primaries: [primary('B', CATEGORY, false)],
			overrides: [],
			channelId: CHANNEL,
			categoryId: '9000000000000000099',
		});
		expect(otherChannel).toEqual([]);
	});

	it('excludes a character excluded at category scope even though server would show it', () => {
		const result = resolveEffectiveCast({
			primaries: [primary('C', null, true)],
			overrides: [override('C', CATEGORY, {excluded: true})],
			channelId: CHANNEL,
			categoryId: CATEGORY,
		});
		expect(result).toEqual([]);
	});

	it('lets a channel-scope explicit add override a category-scope exclusion (Eliodoro scenario)', () => {
		const result = resolveEffectiveCast({
			primaries: [primary('E', null, true), primary('E', CHANNEL, false)],
			overrides: [override('E', CATEGORY, {excluded: true})],
			channelId: CHANNEL,
			categoryId: CATEGORY,
		});
		// Channel scope is most specific: its primaries row makes E present before the category
		// exclusion is ever consulted, and is_primary comes from the channel row.
		expect(result).toEqual([
			{character_id: 'E', is_primary: false, nickname: null, pfp_url: null, reference_image_url: null},
		]);
	});

	it('resolves per-field overrides independently (category nickname + channel pfp both apply)', () => {
		const result = resolveEffectiveCast({
			primaries: [primary('F', null, true)],
			overrides: [
				override('F', CATEGORY, {nickname: 'CatNick'}),
				override('F', CHANNEL, {pfp_url: 'https://media/chan.png'}),
			],
			channelId: CHANNEL,
			categoryId: CATEGORY,
		});
		expect(result).toEqual([
			{
				character_id: 'F',
				is_primary: true,
				nickname: 'CatNick', // only the category set it
				pfp_url: 'https://media/chan.png', // only the channel set it
				reference_image_url: null,
			},
		]);
	});

	it('takes primary status from the channel scope without any category-scope row', () => {
		const result = resolveEffectiveCast({
			primaries: [primary('G', null, false), primary('G', CHANNEL, true)],
			overrides: [],
			channelId: CHANNEL,
			categoryId: CATEGORY,
		});
		expect(result).toEqual([
			{character_id: 'G', is_primary: true, nickname: null, pfp_url: null, reference_image_url: null},
		]);
	});

	it('resolves a top-level channel (no category) server -> channel, skipping the category hop', () => {
		const result = resolveEffectiveCast({
			primaries: [primary('H', null, true), primary('H', CHANNEL, false)],
			// A category-scoped row must be irrelevant when the channel has no category.
			overrides: [override('H', CATEGORY, {excluded: true})],
			channelId: CHANNEL,
			categoryId: null,
		});
		// The category exclusion does not apply (no category hop); channel scope decides: present,
		// is_primary=false.
		expect(result).toEqual([
			{character_id: 'H', is_primary: false, nickname: null, pfp_url: null, reference_image_url: null},
		]);

		// A character whose only row is at category scope is not a candidate for a top-level channel.
		const onlyCategory = resolveEffectiveCast({
			primaries: [primary('I', CATEGORY, true)],
			overrides: [],
			channelId: CHANNEL,
			categoryId: null,
		});
		expect(onlyCategory).toEqual([]);
	});
});
