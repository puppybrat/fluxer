// SPDX-License-Identifier: AGPL-3.0-or-later

import type {DragItem, DropResult} from '@app/features/app/components/layout/types/DndTypes';
import type {Channel} from '@app/features/channel/models/Channel';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {
	collectDescendantIds,
	computePositionFromPrecedingSiblingId,
	sortChannelsForOrdering,
} from '@fluxer/schema/src/domains/channel/GuildChannelOrdering';

const isTextChannel = (channel: Channel) =>
	channel.type === ChannelTypes.GUILD_TEXT || channel.type === ChannelTypes.GUILD_LINK;
const isCategoryChannel = (channel: Channel) => channel.type === ChannelTypes.GUILD_CATEGORY;
/**
 * A dragged category moves as one block: itself plus everything under it, at ANY depth.
 *
 * These three used to match on `parentId === categoryId`, which was exact while categories could not
 * nest. Now a grandchild fails that test, so a depth-1 block would leave the subtree's deeper half
 * behind at the old location while its category travelled — hence `collectDescendantIds`, the same
 * traversal the server validates moves with.
 */
const gatherCategoryBlock = (channels: ReadonlyArray<Channel>, categoryId: string) => {
	const descendants = collectDescendantIds({channels, ancestorId: categoryId});
	return channels.filter((ch) => ch.id === categoryId || descendants.has(ch.id));
};
const filterOutCategoryBlock = (channels: ReadonlyArray<Channel>, categoryId: string) => {
	const descendants = collectDescendantIds({channels, ancestorId: categoryId});
	return channels.filter((ch) => ch.id !== categoryId && !descendants.has(ch.id));
};
/** Where a category's block ends. `channels` must be sorted, which lays each subtree out contiguously. */
const findCategorySpan = (channels: ReadonlyArray<Channel>, categoryId: string) => {
	const startIndex = channels.findIndex((ch) => ch.id === categoryId);
	if (startIndex === -1) return {start: -1, end: -1};
	const descendants = collectDescendantIds({channels, ancestorId: categoryId});
	let endIndex = startIndex + 1;
	while (endIndex < channels.length && descendants.has(channels[endIndex].id)) {
		endIndex++;
	}
	return {start: startIndex, end: endIndex};
};
const findCurrentPreceding = (channels: ReadonlyArray<Channel>, channel: Channel): string | null => {
	const index = channels.findIndex((ch) => ch.id === channel.id);
	if (index <= 0) return null;
	for (let i = index - 1; i >= 0; i--) {
		const candidate = channels[i];
		const candidateParent = candidate.parentId ?? null;
		const channelParent = channel.parentId ?? null;
		if (candidateParent === channelParent) {
			return candidate.id;
		}
	}
	return null;
};

export interface ChannelMoveOperation {
	channelId: string;
	newParentId: string | null;
	precedingSiblingId: string | null;
	position: number;
}

