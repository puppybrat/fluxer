// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';

export interface ChannelOrderingChannel<Id extends string | bigint = string> {
	id: Id;
	parentId?: Id | null | undefined;
	type: number;
	position?: number | null | undefined;
}

export type GuildChannelReorderErrorCode =
	| 'TARGET_CHANNEL_NOT_FOUND'
	| 'PRECEDING_CHANNEL_NOT_FOUND'
	| 'CANNOT_POSITION_RELATIVE_TO_SELF_BLOCK'
	| 'PRECEDING_PARENT_MISMATCH'
	| 'PARENT_NOT_FOUND'
	| 'PARENT_NOT_CATEGORY'
	| 'PARENT_SELF_REFERENCE'
	| 'PARENT_CYCLE'
	| 'PARENT_NOT_IN_GUILD_LIST'
	| 'PRECEDING_NOT_IN_GUILD_LIST';

interface GuildChannelReorderOperation<Id extends string | bigint> {
	channelId: Id;
	parentId: Id | null | undefined;
	precedingSiblingId: Id | null | undefined;
}

interface GuildChannelReorderPlan<Id extends string | bigint, Channel extends ChannelOrderingChannel<Id>> {
	orderedChannels: Array<Channel>;
	finalChannels: Array<Channel>;
	desiredParentById: Map<Id, Id | null>;
	orderUnchanged: boolean;
}

function idToString<Id extends string | bigint>(id: Id): string {
	return String(id);
}

export function compareChannelOrdering<Id extends string | bigint>(
	a: ChannelOrderingChannel<Id>,
	b: ChannelOrderingChannel<Id>,
): number {
	const aPos = a.position ?? 0;
	const bPos = b.position ?? 0;
	if (aPos !== bPos) return aPos - bPos;
	return idToString(a.id).localeCompare(idToString(b.id));
}

export function sortChannelsForOrdering<Id extends string | bigint, Channel extends ChannelOrderingChannel<Id>>(
	channels: ReadonlyArray<Channel>,
): Array<Channel> {
	const channelById = new Map<Id, Channel>(channels.map((channel) => [channel.id, channel]));
	const childrenByParent = new Map<Id, Array<Channel>>();
	const rootChannels: Array<Channel> = [];
	for (const channel of channels) {
		const parentId = channel.parentId ?? null;
		if (parentId === null || !channelById.has(parentId)) {
			rootChannels.push(channel);
			continue;
		}
		const existingChildren = childrenByParent.get(parentId);
		if (existingChildren) {
			existingChildren.push(channel);
		} else {
			childrenByParent.set(parentId, [channel]);
		}
	}
	const orderedChannels: Array<Channel> = [];
	const seen = new Set<Id>();
	// Depth-first: a channel is immediately followed by its entire subtree, at any depth. `seen` doubles as
	// cycle protection so a corrupt parent chain in storage degrades to the `remaining` fallback below rather
	// than looping forever.
	const visit = (channel: Channel): void => {
		if (seen.has(channel.id)) {
			return;
		}
		orderedChannels.push(channel);
		seen.add(channel.id);
		if (channel.type !== ChannelTypes.GUILD_CATEGORY) {
			return;
		}
		const children = childrenByParent.get(channel.id);
		if (!children) {
			return;
		}
		for (const child of [...children].sort(compareChannelOrdering)) {
			visit(child);
		}
	};
	for (const root of [...rootChannels].sort(compareChannelOrdering)) {
		visit(root);
	}
	const remaining = channels.filter((channel) => !seen.has(channel.id)).sort(compareChannelOrdering);
	orderedChannels.push(...remaining);
	return orderedChannels;
}

export function computeChannelMoveBlockIds<Id extends string | bigint, Channel extends ChannelOrderingChannel<Id>>({
	channels,
	targetId,
}: {
	channels: ReadonlyArray<Channel>;
	targetId: Id;
}): Set<Id> {
	const channelById = new Map<Id, Channel>(channels.map((ch) => [ch.id, ch]));
	const target = channelById.get(targetId);
	const blockIds = new Set<Id>();
	blockIds.add(targetId);
	if (target?.type === ChannelTypes.GUILD_CATEGORY) {
		for (const descendantId of collectDescendantIds({channels, ancestorId: targetId})) {
			blockIds.add(descendantId);
		}
	}
	return blockIds;
}

/**
 * Every channel beneath `ancestorId` at any depth. Iterative, and guarded by the visited set so a pre-existing
 * cycle in the data terminates instead of hanging.
 */
