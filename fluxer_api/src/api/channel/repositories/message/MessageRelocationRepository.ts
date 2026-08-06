/*
 * LOCAL-ONLY: This file is a local-only addition to fluxer_api and will never exist upstream.
 * It implements the storage layer for /channels/relocate-messages — an admin endpoint that
 * moves a contiguous range of messages from one channel to another by rewriting fluxer_kv rows.
 * It also writes a relocate audit log entry (RelocateLog table) after a successful move, read
 * back by GET /channels/relocate-log.
 *
 * Known limitations (not fixed here):
 *  - Meilisearch search index is NOT updated; search results for moved messages will be stale
 *    until the next full re-index.
 *  - No gateway events are dispatched for moved messages.
 *
 * Lines to check on upstream merge: none — exclude this file entirely from any upstream sync.
 */

// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {BadRequestError} from '@fluxer/errors/src/domains/core/BadRequestError';
import * as BucketUtils from '@fluxer/snowflake/src/SnowflakeBuckets';
import type {ChannelID, MessageID, UserID} from '../../../BrandedTypes';
import {Config} from '../../../Config';
import {BatchBuilder, fetchMany, fetchOne, upsertOne} from '../../../database/CassandraQueryExecution';
import {Db} from '../../../database/CassandraTypes';
import type {
	ChannelMessageBucketRow,
	ChannelStateRow,
	MessageAttachment,
	MessageReactionRow,
	MessageRow,
} from '../../../database/types/MessageTypes';
import type {IStorageService} from '../../../infrastructure/IStorageService';
import {Logger} from '../../../Logger';
import {
	AttachmentLookup,
	ChannelEmptyBuckets,
	ChannelMessageBuckets,
	ChannelPins,
	ChannelState,
	Messages,
	MessagesByAuthorV2,
	MessageReactions,
	RelocateLog,
	type RelocateLogRow,
} from '../../../Tables';

/*
 * LOCAL-ONLY: message discovery for relocation — exclude from upstream sync.
 *
 * WHAT CHANGED
 * Discovery used to read each candidate bucket in full (`SELECT ... WHERE channel_id = ? AND
 * bucket = ?` with `limit: 10_000`) and then filter the requested id range out of that result
 * set in JS. It now pushes the range into the query itself via `message_id >= ? AND
 * message_id <= ?`, so the database only ever returns rows that are actually in range.
 *
 * WHY
 * The old bucket-wide read was silently truncated. `PostgresKvQueryExecutor.select()` sorts by
 * primary key (message_id ascending) and applies the limit *after* sorting, so a bucket holding
 * more than 10,000 messages returned only its 10,000 OLDEST rows. Anything past that point was
 * invisible to the range filter, so the endpoint reported `{movedCount: 0}` with no error — the
 * caller could not distinguish "range is empty" from "range was truncated away".
 *
 * This hit imported Discord-era history hardest, because those buckets are dense: in the channel
 * that surfaced the bug, 33 of 218 buckets exceeded 10,000 rows, leaving ~117,000 messages (~10%
 * of the channel) permanently unrelocatable regardless of the range selected. Real Cassandra also
 * applies LIMIT after clustering order, so this was never a Postgres-shim-only artifact.
 *
 * Note that `channel_message_buckets` was never involved in discovery and still is not: the
 * bucket list comes from `BucketUtils.makeBuckets(startMessageId, endMessageId)`, which is pure
 * arithmetic on the two snowflakes. That table is only WRITTEN here (dest index upkeep, source
 * empty-bucket cleanup) and read once in `reconcileSourceChannelState` AFTER a successful move.
 * Discovery is therefore independent of that index's correctness, by construction.
 *
 * `bucket` stays in the WHERE clause because it is part of the partition key
 * (partitionKey: ['channel_id', 'bucket']). Dropping it would force a full-table scan of every
 * message in every channel in the KV executor, so the loop iterates the arithmetic bucket range
 * and scopes each read to one partition.
 *
 * IF MERGING UPSTREAM CHANGES, VERIFY
 *  - `Messages` still declares primaryKey ['channel_id','bucket','message_id'] with
 *    partitionKey ['channel_id','bucket'] — the range predicate is only a valid CQL clustering
 *    restriction while message_id remains the trailing clustering column.
 *  - `PostgresKvQueryExecutor.select()` still applies `meta.limit` AFTER `sortRows`. If limiting
 *    ever moves before sorting, MAX_RELOCATION_MESSAGES + 1 stops being a reliable overflow probe.
 *  - The bucket formula in `SnowflakeBuckets.makeBucket` still matches the bucket component
 *    written into message row keys; discovery misses whole partitions if those ever diverge.
 */
