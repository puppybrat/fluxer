// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	buildCastOverviewTree,
	type CastOverviewChannelInfo,
	type CastOverviewGroup,
} from '@app/features/cast/utils/CastOverviewTree';
import {describe, expect, it} from 'vitest';

const character = (id: string, name: string | null) => ({
	id,
	name,
	alias: null,
	ship: null,
	owner: 1,
	nickname: null,
	pfp_url: null,
	reference_image_url: null,
});

const primary = (character_id: string, channel_id: string | null, is_primary = false) => ({
	character_id,
	channel_id,
	is_primary,
});

const override = (
	character_id: string,
	channel_id: string | null,
	fields: {nickname?: string | null; excluded?: boolean; pfp_url?: string | null} = {},
) => ({
	character_id,
	channel_id,
	nickname: fields.nickname ?? null,
	pfp_url: fields.pfp_url ?? null,
	reference_image_url: null,
	excluded: fields.excluded ?? false,
});

const cat = (id: string, name: string, position = 0): CastOverviewChannelInfo => ({
	id,
	name,
	parentId: null,
	isCategory: true,
	position,
});
const chan = (id: string, name: string, parentId: string | null, position = 0): CastOverviewChannelInfo => ({
	id,
	name,
	parentId,
	isCategory: false,
	position,
});

function channels(...infos: Array<CastOverviewChannelInfo>): ReadonlyMap<string, CastOverviewChannelInfo> {
	return new Map(infos.map((info) => [info.id, info]));
}

/** Compact shape for assertions: name, whether it is a structural-only header, and its entries. */
const shape = (g: CastOverviewGroup) => ({
	kind: g.kind,
	name: g.name,
	structural: g.structuralOnly,
	entries: g.entries.map((e) => `${e.name}:${e.status}`),
	children: g.children.map((c) => ({name: c.name, entries: c.entries.map((e) => `${e.name}:${e.status}`)})),
});

