/*
 * LOCAL-ONLY: This file is a local-only addition to fluxer_api and will never exist upstream.
 * It implements the storage layer for /channels/relocate-messages — an admin endpoint that
 * moves a contiguous range of messages from one channel to another by rewriting fluxer_kv rows.
 *
 * Known limitations (not fixed here):
 *  - Meilisearch search index is NOT updated; search results for moved messages will be stale
 *    until the next full re-index.
 *  - No gateway events are dispatched for moved messages.
 *
 * Lines to check on upstream merge: none — exclude this file entirely from any upstream sync.
 */

// SPDX-License-Identifier: AGPL-3.0-or-later

import * as BucketUtils from '@fluxer/snowflake/src/SnowflakeBuckets';
import type {ChannelID, MessageID} from '../../../BrandedTypes';
import {BatchBuilder, fetchMany, fetchOne, upsertOne} from '../../../database/CassandraQueryExecution';
import {Db} from '../../../database/CassandraTypes';
import type {ChannelMessageBucketRow, ChannelStateRow, MessageReactionRow, MessageRow} from '../../../database/types/MessageTypes';
import {
	AttachmentLookup,
	ChannelEmptyBuckets,
	ChannelMessageBuckets,
	ChannelPins,
	ChannelState,
	Messages,
	MessagesByAuthorV2,
	MessageReactions,
} from '../../../Tables';

const FETCH_MESSAGES_IN_BUCKET = Messages.select({
	where: [Messages.where.eq('channel_id'), Messages.where.eq('bucket')],
	limit: 10_000,
});

const FETCH_REACTIONS_FOR_MESSAGE = MessageReactions.selectCql({
	where: [
		MessageReactions.where.eq('channel_id'),
		MessageReactions.where.eq('bucket'),
		MessageReactions.where.eq('message_id'),
	],
});

const HAS_ANY_MESSAGE_IN_BUCKET = Messages.select({
	columns: ['message_id'],
	where: [Messages.where.eq('channel_id'), Messages.where.eq('bucket')],
	limit: 1,
});

const FETCH_CHANNEL_STATE = ChannelState.select({
	where: ChannelState.where.eq('channel_id'),
	limit: 1,
});

const LIST_BUCKETS_DESC = ChannelMessageBuckets.select({
	columns: ['bucket'],
	where: ChannelMessageBuckets.where.eq('channel_id'),
	orderBy: {col: 'bucket', direction: 'DESC'},
	limit: 200,
});

const FETCH_LATEST_MESSAGE_IN_BUCKET = Messages.select({
	columns: ['message_id'],
	where: [Messages.where.eq('channel_id'), Messages.where.eq('bucket')],
	orderBy: {col: 'message_id', direction: 'DESC'},
	limit: 1,
});