const MAX_RELOCATION_MESSAGES = 500;

const FETCH_MESSAGES_IN_BUCKET_RANGE = Messages.select({
	where: [
		Messages.where.eq('channel_id'),
		Messages.where.eq('bucket'),
		Messages.where.gte('message_id', 'start_message_id'),
		Messages.where.lte('message_id', 'end_message_id'),
	],
	// One more than the cap so an oversized range is detected rather than silently trimmed.
	limit: MAX_RELOCATION_MESSAGES + 1,
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
		userId,
		logId,
		storageService,
	}: {
		sourceChannelId: ChannelID;
		destChannelId: ChannelID;
		startMessageId: MessageID;
		endMessageId: MessageID;
		userId: UserID;
		logId: bigint;
		storageService: IStorageService;
	}): Promise<{movedCount: number}> {
		if (startMessageId > endMessageId) {
			return {movedCount: 0};
		}

		const buckets = BucketUtils.makeBuckets(startMessageId, endMessageId);

		// Phase 1 — discovery. Every in-range row is collected before anything is mutated so the
		// size of the operation is known up front: an oversized range has to abort cleanly rather
		// than move a partial prefix of itself and then fail.
		const rowsByBucket = new Map<number, Array<MessageRow>>();
		let totalInRange = 0;
		for (const bucket of buckets) {
			const inRange = await fetchMany<MessageRow>(
				FETCH_MESSAGES_IN_BUCKET_RANGE.bind({
					channel_id: sourceChannelId,
					bucket,
					start_message_id: startMessageId,
					end_message_id: endMessageId,
				}),
			);
			if (inRange.length === 0) continue;

			totalInRange += inRange.length;
			if (totalInRange > MAX_RELOCATION_MESSAGES) {
				// Counting stops at the first bucket that crosses the cap, so this is a lower
				// bound on the true range size, not the exact total.
				Logger.warn(
					{
						sourceChannelId,
						destChannelId,
						startMessageId,
						endMessageId,
						attemptedCountAtLeast: totalInRange,
						maximum: MAX_RELOCATION_MESSAGES,
					},
					'Relocation: refusing a range above the per-request message cap; nothing was moved',
				);
				throw new BadRequestError({
					code: APIErrorCodes.BAD_REQUEST,
					message: `Range too large, maximum ${MAX_RELOCATION_MESSAGES} messages per relocation.`,
				});
			}
			rowsByBucket.set(bucket, inRange);
		}

		// Nothing in range: return before touching bucket indexes, channel state or the audit log.
		if (totalInRange === 0) {
			return {movedCount: 0};
		}

		let movedCount = 0;
		let maxMovedMessageId: MessageID | null = null;
		let maxMovedBucket: number | null = null;

		// Phase 2 — mutation. Still strictly bucket-by-bucket, so the secondary index upkeep at the
		// end of each iteration (dest bucket index, source empty-bucket cleanup) stays keyed by
		// bucket exactly as it was before.
		for (const [bucket, inRange] of rowsByBucket) {
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

				// LOCAL-ONLY: move the attachment files in SeaweedFS to follow the message.
				// Done after the row batch commits so a file-move failure can never abort an
				// already-committed relocation (see moveAttachmentFiles for the full rationale).
				if (msgRow.attachments && msgRow.attachments.length > 0) {
					await this.moveAttachmentFiles({
						attachments: msgRow.attachments,
						sourceChannelId,
						destChannelId,
						storageService,
					});
				}

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
			// Relocated messages keep their original ids, so a move can pull history
			// older than the destination channel itself into it. `created_bucket` is a
			// scan floor, so it must only ever move down — see the matching guard in
			// MessageDataRepository.resolveLoweredCreatedBucket.
			const destCreatedBucket = await this.resolveLoweredCreatedBucket(destChannelId, bucket);
			destBucketBatch.addPrepared(
				ChannelState.patchByPk(
					{channel_id: destChannelId},
					{
						created_bucket: Db.set(destCreatedBucket),
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

		await this.writeRelocateLogEntry({
			log_id: logId,
			performed_by: userId,
			source_channel_id: sourceChannelId,
			dest_channel_id: destChannelId,
			start_message_id: startMessageId,
			end_message_id: endMessageId,
			moved_count: movedCount,
			created_at: new Date(),
		});

		return {movedCount};
	}

	// LOCAL-ONLY: SeaweedFS attachment file move — exclude from upstream sync.
	//
	// The row operations above relocate a message into the destination channel, but the
	// attachment *bytes* stay in SeaweedFS under the old key:
	//
	//     attachments/<sourceChannelId>/<attachment_id>/<filename>
	//
	// The media proxy builds every attachment url from the message's current channel_id
	// (see makeAttachmentCdnKey in channel/services/message/MessageHelpers.ts), so a
	// relocated message resolves to attachments/<destChannelId>/... — which 404s until the
	// file is moved. This copies each attachment to the destination key and only then
	// deletes the source (copy-before-delete: the source is removed strictly after the copy
	// succeeds, so a failure never destroys the only copy).
	//
	// A file-move failure is logged and skipped, never thrown: the row batch has already
	// committed, so a stranded or duplicated file is recoverable by hand, whereas aborting
	// here would leave the message half-relocated. The keys are inlined (rather than importing
	// makeAttachmentCdnKey) to keep this repository free of service-layer imports; the pattern
	// is identical.
	private async moveAttachmentFiles({
		attachments,
		sourceChannelId,
		destChannelId,
		storageService,
	}: {
		attachments: Array<MessageAttachment>;
		sourceChannelId: ChannelID;
		destChannelId: ChannelID;
		storageService: IStorageService;
	}): Promise<void> {
		const bucket = Config.s3.buckets.cdn;
		for (const att of attachments) {
			const sourceKey = `attachments/${sourceChannelId}/${att.attachment_id}/${att.filename}`;
			const destinationKey = `attachments/${destChannelId}/${att.attachment_id}/${att.filename}`;
			if (sourceKey === destinationKey) continue;

			// COPY first — never touch the source until the destination copy succeeds.
			try {
				await storageService.copyObject({
					sourceBucket: bucket,
					sourceKey,
					destinationBucket: bucket,
					destinationKey,
				});
			} catch (error) {
				Logger.error(
					{error, sourceChannelId, destChannelId, sourceKey, destinationKey, filename: att.filename},
					'Relocation: failed to copy attachment file to destination channel; source left in place, message will 404 until fixed manually',
				);
				continue;
			}

			// DELETE the source only after the copy is confirmed committed above.
			try {
				await storageService.deleteObject(bucket, sourceKey);
			} catch (error) {
				Logger.error(
					{error, sourceChannelId, destChannelId, sourceKey, destinationKey, filename: att.filename},
					'Relocation: copied attachment to destination but failed to delete source; source left as a recoverable duplicate',
				);
			}
		}
	}

	// LOCAL-ONLY: relocate audit log write — exclude from upstream sync.
	private async writeRelocateLogEntry(row: RelocateLogRow): Promise<void> {
		await upsertOne(RelocateLog.upsertAll(row));
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

	private async resolveLoweredCreatedBucket(channelId: ChannelID, messageBucket: number): Promise<number> {
		const channelBucket = BucketUtils.makeBucket(channelId);
		const state = await fetchOne<ChannelStateRow>(FETCH_CHANNEL_STATE.bind({channel_id: channelId}));
		const existing = state?.created_bucket ?? null;
		const candidate = Math.min(channelBucket, messageBucket);
		return existing === null ? candidate : Math.min(existing, candidate);
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
