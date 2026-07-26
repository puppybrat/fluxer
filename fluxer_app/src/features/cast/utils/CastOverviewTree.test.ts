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

const primary = (character_id: string, channel_id: string | null) => ({
	character_id,
	channel_id,
	is_primary: false,
});

const override = (
	character_id: string,
	channel_id: string | null,
	fields: {nickname?: string | null; excluded?: boolean} = {},
) => ({
	character_id,
	channel_id,
	nickname: fields.nickname ?? null,
	pfp_url: null,
	reference_image_url: null,
	excluded: fields.excluded ?? false,
});

const cat = (id: string, name: string): CastOverviewChannelInfo => ({id, name, parentId: null, isCategory: true});
const chan = (id: string, name: string, parentId: string | null): CastOverviewChannelInfo => ({
	id,
	name,
	parentId,
	isCategory: false,
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

	it('sorts categories and parentless channels together, alphabetically, after the server group', () => {
		const tree = buildCastOverviewTree({
			characters: [character('c1', 'Rowan')],
			primaries: [primary('c1', 'zebra-cat'), primary('c1', 'alpha-cat'), primary('c1', 'loose')],
			overrides: [],
			channelsById: channels(
				cat('zebra-cat', 'Zebra'),
				cat('alpha-cat', 'Alpha'),
				chan('loose', 'middle', null), // no parent category -> flat, alongside the categories
			),
		});
		expect(tree.map((g) => g.name)).toEqual(['', 'Alpha', '#middle', 'Zebra']);
		expect(tree[2]!.kind).toBe('channel');
		expect(tree[2]!.children).toEqual([]);
	});

	it('sorts channels alphabetically within their category', () => {
		const tree = buildCastOverviewTree({
			characters: [character('c1', 'Rowan')],
			primaries: [primary('c1', 'zed'), primary('c1', 'abe')],
			overrides: [],
			channelsById: channels(cat('c', 'Cat'), chan('zed', 'zed', 'c'), chan('abe', 'abe', 'c')),
		});
		expect(tree[1]!.children.map((c) => c.name)).toEqual(['#abe', '#zed']);
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
			overrides: [override('x', 'ch', {excluded: true, nickname: 'ignored'})],
			channelsById: channels(chan('ch', 'c', null)),
		});
		expect(tree[1]!.entries).toEqual([{characterId: 'x', name: 'Xavier', status: 'excluded', nickname: null}]);
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
});