export class MessageRelocationRepository {
	async relocateMessages({
		sourceChannelId,
		destChannelId,
		startMessageId,
		endMessageId,
	}: {
		sourceChannelId: ChannelID;
		destChannelId: ChannelID;
		startMessageId: MessageID;
		endMessageId: MessageID;
	}): Promise<{movedCount: number}> {
		if (startMessageId > endMessageId) {
			return {movedCount: 0};
		}

		const buckets = BucketUtils.makeBuckets(startMessageId, endMessageId);
		let movedCount = 0;
		let maxMovedMessageId: MessageID | null = null;
		let maxMovedBucket: number | null = null;

		for (const bucket of buckets) {
			const allRows = await fetchMany<MessageRow>(
				FETCH_MESSAGES_IN_BUCKET.bind({channel_id: sourceChannelId, bucket}),
			);
			const inRange = allRows.filter(
				(r) => r.message_id >= startMessageId && r.message_id <= endMessageId,
			);
			if (inRange.length === 0) continue;

			for (const msgRow of inRange) {
				const reactions = await fetchMany<MessageReactionRow>(FETCH_REACTIONS_FOR_MESSAGE, {
					channel_id: sourceChannelId,
					bucket,
					message_id: msgRow.message_id,
				});

				const batch = new BatchBuilder();

				// Move the message row: delete from source, insert at dest
				batch.addPrepared(
					Messages.deleteByPk({
						channel_id: sourceChannelId,
						bucket,
						message_id: msgRow.message_id,
					}),
				);
				batch.addPrepared(
					Messages.upsertAll({
						...msgRow,
						channel_id: destChannelId,
					}),
				);

				// Update author index (channel_id is a non-PK column; PK is author_id + message_id)
				if (msgRow.author_id != null) {
					batch.addPrepared(
						MessagesByAuthorV2.upsertAll({
							author_id: msgRow.author_id,
							channel_id: destChannelId,
							message_id: msgRow.message_id,
						}),
					);
				}

				// Move reactions: bulk-delete from source partition, re-insert at dest
				if (reactions.length > 0) {
					batch.addPrepared(
						MessageReactions.delete({
							where: [
								MessageReactions.where.eq('channel_id'),
								MessageReactions.where.eq('bucket'),
								MessageReactions.where.eq('message_id'),
							],
						}).bind({
							channel_id: sourceChannelId,
							bucket,
							message_id: msgRow.message_id,
						}),
					);
					for (const reaction of reactions) {
						batch.addPrepared(
							MessageReactions.upsertAll({
								...reaction,
								channel_id: destChannelId,
							}),
						);
					}
				}

				// Move attachment lookup entries
				if (msgRow.attachments) {
					for (const att of msgRow.attachments) {
						batch.addPrepared(
							AttachmentLookup.deleteByPk({
								channel_id: sourceChannelId,
								attachment_id: att.attachment_id,
								filename: att.filename,
							}),
						);
						batch.addPrepared(
							AttachmentLookup.upsertAll({
								channel_id: destChannelId,
								attachment_id: att.attachment_id,
								filename: att.filename,
								message_id: msgRow.message_id,
							}),
						);
					}
				}

				// Move pin entry if the message is pinned
				if (msgRow.pinned_timestamp) {
					batch.addPrepared(
						ChannelPins.deleteByPk({
							channel_id: sourceChannelId,
							pinned_timestamp: msgRow.pinned_timestamp,
							message_id: msgRow.message_id,
						}),
					);
					batch.addPrepared(
						ChannelPins.upsertAll({
							channel_id: destChannelId,
							pinned_timestamp: msgRow.pinned_timestamp,
							message_id: msgRow.message_id,
						}),
					);
				}

				await batch.execute(true);

				movedCount++;
				if (maxMovedMessageId === null || msgRow.message_id > maxMovedMessageId) {
					maxMovedMessageId = msgRow.message_id as MessageID;
					maxMovedBucket = bucket;
				}
			}

			// Update destination bucket index and channel state
			const destBucketBatch = new BatchBuilder();
			destBucketBatch.addPrepared(
				ChannelMessageBuckets.upsertAll({
					channel_id: destChannelId,
					bucket,
					updated_at: new Date(),
				}),
			);
			destBucketBatch.addPrepared(
				ChannelEmptyBuckets.deleteByPk({
					channel_id: destChannelId,
					bucket,
				}),
			);
			destBucketBatch.addPrepared(
				ChannelState.patchByPk(
					{channel_id: destChannelId},
					{
						created_bucket: Db.set(BucketUtils.makeBucket(destChannelId)),
						has_messages: Db.set(true),
						updated_at: Db.set(new Date()),
					},
				),
			);
			await destBucketBatch.execute(true);

			// If the source bucket is now empty, update its index
			const hasAny = await fetchOne<{message_id: bigint}>(
				HAS_ANY_MESSAGE_IN_BUCKET.bind({channel_id: sourceChannelId, bucket}),
			);
			if (!hasAny) {
				const emptyBatch = new BatchBuilder();
				emptyBatch.addPrepared(
					ChannelMessageBuckets.deleteByPk({
						channel_id: sourceChannelId,
						bucket,
					}),
				);
				emptyBatch.addPrepared(
					ChannelEmptyBuckets.upsertAll({
						channel_id: sourceChannelId,
						bucket,
						updated_at: new Date(),
					}),
				);
				await emptyBatch.execute(true);
			}
		}

		if (movedCount === 0) return {movedCount: 0};

		await this.reconcileSourceChannelState(sourceChannelId);

		if (maxMovedMessageId !== null && maxMovedBucket !== null) {
			await this.advanceChannelStateLastMessageIfNewer(destChannelId, maxMovedMessageId, maxMovedBucket);
		}

		return {movedCount};
	}

	private async reconcileSourceChannelState(channelId: ChannelID): Promise<void> {
		const bucketRows = await fetchMany<Pick<ChannelMessageBucketRow, 'bucket'>>(
			LIST_BUCKETS_DESC.bind({channel_id: channelId}),
		);
		for (const {bucket} of bucketRows) {
			const latest = await fetchOne<{message_id: bigint}>(
				FETCH_LATEST_MESSAGE_IN_BUCKET.bind({channel_id: channelId, bucket}),
			);
			if (!latest) {
				const emptyBatch = new BatchBuilder();
				emptyBatch.addPrepared(ChannelMessageBuckets.deleteByPk({channel_id: channelId, bucket}));
				emptyBatch.addPrepared(
					ChannelEmptyBuckets.upsertAll({channel_id: channelId, bucket, updated_at: new Date()}),
				);
				await emptyBatch.execute(true);
				continue;
			}
			await upsertOne(
				ChannelState.patchByPk(
					{channel_id: channelId},
					{
						has_messages: Db.set(true),
						last_message_bucket: Db.set(bucket),
						last_message_id: Db.set(latest.message_id as MessageID),
						updated_at: Db.set(new Date()),
					},
				),
			);
			return;
		}
		await upsertOne(
			ChannelState.patchByPk(
				{channel_id: channelId},
				{
					has_messages: Db.set(false),
					last_message_bucket: Db.clear(),
					last_message_id: Db.clear(),
					updated_at: Db.set(new Date()),
				},
			),
		);
	}

	private async advanceChannelStateLastMessageIfNewer(
		channelId: ChannelID,
		newLastMessageId: MessageID,
		newLastMessageBucket: number,
	): Promise<void> {
		const state = await fetchOne<ChannelStateRow>(FETCH_CHANNEL_STATE.bind({channel_id: channelId}));
		const prev = state?.last_message_id ?? null;
		if (prev !== null && newLastMessageId <= prev) return;
		await upsertOne(
			ChannelState.patchByPk(
				{channel_id: channelId},
				{
					has_messages: Db.set(true),
					last_message_id: Db.set(newLastMessageId),
					last_message_bucket: Db.set(newLastMessageBucket),
					updated_at: Db.set(new Date()),
				},
			),
		);
	}
}