describe('Cast Overview tree', () => {
	it('always puts the server group first, even when it is empty', () => {
		const tree = buildCastOverviewTree({
			characters: [character('c1', 'Rowan')],
			primaries: [primary('c1', 'ch1')],
			overrides: [],
			channelsById: channels(chan('ch1', 'testing', null)),
		});
		expect(tree[0]!.kind).toBe('server');
		expect(tree[0]!.entries).toEqual([]);
		expect(tree).toHaveLength(2);
	});

	/**
	 * Mirrors the dev stack's real cast guild: server-scope rows plus one channel scope (#testing),
	 * whose parent category (Text Channels) has NO local delta of its own.
	 */
	it('nests an overridden channel under a category that has no delta of its own', () => {
		const tree = buildCastOverviewTree({
			characters: [character('c1', 'Rowan'), character('c2', 'Sable')],
			primaries: [primary('c1', null), primary('c2', null), primary('c2', 'testing-id')],
			overrides: [override('c1', null, {nickname: 'Ro'}), override('c2', 'testing-id', {nickname: 'Sab'})],
			channelsById: channels(cat('text-cat', 'Text Channels'), chan('testing-id', 'testing', 'text-cat')),
		});

		expect(tree.map(shape)).toEqual([
			{kind: 'server', name: '', structural: false, entries: ['Rowan:edited', 'Sable:added'], children: []},
			{
				kind: 'category',
				name: 'Text Channels',
				structural: true, // listed only to host #testing
				entries: [],
				children: [{name: '#testing', entries: ['Sable:edited']}],
			},
		]);
	});

	/**
	 * Matches ChannelOrganization.organizeChannels, which the real sidebar renders: parentless
	 * channels are emitted as the root bucket BEFORE any category, so they sit above the categories
	 * regardless of position, and position only orders within each partition.
	 */
	it('puts parentless channels above the categories, like the sidebar does', () => {
		const tree = buildCastOverviewTree({
			characters: [character('c1', 'Rowan')],
			primaries: [primary('c1', 'zebra-cat'), primary('c1', 'alpha-cat'), primary('c1', 'loose')],
			overrides: [],
			channelsById: channels(
				cat('zebra-cat', 'Zebra', 0),
				cat('alpha-cat', 'Alpha', 1),
				// position 3 is AFTER both categories, but a parentless channel still renders above them.
				chan('loose', 'middle', null, 3),
			),
		});
		expect(tree.map((g) => g.name)).toEqual(['', '#middle', 'Zebra', 'Alpha']);
		expect(tree[1]!.kind).toBe('channel');
		expect(tree[1]!.children).toEqual([]);
	});

	it('orders categories by position, not alphabetically', () => {
		const tree = buildCastOverviewTree({
			characters: [character('c1', 'Rowan')],
			primaries: [primary('c1', 'a'), primary('c1', 'z')],
			overrides: [],
			// Alphabetical would give Alpha, Zebra; position says otherwise.
			channelsById: channels(cat('a', 'Alpha', 5), cat('z', 'Zebra', 1)),
		});
		expect(tree.map((g) => g.name)).toEqual(['', 'Zebra', 'Alpha']);
	});

	it('orders parentless channels among themselves by position', () => {
		const tree = buildCastOverviewTree({
			characters: [character('c1', 'Rowan')],
			primaries: [primary('c1', 'a'), primary('c1', 'z')],
			overrides: [],
			channelsById: channels(chan('a', 'aaa', null, 9), chan('z', 'zzz', null, 2)),
		});
		expect(tree.map((g) => g.name)).toEqual(['', '#zzz', '#aaa']);
	});

	it('orders channels within a category by position, not alphabetically', () => {
		const tree = buildCastOverviewTree({
			characters: [character('c1', 'Rowan')],
			primaries: [primary('c1', 'zed'), primary('c1', 'abe')],
			overrides: [],
			channelsById: channels(cat('c', 'Cat'), chan('zed', 'zed', 'c', 0), chan('abe', 'abe', 'c', 1)),
		});
		expect(tree[1]!.children.map((c) => c.name)).toEqual(['#zed', '#abe']);
	});

	it('falls back to the id as a stable tiebreak when positions are equal', () => {
		const tree = buildCastOverviewTree({
			characters: [character('c1', 'Rowan')],
			primaries: [primary('c1', 'b'), primary('c1', 'a')],
			overrides: [],
			channelsById: channels(cat('b', 'Bee', 0), cat('a', 'Ay', 0)),
		});
		expect(tree.map((g) => g.name)).toEqual(['', 'Ay', 'Bee']);
	});

	it('keeps a category that has BOTH its own delta and overridden children', () => {
		const tree = buildCastOverviewTree({
			characters: [character('c1', 'Rowan'), character('c2', 'Sable')],
			primaries: [primary('c1', 'cat1'), primary('c2', 'chan1')],
			overrides: [],
			channelsById: channels(cat('cat1', 'Both'), chan('chan1', 'kid', 'cat1')),
		});
		const group = tree[1]!;
		expect(group.structuralOnly).toBe(false);
		expect(group.entries.map((e) => e.name)).toEqual(['Rowan']);
		expect(group.children.map((c) => c.name)).toEqual(['#kid']);
	});

	it('ranks excluded over edited over added for the same character', () => {
		const tree = buildCastOverviewTree({
			characters: [character('x', 'Xavier')],
			// exclude() writes BOTH a membership row and an excluded override — must read as excluded.
			primaries: [primary('x', 'ch')],
			overrides: [override('x', 'ch', {excluded: true, nickname: 'Xav'})],
			channelsById: channels(chan('ch', 'c', null)),
		});
		expect(tree[1]!.entries).toMatchObject([{characterId: 'x', name: 'Xavier', status: 'excluded'}]);
	});

	/**
	 * Excluding only flips the `excluded` flag; the display fields it was carrying are left alone and
	 * come back untouched when it is un-excluded. The row therefore has to keep reporting them, or the
	 * UI would imply the nickname was lost.
	 */
	it('keeps an excluded row display fields, since excluding does not clear them', () => {
		const tree = buildCastOverviewTree({
			characters: [character('x', 'Xavier')],
			primaries: [primary('x', 'ch')],
			overrides: [override('x', 'ch', {excluded: true, nickname: 'Xav'})],
			channelsById: channels(chan('ch', 'c', null)),
		});
		const entry = tree[1]!.entries[0]!;
		expect(entry.nickname).toBe('Xav');
		expect(entry.localOverride).toEqual({nickname: 'Xav', pfpUrl: null, referenceImageUrl: null});
	});

	it('omits a scope whose rows produce no local delta', () => {
		const tree = buildCastOverviewTree({
			characters: [character('c1', 'Rowan')],
			// An override row carrying no display fields and no exclusion changes nothing locally.
			primaries: [],
			overrides: [override('c1', 'ch')],
			channelsById: channels(chan('ch', 'quiet', null)),
		});
		expect(tree).toHaveLength(1);
		expect(tree[0]!.kind).toBe('server');
	});

	it('falls back to the raw id for a scope whose channel is unknown, at the top level', () => {
		const tree = buildCastOverviewTree({
			characters: [character('c1', 'Rowan')],
			primaries: [primary('c1', '999')],
			overrides: [],
			channelsById: channels(),
		});
		expect(tree[1]!.name).toBe('999');
		expect(tree[1]!.kind).toBe('channel');
	});

	it('treats an unknown parent as no parent rather than hiding the group', () => {
		const tree = buildCastOverviewTree({
			characters: [character('c1', 'Rowan')],
			primaries: [primary('c1', 'orphan')],
			overrides: [],
			channelsById: channels(chan('orphan', 'lost', 'missing-cat')),
		});
		expect(tree.map((g) => g.name)).toEqual(['', '#lost']);
	});

	it('falls back to the character id when the roster carries no name', () => {
		const tree = buildCastOverviewTree({
			characters: [character('c1', null)],
			primaries: [primary('c1', null)],
			overrides: [],
			channelsById: channels(),
		});
		expect(tree[0]!.entries[0]!.name).toBe('c1');
	});

	/** The row's Primary checkbox reads this; it is per-scope, not a property of the character. */
	describe('per-row fields the editing row renders from', () => {
		it('reports the primary flag from the membership row at this exact scope', () => {
			const tree = buildCastOverviewTree({
				characters: [character('c1', 'Rowan')],
				// Primary server-wide, but NOT primary in the channel that also lists it.
				primaries: [primary('c1', null, true), primary('c1', 'ch', false)],
				overrides: [],
				channelsById: channels(chan('ch', 'general', null)),
			});
			expect(tree[0]!.entries[0]!.isPrimary).toBe(true);
			expect(tree[1]!.entries[0]!.isPrimary).toBe(false);
		});

		it('prefers this scope avatar over the roster one', () => {
			const withRosterPfp = {...character('c1', 'Rowan'), pfp_url: 'https://example.test/roster.png'};
			const tree = buildCastOverviewTree({
				characters: [withRosterPfp],
				primaries: [primary('c1', 'ch')],
				overrides: [override('c1', 'ch', {pfp_url: 'https://example.test/scoped.png'})],
				channelsById: channels(chan('ch', 'general', null)),
			});
			expect(tree[1]!.entries[0]!.pfpUrl).toBe('https://example.test/scoped.png');
		});

		it('falls back to the roster avatar when this scope overrides no avatar', () => {
			const withRosterPfp = {...character('c1', 'Rowan'), pfp_url: 'https://example.test/roster.png'};
			const tree = buildCastOverviewTree({
				characters: [withRosterPfp],
				primaries: [primary('c1', 'ch')],
				overrides: [override('c1', 'ch', {nickname: 'Ro'})],
				channelsById: channels(chan('ch', 'general', null)),
			});
			expect(tree[1]!.entries[0]!.pfpUrl).toBe('https://example.test/roster.png');
		});

		/**
		 * The edit modal pre-fills from this and nothing else. A plain local add has no override row,
		 * so it must open BLANK — pre-filling from the roster would promote an inherited value into a
		 * real local override the moment the user pressed Save without changing anything.
		 */
		it('exposes no local override for a plain local add', () => {
			const withRosterNickname = {...character('c1', 'Rowan'), nickname: 'Inherited'};
			const tree = buildCastOverviewTree({
				characters: [withRosterNickname],
				primaries: [primary('c1', 'ch')],
				overrides: [],
				channelsById: channels(chan('ch', 'general', null)),
			});
			const entry = tree[1]!.entries[0]!;
			expect(entry.status).toBe('added');
			expect(entry.localOverride).toBeNull();
			expect(entry.nickname).toBeNull();
		});

		it('carries the character so the row can reach its real, nullable name', () => {
			const tree = buildCastOverviewTree({
				characters: [character('c1', null)],
				primaries: [primary('c1', null)],
				overrides: [],
				channelsById: channels(),
			});
			const entry = tree[0]!.entries[0]!;
			// `name` falls back to the id for display; `character.name` stays null so the profile link
			// can decline to build a slug out of an id.
			expect(entry.name).toBe('c1');
			expect(entry.character.name).toBeNull();
		});
	});
});
