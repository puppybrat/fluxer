// SPDX-License-Identifier: AGPL-3.0-or-later

export const DND_TYPES = {
	CHANNEL: 'channel',
	CATEGORY: 'category',
	VOICE_PARTICIPANT: 'voice-participant',
	GUILD_ITEM: 'guild-item',
	GUILD_FOLDER: 'guild-folder',
	ATTACHMENT: 'attachment',
	CONNECTION: 'connection',
} as const;

export interface DragItem {
	type: string;
	id: string;
	channelType: number;
	parentId: string | null;
	guildId: string;
	userId?: string;
	currentChannelId?: string;
	/**
	 * Every channel beneath a dragged CATEGORY, at any depth. Absent for non-category drags.
	 *
	 * Snapshotted when the drag starts so the drop rules can reject nesting a category into its own
	 * subtree without the reorder state machine having to reach into the Channels store — it stays a
	 * pure function of (item, target), which is what makes it directly testable.
	 */
	descendantIds?: ReadonlySet<string>;
}

export interface DropResult {
	targetId: string;
	position: 'before' | 'after' | 'inside';
	targetParentId: string | null;
}

export interface GuildDragItem {
	type: typeof DND_TYPES.GUILD_ITEM | typeof DND_TYPES.GUILD_FOLDER;
	id: string;
	isFolder: boolean;
	folderId?: number | null;
}

export type GuildDropPosition = 'before' | 'after' | 'inside' | 'combine';

export interface GuildDropResult {
	targetId: string;
	position: GuildDropPosition;
	targetIsFolder: boolean;
	targetFolderId?: number | null;
}

export interface AttachmentDragItem {
	type: typeof DND_TYPES.ATTACHMENT;
	id: number;
	channelId: string;
}

export interface AttachmentDropResult {
	targetId: number;
	position: 'before' | 'after';
}

export interface ConnectionDragItem {
	type: typeof DND_TYPES.CONNECTION;
	id: string;
	index: number;
}
