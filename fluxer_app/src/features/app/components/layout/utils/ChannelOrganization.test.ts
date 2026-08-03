// SPDX-License-Identifier: AGPL-3.0-or-later

import {type ChannelGroup, organizeChannels} from '@app/features/app/components/layout/utils/ChannelOrganization';
import type {Channel} from '@app/features/channel/models/Channel';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {describe, expect, it} from 'vitest';

function channel(id: string, type: number, position: number, parentId: string | null = null): Channel {
	return {
		id,
		type,
		position,
		parentId,
	} as Channel;
}

/** Every channel id the tree renders, in the order a depth-first walk of the output visits them. */
function collectChannelIds(groups: ReadonlyArray<ChannelGroup>): Array<string> {
	const ids: Array<string> = [];
	const walk = (group: ChannelGroup) => {
		for (const ch of group.textChannels) ids.push(ch.id);
		for (const ch of group.voiceChannels) ids.push(ch.id);
		for (const child of group.children) walk(child);
	};
	for (const group of groups) walk(group);
	return ids;
}

/** Every category id the tree renders, same walk. */
function collectCategoryIds(groups: ReadonlyArray<ChannelGroup>): Array<string> {
	const ids: Array<string> = [];
	const walk = (group: ChannelGroup) => {
		if (group.category) ids.push(group.category.id);
		for (const child of group.children) walk(child);
	};
	for (const group of groups) walk(group);
	return ids;
}

function findCategory(groups: ReadonlyArray<ChannelGroup>, categoryId: string): ChannelGroup | null {
	for (const group of groups) {
		if (group.category?.id === categoryId) return group;
		const nested = findCategory(group.children, categoryId);
		if (nested) return nested;
	}
	return null;
}