export function collectDescendantIds<Id extends string | bigint, Channel extends ChannelOrderingChannel<Id>>({
	channels,
	ancestorId,
}: {
	channels: ReadonlyArray<Channel>;
	ancestorId: Id;
}): Set<Id> {
	const childrenByParent = new Map<Id, Array<Channel>>();
	for (const channel of channels) {
		const parentId = channel.parentId ?? null;
		if (parentId === null) continue;
		const existing = childrenByParent.get(parentId);
		if (existing) {
			existing.push(channel);
		} else {
			childrenByParent.set(parentId, [channel]);
		}
	}
	const descendants = new Set<Id>();
	const queue: Array<Id> = [ancestorId];
	while (queue.length > 0) {
		const currentId = queue.pop()!;
		for (const child of childrenByParent.get(currentId) ?? []) {
			if (descendants.has(child.id) || child.id === ancestorId) continue;
			descendants.add(child.id);
			queue.push(child.id);
		}
	}
	return descendants;
}

/**
 * Whether re-parenting `channelId` under `desiredParentId` would create a loop — i.e. the requested parent is
 * the channel itself, or sits somewhere in its own subtree. `channels` must describe the *projected* state when
 * validating a batch, so operations that are individually safe can't combine into a cycle.
 */
export function findParentCycleViolation<Id extends string | bigint, Channel extends ChannelOrderingChannel<Id>>({
	channels,
	channelId,
	desiredParentId,
}: {
	channels: ReadonlyArray<Channel>;
	channelId: Id;
	desiredParentId: Id | null | undefined;
}): 'PARENT_SELF_REFERENCE' | 'PARENT_CYCLE' | null {
	if (desiredParentId == null) {
		return null;
	}
	if (desiredParentId === channelId) {
		return 'PARENT_SELF_REFERENCE';
	}
	const descendants = collectDescendantIds({channels, ancestorId: channelId});
	return descendants.has(desiredParentId) ? 'PARENT_CYCLE' : null;
}

function findCategorySpanInOrderedList<Id extends string | bigint, Channel extends ChannelOrderingChannel<Id>>(
	orderedChannels: ReadonlyArray<Channel>,
	categoryId: Id,
): {
	start: number;
	end: number;
} {
	const start = orderedChannels.findIndex((ch) => ch.id === categoryId);
	if (start === -1) return {start: -1, end: -1};
	// sortChannelsForOrdering lays each subtree out contiguously depth-first, so the span runs until the first
	// channel that isn't a descendant at any depth.
	const descendants = collectDescendantIds({channels: orderedChannels, ancestorId: categoryId});
	let end = start + 1;
	while (end < orderedChannels.length && descendants.has(orderedChannels[end].id)) {
		end++;
	}
	return {start, end};
}

export function computePrecedingSiblingIdFromPosition<
	Id extends string | bigint,
	Channel extends ChannelOrderingChannel<Id>,
>({
	channels,
	targetId,
	desiredParentId,
	position,
}: {
	channels: ReadonlyArray<Channel>;
	targetId: Id;
	desiredParentId: Id | null;
	position: number;
}): Id | null {
	const siblings = sortChannelsForOrdering(channels).filter((ch) => (ch.parentId ?? null) === desiredParentId);
	const blockIds = computeChannelMoveBlockIds({channels, targetId});
	const siblingsWithoutBlock = siblings.filter((ch) => !blockIds.has(ch.id));
	const clamped = Math.min(Math.max(position, 0), siblingsWithoutBlock.length);
	return clamped === 0 ? null : siblingsWithoutBlock[clamped - 1]!.id;
}

export function computePositionFromPrecedingSiblingId<
	Id extends string | bigint,
	Channel extends ChannelOrderingChannel<Id>,
>({
	channels,
	targetId,
	desiredParentId,
	precedingSiblingId,
}: {
	channels: ReadonlyArray<Channel>;
	targetId: Id;
	desiredParentId: Id | null;
	precedingSiblingId: Id | null;
}): number | null {
	const siblings = sortChannelsForOrdering(channels).filter((ch) => (ch.parentId ?? null) === desiredParentId);
	const blockIds = computeChannelMoveBlockIds({channels, targetId});
	const siblingsWithoutBlock = siblings.filter((ch) => !blockIds.has(ch.id));
	if (!precedingSiblingId) return 0;
	const index = siblingsWithoutBlock.findIndex((ch) => ch.id === precedingSiblingId);
	if (index === -1) return null;
	return index + 1;
}

