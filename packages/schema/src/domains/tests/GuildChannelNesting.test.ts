// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {describe, expect, it} from 'vitest';
import {
	collectDescendantIds,
	computeChannelMoveBlockIds,
	computeGuildChannelReorderPlan,
	findParentCycleViolation,
	sortChannelsForOrdering,
} from '../channel/GuildChannelOrdering';

interface TestChannel {
	id: string;
	parentId: string | null;
	type: number;
	position: number;
}

const cat = (id: string, parentId: string | null, position: number): TestChannel => ({
	id,
	parentId,
	type: ChannelTypes.GUILD_CATEGORY,
	position,
});
const text = (id: string, parentId: string | null, position: number): TestChannel => ({
	id,
	parentId,
	type: ChannelTypes.GUILD_TEXT,
	position,
});

// Ids are typed as plain strings so the generic Id parameter widens instead of narrowing to a literal.
const A: string = 'a';
const B: string = 'b';
const C: string = 'c';
const X: string = 'x';

// a > b > c, each category holding one text channel
const nested: Array<TestChannel> = [
	cat('a', null, 1),
	text('a-text', 'a', 2),
	cat('b', 'a', 3),
	text('b-text', 'b', 4),
	cat('c', 'b', 5),
	text('c-text', 'c', 6),
];

describe('nested categories', () => {
	it('orders a deep tree depth-first with subtrees contiguous', () => {
		const ordered = sortChannelsForOrdering(nested).map((c) => c.id);
		expect(ordered).toEqual(['a', 'a-text', 'b', 'b-text', 'c', 'c-text']);
	});

	it('collects descendants at every depth, not just direct children', () => {
		expect([...collectDescendantIds({channels: nested, ancestorId: A})].sort()).toEqual([
			'a-text',
			'b',
			'b-text',
			'c',
			'c-text',
		]);
		expect([...collectDescendantIds({channels: nested, ancestorId: C})]).toEqual(['c-text']);
	});

	it('moves a category together with its whole subtree', () => {
		expect([...computeChannelMoveBlockIds({channels: nested, targetId: B})].sort()).toEqual([
			'b',
			'b-text',
			'c',
			'c-text',
		]);
	});

	it('rejects self-parenting and descendant-parenting, allows unrelated parents', () => {
		expect(findParentCycleViolation({channels: nested, channelId: A, desiredParentId: A})).toBe(
			'PARENT_SELF_REFERENCE',
		);
		expect(findParentCycleViolation({channels: nested, channelId: A, desiredParentId: C})).toBe('PARENT_CYCLE');
		expect(findParentCycleViolation({channels: nested, channelId: C, desiredParentId: A})).toBeNull();
		expect(findParentCycleViolation({channels: nested, channelId: A, desiredParentId: null})).toBeNull();
	});

	it('terminates on pre-existing cyclic data instead of hanging', () => {
		const cyclic: Array<TestChannel> = [cat('x', 'y', 1), cat('y', 'x', 2)];
		expect(
			sortChannelsForOrdering(cyclic)
				.map((c) => c.id)
				.sort(),
		).toEqual(['x', 'y']);
		expect([...collectDescendantIds({channels: cyclic, ancestorId: X})]).toEqual(['y']);
	});

	it('permits nesting a category under a category via the reorder plan', () => {
		const flat: Array<TestChannel> = [cat('a', null, 1), cat('b', null, 2)];
		const result = computeGuildChannelReorderPlan({
			channels: flat,
			operation: {channelId: B, parentId: A, precedingSiblingId: null},
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.plan.desiredParentById.get('b')).toBe('a');
	});

	it('rejects a cycle through the reorder plan', () => {
		const result = computeGuildChannelReorderPlan({
			channels: nested,
			operation: {channelId: A, parentId: C, precedingSiblingId: null},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('PARENT_CYCLE');
	});

	it('still keeps a plain channel under a plain category unchanged', () => {
		const simple: Array<TestChannel> = [cat('a', null, 1), text('t', 'a', 2), text('loose', null, 3)];
		expect(sortChannelsForOrdering(simple).map((c) => c.id)).toEqual(['a', 't', 'loose']);
	});
});