describe('organizeChannels', () => {
	it('keeps parentless channels in the root group, above every category', () => {
		const groups = organizeChannels([
			channel('cat', ChannelTypes.GUILD_CATEGORY, 10),
			channel('root-text', ChannelTypes.GUILD_TEXT, 20),
			channel('root-voice', ChannelTypes.GUILD_VOICE, 30),
			channel('in-cat', ChannelTypes.GUILD_TEXT, 40, 'cat'),
		]);
		const [rootGroup] = groups;
		expect(rootGroup.category).toBeUndefined();
		expect(rootGroup.textChannels.map((ch) => ch.id)).toEqual(['root-text']);
		expect(rootGroup.voiceChannels.map((ch) => ch.id)).toEqual(['root-voice']);
		expect(groups.slice(1).map((group) => group.category?.id)).toEqual(['cat']);
	});

	it('nests a category under its parent category', () => {
		const groups = organizeChannels([
			channel('parent', ChannelTypes.GUILD_CATEGORY, 10),
			channel('child', ChannelTypes.GUILD_CATEGORY, 20, 'parent'),
			channel('child-text', ChannelTypes.GUILD_TEXT, 30, 'child'),
		]);
		const parent = findCategory(groups, 'parent');
		expect(parent?.children.map((group) => group.category?.id)).toEqual(['child']);
		expect(parent?.children[0]?.textChannels.map((ch) => ch.id)).toEqual(['child-text']);
		// The nested category must NOT also appear as a root-level sibling.
		expect(groups.map((group) => group.category?.id)).toEqual([undefined, 'parent']);
	});

	it('nests to arbitrary depth', () => {
		const groups = organizeChannels([
			channel('l1', ChannelTypes.GUILD_CATEGORY, 10),
			channel('l2', ChannelTypes.GUILD_CATEGORY, 20, 'l1'),
			channel('l3', ChannelTypes.GUILD_CATEGORY, 30, 'l2'),
			channel('l4', ChannelTypes.GUILD_CATEGORY, 40, 'l3'),
			channel('deep-text', ChannelTypes.GUILD_TEXT, 50, 'l4'),
		]);
		const l4 = findCategory(groups, 'l4');
		expect(l4?.textChannels.map((ch) => ch.id)).toEqual(['deep-text']);
		expect(findCategory(groups, 'l3')?.children.map((g) => g.category?.id)).toEqual(['l4']);
		expect(findCategory(groups, 'l2')?.children.map((g) => g.category?.id)).toEqual(['l3']);
		expect(collectCategoryIds(groups)).toEqual(['l1', 'l2', 'l3', 'l4']);
	});

	it('emits every channel and category exactly once', () => {
		const groups = organizeChannels([
			channel('root-text', ChannelTypes.GUILD_TEXT, 10),
			channel('a', ChannelTypes.GUILD_CATEGORY, 20),
			channel('a-text', ChannelTypes.GUILD_TEXT, 30, 'a'),
			channel('a-voice', ChannelTypes.GUILD_VOICE, 40, 'a'),
			channel('a-b', ChannelTypes.GUILD_CATEGORY, 50, 'a'),
			channel('a-b-text', ChannelTypes.GUILD_TEXT, 60, 'a-b'),
			channel('c', ChannelTypes.GUILD_CATEGORY, 70),
			channel('c-text', ChannelTypes.GUILD_TEXT, 80, 'c'),
		]);
		const channelIds = collectChannelIds(groups);
		expect(channelIds.slice().sort()).toEqual(['a-b-text', 'a-text', 'a-voice', 'c-text', 'root-text']);
		expect(new Set(channelIds).size).toBe(channelIds.length);
		const categoryIds = collectCategoryIds(groups);
		expect(categoryIds.slice().sort()).toEqual(['a', 'a-b', 'c']);
		expect(new Set(categoryIds).size).toBe(categoryIds.length);
	});

	it('falls back to root for a parentId matching no known category', () => {
		const groups = organizeChannels([
			channel('orphan-text', ChannelTypes.GUILD_TEXT, 10, 'does-not-exist'),
			channel('orphan-cat', ChannelTypes.GUILD_CATEGORY, 20, 'also-missing'),
			channel('orphan-cat-text', ChannelTypes.GUILD_TEXT, 30, 'orphan-cat'),
		]);
		expect(groups[0]?.textChannels.map((ch) => ch.id)).toEqual(['orphan-text']);
		expect(findCategory(groups, 'orphan-cat')).not.toBeNull();
		expect(groups.map((group) => group.category?.id)).toEqual([undefined, 'orphan-cat']);
		// The orphaned category keeps its own children.
		expect(findCategory(groups, 'orphan-cat')?.textChannels.map((ch) => ch.id)).toEqual(['orphan-cat-text']);
		expect(collectChannelIds(groups).slice().sort()).toEqual(['orphan-cat-text', 'orphan-text']);
	});

	it('treats a non-category parent as no parent', () => {
		const groups = organizeChannels([
			channel('text-parent', ChannelTypes.GUILD_TEXT, 10),
			channel('bad-child', ChannelTypes.GUILD_TEXT, 20, 'text-parent'),
		]);
		expect(groups[0]?.textChannels.map((ch) => ch.id).sort()).toEqual(['bad-child', 'text-parent']);
		expect(collectChannelIds(groups)).toHaveLength(2);
	});

	it('pins a parent cycle to root instead of losing it', () => {
		const groups = organizeChannels([
			channel('x', ChannelTypes.GUILD_CATEGORY, 10, 'y'),
			channel('y', ChannelTypes.GUILD_CATEGORY, 20, 'x'),
			channel('x-text', ChannelTypes.GUILD_TEXT, 30, 'x'),
		]);
		expect(collectCategoryIds(groups).slice().sort()).toEqual(['x', 'y']);
		// Both cycle members are reachable at root rather than nested inside each other.
		expect(groups.slice(1).map((group) => group.category?.id).sort()).toEqual(['x', 'y']);
		expect(collectChannelIds(groups)).toEqual(['x-text']);
	});

	it('pins a self-parented category to root', () => {
		const groups = organizeChannels([channel('self', ChannelTypes.GUILD_CATEGORY, 10, 'self')]);
		expect(groups.slice(1).map((group) => group.category?.id)).toEqual(['self']);
	});

	it('orders siblings by position at every depth', () => {
		const groups = organizeChannels([
			channel('parent', ChannelTypes.GUILD_CATEGORY, 10),
			channel('child-late', ChannelTypes.GUILD_CATEGORY, 90, 'parent'),
			channel('child-early', ChannelTypes.GUILD_CATEGORY, 20, 'parent'),
			channel('text-late', ChannelTypes.GUILD_TEXT, 80, 'parent'),
			channel('text-early', ChannelTypes.GUILD_TEXT, 15, 'parent'),
		]);
		const parent = findCategory(groups, 'parent');
		expect(parent?.children.map((group) => group.category?.id)).toEqual(['child-early', 'child-late']);
		expect(parent?.textChannels.map((ch) => ch.id)).toEqual(['text-early', 'text-late']);
	});

	it('treats GUILD_LINK as a text channel', () => {
		const groups = organizeChannels([
			channel('cat', ChannelTypes.GUILD_CATEGORY, 10),
			channel('link', ChannelTypes.GUILD_LINK, 20, 'cat'),
		]);
		expect(findCategory(groups, 'cat')?.textChannels.map((ch) => ch.id)).toEqual(['link']);
	});
});
