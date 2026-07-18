/*
 * LOCAL-ONLY: This file is a local-only addition to fluxer_api and will never exist upstream.
 * It exposes POST /channels/relocate-messages — an admin-only endpoint for moving a
 * contiguous range of messages from one channel to another — and GET /channels/relocate-log,
 * which reads back the audit log of past relocations (see Tables.ts's RelocateLog table and
 * MessageRelocationRepository's writeRelocateLogEntry).
 *
 * Known limitations (not fixed here):
 *  - Meilisearch search index is NOT updated after the move.
 *  - No gateway events are dispatched for moved messages.
 *
 * Lines to check on upstream merge: none — exclude this file entirely from any upstream sync.
 */

// SPDX-License-Identifier: AGPL-3.0-or-later

import {z} from 'zod';
import type {ChannelID, UserID} from '../../BrandedTypes';
import {createChannelID, createMessageID} from '../../BrandedTypes';
import {fetchMany, fetchOne} from '../../database/CassandraQueryExecution';
import type {ChannelRow} from '../../database/types/ChannelTypes';
import type {UserRow} from '../../database/types/UserTypes';
import {LoginRequired} from '../../middleware/AuthMiddleware';
import {Channels, RelocateLog, type RelocateLogRow, Users} from '../../Tables';
import type {HonoApp} from '../../types/HonoEnv';
import {Validator} from '../../Validator';
import {MessageRelocationRepository} from '../repositories/message/MessageRelocationRepository';

const RelocateMessagesRequest = z.object({
	sourceChannelId: z.string(),
	destChannelId: z.string(),
	startMessageId: z.string(),
	endMessageId: z.string(),
});

// LOCAL-ONLY: relocate audit log query — exclude from upstream sync.
const RelocateLogQuery = z.object({
	limit: z.coerce.number().int().min(1).max(50).optional(),
});

const FETCH_CHANNEL_BY_ID = Channels.select({
	where: [Channels.where.eq('channel_id'), Channels.where.eq('soft_deleted')],
	limit: 1,
});

const FETCH_USER_BY_ID = Users.select({
	where: Users.where.eq('user_id'),
	limit: 1,
});

async function resolveChannelName(channelId: ChannelID): Promise<string | null> {
	const channel = await fetchOne<ChannelRow>(
		FETCH_CHANNEL_BY_ID.bind({channel_id: channelId, soft_deleted: false}),
	);
	return channel?.name ?? null;
}

async function resolveUserDisplayName(userId: UserID): Promise<string | null> {
	const user = await fetchOne<UserRow>(FETCH_USER_BY_ID.bind({user_id: userId}));
	if (!user) return null;
	return user.global_name ?? user.username;
}

export function RelocateMessagesController(app: HonoApp) {
	app.post(
		'/channels/relocate-messages',
		LoginRequired,
		Validator('json', RelocateMessagesRequest),
		async (ctx) => {
			const {sourceChannelId, destChannelId, startMessageId, endMessageId} = ctx.req.valid('json');
			const userId = ctx.get('user').id;
			const logId = await ctx.get('snowflakeService').generate();
			// LOCAL-ONLY: storageService is threaded through so the repository can move each
			// relocated message's attachment files in SeaweedFS to follow it (see
			// MessageRelocationRepository.moveAttachmentFiles). Exclude from upstream sync.
			const storageService = ctx.get('storageService');
			const repo = new MessageRelocationRepository();
			const result = await repo.relocateMessages({
				sourceChannelId: createChannelID(BigInt(sourceChannelId)),
				destChannelId: createChannelID(BigInt(destChannelId)),
				startMessageId: createMessageID(BigInt(startMessageId)),
				endMessageId: createMessageID(BigInt(endMessageId)),
				userId,
				logId,
				storageService,
			});
			return ctx.json(result);
		},
	);

	// LOCAL-ONLY: relocate audit log read endpoint — exclude from upstream sync.
	app.get('/channels/relocate-log', LoginRequired, Validator('query', RelocateLogQuery), async (ctx) => {
		const {limit = 20} = ctx.req.valid('query');
		const entries = await fetchMany<RelocateLogRow>(
			RelocateLog.select({orderBy: {col: 'log_id', direction: 'DESC'}, limit}).bind({}),
		);
		const enriched = await Promise.all(
			entries.map(async (entry) => {
				const [sourceChannelName, destChannelName, performerDisplayName] = await Promise.all([
					resolveChannelName(entry.source_channel_id),
					resolveChannelName(entry.dest_channel_id),
					resolveUserDisplayName(entry.performed_by),
				]);
				return {
					logId: entry.log_id.toString(),
					performedBy: {
						id: entry.performed_by.toString(),
						displayName: performerDisplayName,
					},
					sourceChannel: {
						id: entry.source_channel_id.toString(),
						name: sourceChannelName,
					},
					destChannel: {
						id: entry.dest_channel_id.toString(),
						name: destChannelName,
					},
					startMessageId: entry.start_message_id.toString(),
					endMessageId: entry.end_message_id.toString(),
					movedCount: entry.moved_count,
					createdAt: entry.created_at,
				};
			}),
		);
		return ctx.json(enriched);
	});
}
