// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {sortChannelsForOrdering} from '@fluxer/schema/src/domains/channel/GuildChannelOrdering';

export const isTextChannel = (ch: Channel) =>
	ch.type === ChannelTypes.GUILD_TEXT || ch.type === ChannelTypes.GUILD_LINK;
const isVoiceChannel = (ch: Channel) => ch.type === ChannelTypes.GUILD_VOICE;
export const isCategory = (ch: Channel) => ch.type === ChannelTypes.GUILD_CATEGORY;

/**
 * One category and everything directly inside it, plus the categories nested beneath it.
 *
 * `category` is absent only for the synthetic root node, which carries the parentless channels that
 * sit above every category in the sidebar.
 */
export interface ChannelGroup {
	category?: Channel;
	textChannels: Array<Channel>;
	voiceChannels: Array<Channel>;
	/** Categories nested directly under this one, in sidebar order. Arbitrarily deep. */
	children: Array<ChannelGroup>;
}

/**
 * Builds the sidebar's channel tree: a root node holding the parentless channels, followed by the
 * root-level categories, each carrying its own channels and its own nested categories, to any depth.
 *
 * Ordering comes from `sortChannelsForOrdering` rather than a flat `compareChannelOrdering` sort, so
 * siblings at every depth order the same way the server orders them and the two cannot drift.
 *
 * No item is ever dropped. A `parentId` that resolves to nothing in this guild — a stale parent, a
 * category the client has not synced, a non-category — is treated as `null` and the item surfaces at
 * root level rather than disappearing. A cycle is broken the same way: the members stay reachable at
 * root instead of nesting into each other forever.
 */
export const organizeChannels = (channels: ReadonlyArray<Channel>): Array<ChannelGroup> => {
	const orderedChannels = sortChannelsForOrdering(channels);
	// Only a real category can be a parent, so a channel parented to a text channel resolves to
	// nothing here and falls back to root, exactly as an unknown id does.
	const categoriesById = new Map<string, Channel>();
	for (const channel of orderedChannels) {
		if (isCategory(channel)) {
			categoriesById.set(channel.id, channel);
		}
	}

	/**
	 * The parent this item actually renders under, or null for root.
	 *
	 * Walking up to the root proves the chain terminates; if it does not, the item belongs to a cycle
	 * and is pinned to root. Without this a cycle would leave a whole subtree built but unreachable
	 * from the returned roots, which is the silent-drop this function promises never to do.
	 */
	const resolveParentId = (channel: Channel): string | null => {
		const directParentId = channel.parentId;
		if (directParentId == null || !categoriesById.has(directParentId)) {
			return null;
		}
		const seen = new Set<string>([channel.id]);
		let ancestorId: string | null = directParentId;
		while (ancestorId != null) {
			if (seen.has(ancestorId)) {
				return null;
			}
			seen.add(ancestorId);
			const ancestor: Channel | undefined = categoriesById.get(ancestorId);
			if (ancestor == null) {
				break;
			}
			const nextId = ancestor.parentId;
			ancestorId = nextId != null && categoriesById.has(nextId) ? nextId : null;
		}
		return directParentId;
	};

	// The parentless channels. Root-level CATEGORIES are collected separately, in `rootCategories`,
	// because the sidebar renders them as siblings of this node rather than inside it.
	const rootGroup: ChannelGroup = {textChannels: [], voiceChannels: [], children: []};
	const rootCategories: Array<ChannelGroup> = [];
	const groupsByCategoryId = new Map<string, ChannelGroup>();
	for (const channel of orderedChannels) {
		if (isCategory(channel)) {
			groupsByCategoryId.set(channel.id, {
				category: channel,
				textChannels: [],
				voiceChannels: [],
				children: [],
			});
		}
	}

	// `orderedChannels` is depth-first, so a parent category is always created and attached before
	// anything that names it — one pass suffices and sibling order is preserved by insertion.
	for (const channel of orderedChannels) {
		const parentId = resolveParentId(channel);
		const parentGroup = parentId == null ? null : (groupsByCategoryId.get(parentId) ?? null);
		if (isCategory(channel)) {
			const group = groupsByCategoryId.get(channel.id);
			if (!group) {
				continue;
			}
			if (parentGroup) {
				parentGroup.children.push(group);
			} else {
				rootCategories.push(group);
			}
			continue;
		}
		const bucket = parentGroup ?? rootGroup;
		if (isTextChannel(channel)) {
			bucket.textChannels.push(channel);
		} else if (isVoiceChannel(channel)) {
			bucket.voiceChannels.push(channel);
		}
	}

	// Root bucket first, then the root-level categories — the order the sidebar has always used.
	return [rootGroup, ...rootCategories];
};