export function computeGuildChannelReorderPlan<Id extends string | bigint, Channel extends ChannelOrderingChannel<Id>>({
	channels,
	operation,
}: {
	channels: ReadonlyArray<Channel>;
	operation: GuildChannelReorderOperation<Id>;
}):
	| {
			ok: true;
			plan: GuildChannelReorderPlan<Id, Channel>;
	  }
	| {
			ok: false;
			code: GuildChannelReorderErrorCode;
	  } {
	const orderedChannels = sortChannelsForOrdering(channels);
	const channelById = new Map<Id, Channel>(orderedChannels.map((ch) => [ch.id, ch]));
	const targetChannel = channelById.get(operation.channelId);
	if (!targetChannel) {
		return {ok: false, code: 'TARGET_CHANNEL_NOT_FOUND'};
	}
	const requestedParentId = operation.parentId;
	const desiredParentId = requestedParentId !== undefined ? requestedParentId : (targetChannel.parentId ?? null);
	if (desiredParentId) {
		const parentChannel = channelById.get(desiredParentId);
		if (!parentChannel) {
			return {ok: false, code: 'PARENT_NOT_FOUND'};
		}
		if (parentChannel.type !== ChannelTypes.GUILD_CATEGORY) {
			return {ok: false, code: 'PARENT_NOT_CATEGORY'};
		}
		const cycleViolation = findParentCycleViolation({
			channels: orderedChannels,
			channelId: targetChannel.id,
			desiredParentId,
		});
		if (cycleViolation) {
			return {ok: false, code: cycleViolation};
		}
	}
	const precedingId = operation.precedingSiblingId ?? null;
	if (precedingId && !channelById.has(precedingId)) {
		return {ok: false, code: 'PRECEDING_CHANNEL_NOT_FOUND'};
	}
	const blockIds = computeChannelMoveBlockIds({channels: orderedChannels, targetId: targetChannel.id});
	if (precedingId && blockIds.has(precedingId)) {
		return {ok: false, code: 'CANNOT_POSITION_RELATIVE_TO_SELF_BLOCK'};
	}
	const remainingChannels = orderedChannels.filter((ch) => !blockIds.has(ch.id));
	const blockChannels = orderedChannels.filter((ch) => blockIds.has(ch.id));
	const expectedParent = desiredParentId ?? null;
	if (precedingId) {
		const precedingChannel = channelById.get(precedingId)!;
		const precedingParent = precedingChannel.parentId ?? null;
		if (precedingParent !== expectedParent) {
			return {ok: false, code: 'PRECEDING_PARENT_MISMATCH'};
		}
	}
	let insertIndex = 0;
	if (precedingId) {
		const precedingIndex = remainingChannels.findIndex((ch) => ch.id === precedingId);
		if (precedingIndex === -1) {
			return {ok: false, code: 'PRECEDING_NOT_IN_GUILD_LIST'};
		}
		const precedingChannel = channelById.get(precedingId)!;
		if (precedingChannel.type === ChannelTypes.GUILD_CATEGORY) {
			const span = findCategorySpanInOrderedList(remainingChannels, precedingChannel.id);
			insertIndex = span.end;
		} else {
			insertIndex = precedingIndex + 1;
		}
	} else if (desiredParentId) {
		const parentIndex = remainingChannels.findIndex((ch) => ch.id === desiredParentId);
		if (parentIndex === -1) {
			return {ok: false, code: 'PARENT_NOT_IN_GUILD_LIST'};
		}
		insertIndex = parentIndex + 1;
	} else {
		insertIndex = 0;
	}
	const finalChannels = [...remainingChannels];
	finalChannels.splice(insertIndex, 0, ...blockChannels);
	const desiredParentById = new Map<Id, Id | null>();
	for (const channel of finalChannels) {
		if (channel.id === targetChannel.id) {
			desiredParentById.set(channel.id, desiredParentId ?? null);
		} else {
			desiredParentById.set(channel.id, channel.parentId ?? null);
		}
	}
	const orderUnchanged =
		finalChannels.length === orderedChannels.length &&
		finalChannels.every((channel, index) => channel.id === orderedChannels[index]!.id) &&
		(targetChannel.parentId ?? null) === (desiredParentById.get(targetChannel.id) ?? null);
	return {
		ok: true,
		plan: {
			orderedChannels,
			finalChannels,
			desiredParentById,
			orderUnchanged,
		},
	};
}