export const createChannelMoveOperation = ({
	channels,
	dragItem,
	dropResult,
}: {
	channels: ReadonlyArray<Channel>;
	dragItem: DragItem;
	dropResult: DropResult;
}): ChannelMoveOperation | null => {
	const draggedChannel = channels.find((ch) => ch.id === dragItem.id);
	if (!draggedChannel) return null;
	const orderedChannels = sortChannelsForOrdering(channels);
	const isCategory = isCategoryChannel(draggedChannel);
	const baseList = isCategory
		? filterOutCategoryBlock(orderedChannels, draggedChannel.id)
		: orderedChannels.filter((ch) => ch.id !== draggedChannel.id);
	const block = isCategory ? gatherCategoryBlock(orderedChannels, draggedChannel.id) : [draggedChannel];
	if (block.length === 0) return null;
	const targetId = dropResult.targetId;
	// The drop's own parent, for categories too. This used to be pinned to null for a dragged category
	// on the grounds that categories only ever lived at root; now that they nest, honouring the drop is
	// what lets 'inside' nest one and 'before'/'after' keep it beside the target at that same depth.
	let newParentId: string | null =
		targetId === 'null-space'
			? null
			: dropResult.targetParentId !== undefined
				? dropResult.targetParentId
				: (draggedChannel.parentId ?? null);
	let insertIndex = 0;
	if (targetId === 'null-space') {
		insertIndex = 0;
		newParentId = null;
	} else if (targetId === 'trailing-space') {
		insertIndex = baseList.length;
		newParentId = null;
	} else {
		const targetIndex = baseList.findIndex((ch) => ch.id === targetId);
		if (targetIndex === -1) return null;
		const targetChannel = baseList[targetIndex];
		if (dropResult.position === 'before') {
			insertIndex = targetIndex;
		} else if (dropResult.position === 'after') {
			if (isCategoryChannel(targetChannel)) {
				const span = findCategorySpan(baseList, targetChannel.id);
				insertIndex = span.end;
			} else {
				insertIndex = targetIndex + 1;
			}
		} else if (dropResult.position === 'inside') {
			if (!isCategoryChannel(targetChannel)) {
				return null;
			}
			const span = findCategorySpan(baseList, targetChannel.id);
			insertIndex = span.end;
			newParentId = targetChannel.id;
		}
	}
	if (newParentId) {
		const siblingIndices = baseList.reduce<
			Array<{
				index: number;
				channel: Channel;
			}>
		>((acc, ch, index) => {
			if (ch.parentId === newParentId) {
				acc.push({index, channel: ch});
			}
			return acc;
		}, []);
		if (draggedChannel.type === ChannelTypes.GUILD_VOICE) {
			const lastTextSibling = siblingIndices
				.filter(({channel}) => isTextChannel(channel))
				.reduce<number>((max, {index}) => Math.max(max, index), -1);
			const categoryIndex = baseList.findIndex((ch) => ch.id === newParentId);
			const minimumIndex = lastTextSibling >= 0 ? lastTextSibling + 1 : categoryIndex + 1;
			if (minimumIndex > insertIndex) {
				insertIndex = minimumIndex;
			}
		} else if (isTextChannel(draggedChannel)) {
			const firstVoiceSibling = siblingIndices
				.filter(({channel}) => channel.type === ChannelTypes.GUILD_VOICE)
				.reduce<number>((min, {index}) => Math.min(min, index), Infinity);
			if (firstVoiceSibling !== Infinity && insertIndex > firstVoiceSibling) {
				insertIndex = firstVoiceSibling;
			}
		}
	}
	const finalList = [...baseList];
	finalList.splice(insertIndex, 0, ...block);
	const insertedIndex = finalList.findIndex((ch) => ch.id === draggedChannel.id);
	if (insertedIndex === -1) return null;
	let precedingSiblingId: string | null = null;
	for (let i = insertedIndex - 1; i >= 0; i--) {
		const candidate = finalList[i];
		const candidateParent = candidate.parentId ?? null;
		// One rule for everything now. A dragged category used to look for the nearest root-level row,
		// which was the same thing as "my sibling" only while categories could not nest.
		if (candidateParent === (newParentId ?? null)) {
			precedingSiblingId = candidate.id;
			break;
		}
	}
	const currentPreceding = findCurrentPreceding(orderedChannels, draggedChannel);
	const currentParentId = draggedChannel.parentId ?? null;
	if (currentParentId === (newParentId ?? null) && currentPreceding === precedingSiblingId) {
		return null;
	}
	const position = computePositionFromPrecedingSiblingId({
		channels: orderedChannels,
		targetId: draggedChannel.id,
		desiredParentId: newParentId ?? null,
		precedingSiblingId,
	});
	if (position === null) {
		return null;
	}
	return {
		channelId: draggedChannel.id,
		newParentId: newParentId ?? null,
		precedingSiblingId,
		position,
	};
};
