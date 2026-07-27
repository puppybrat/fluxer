// SPDX-License-Identifier: AGPL-3.0-or-later

import {buildCastOverviewTree, type CastOverviewChannelInfo} from '@app/features/cast/utils/CastOverviewTree';
import {describe, expect, it} from 'vitest';

/**
 * Reconciliation against the dev stack's REAL data, captured 2026-07-27.
 *
 * Channels come from the `channels` rows of guild 1517785346346057728 ("Emojis") in the dev
 * postgres KV store; the cast rows come from that guild's payload on the personal-site cast API.
 * They are pinned here rather than fetched so the suite stays offline and deterministic — the point
 * is that the tree was exercised against a real multi-scope guild, including its awkward parts,
 * rather than against fixtures shaped to agree with the implementation.
 *
 * The awkward parts, both genuine:
 * - 4 primaries point at channel 1524705144518737920, which no longer exists in the channels table.
 * - The guild mixes categories, nested text channels, a nested VOICE channel and a parentless
 *   channel, so the sidebar ordering rules all apply at once.
 */
const GUILD_CHANNELS: Array<CastOverviewChannelInfo> = [
	{id: '1517785346346057729', name: 'Text Channels', parentId: null, isCategory: true, position: 0},
	{id: '1517785346346057730', name: 'Voice Channels', parentId: null, isCategory: true, position: 1},
	{id: '1517785346346057731', name: 'general', parentId: '1517785346346057729', isCategory: false, position: 0},
	{id: '1517785346346057732', name: 'testing', parentId: '1517785346346057729', isCategory: false, position: 1},
	{id: '1517785346346057733', name: 'trash', parentId: '1517785346346057729', isCategory: false, position: 2},
	{id: '1517785346346057734', name: 'General', parentId: '1517785346346057730', isCategory: false, position: 0},
	{id: '1517785346346057735', name: 'parent-test', parentId: null, isCategory: false, position: 3},
];

/** The real split: 9 rows at the server scope, 4 at the now-deleted channel. */
const DELETED_SCOPE = '1524705144518737920';
const SERVER_CHARACTER_IDS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const DELETED_SCOPE_CHARACTER_IDS = ['1', '2', '3', '4'];

const characters = SERVER_CHARACTER_IDS.map((id) => ({
	id,
	name: `Character ${id}`,
	alias: null,
	ship: null,
	owner: 1,
	nickname: null,
	pfp_url: null,
	reference_image_url: null,
}));

const primaries = [
	...SERVER_CHARACTER_IDS.map((character_id) => ({character_id, channel_id: null, is_primary: false})),
	...DELETED_SCOPE_CHARACTER_IDS.map((character_id) => ({
		character_id,
		channel_id: DELETED_SCOPE,
		is_primary: false,
	})),
];

describe('Cast Overview tree against the real dev-stack guild', () => {
	const tree = buildCastOverviewTree({
		characters,
		primaries,
		// The real payload carries no override rows for this guild.
		overrides: [],
		channelsById: new Map(GUILD_CHANNELS.map((info) => [info.id, info])),
	});

	/** The bug this fixes: before, only the server group had rows so only it appeared. */
	it('produces a group for every channel and category, not just the ones with data', () => {
		const labels = tree.flatMap((group) => [group.name, ...group.children.map((child) => child.name)]);
		expect(labels).toEqual([
			'', // server-wide
			// The orphan has no channel record and so no position, which sorts as 0 — ahead of
			// #parent-test at position 3. Both are parentless, so both precede the categories.
			DELETED_SCOPE, // orphaned rows, named by raw id
			'#parent-test',
			'Text Channels',
			'#general',
			'#testing',
			'#trash',
			'Voice Channels',
			'#General',
		]);
	});

	it('covers all 7 real channels plus the server scope and the orphan', () => {
		const groupCount = tree.length + tree.reduce((total, group) => total + group.children.length, 0);
		expect(groupCount).toBe(GUILD_CHANNELS.length + 2);
	});

	it('puts the real cast rows on the scopes that actually own them', () => {
		expect(tree[0]!.kind).toBe('server');
		expect(tree[0]!.entries).toHaveLength(SERVER_CHARACTER_IDS.length);
		const orphan = tree.find((group) => group.scopeId === DELETED_SCOPE)!;
		expect(orphan.entries).toHaveLength(DELETED_SCOPE_CHARACTER_IDS.length);
	});

	it('leaves every live channel empty, since this guild has no per-channel rows', () => {
		const live = tree
			.flatMap((group) => [group, ...group.children])
			.filter((group) => group.scopeId != null && group.scopeId !== DELETED_SCOPE);
		expect(live).toHaveLength(GUILD_CHANNELS.length);
		expect(live.every((group) => group.entries.length === 0)).toBe(true);
	});

	/**
	 * The scroll-length question. The largest guild on the dev stack has 12 channels, so the worst
	 * case is well short of anything needing a collapse mechanism — "fully visible" stays viable.
	 */
	it('stays a modest number of sections for a real guild', () => {
		const groupCount = tree.length + tree.reduce((total, group) => total + group.children.length, 0);
		expect(groupCount).toBeLessThanOrEqual(16);
	});
});
