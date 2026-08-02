// SPDX-License-Identifier: AGPL-3.0-or-later

import {MessageTypes} from '@fluxer/constants/src/ChannelConstants';
import * as BucketUtils from '@fluxer/snowflake/src/SnowflakeBuckets';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {createChannelID, createMessageID, createUserID} from '../../BrandedTypes';
import {type ApiTestHarness, createApiTestHarness} from '../../test/ApiTestHarness';
import {ChannelRepository} from '../ChannelRepository';
import {sendChannelMessage, setupTestGuildWithMembers} from './ChannelTestUtils';

// A backfilled/imported message carries its original timestamp, so its snowflake —
// and therefore its bucket — can predate the channel it now lives in. `created_bucket`
// is the floor of every bucket scan in MessageDataRepository, so if a plain message
// send re-raises it to the channel's own creation bucket, that imported history stops
// being listable (and therefore stops being indexable for search).
describe('channel_state.created_bucket floor', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	it('keeps backfilled history listable after a later message is sent', async () => {
		const {owner, systemChannel} = await setupTestGuildWithMembers(harness, 0);
		const channelRepository = new ChannelRepository();
		const channelId = createChannelID(BigInt(systemChannel.id));
		await sendChannelMessage(harness, owner.token, systemChannel.id, 'live message before backfill');

		// Simulate imported history: a message whose snowflake predates the channel.
		const channelBucket = BucketUtils.makeBucket(BigInt(systemChannel.id));
		const backfilledId = createMessageID((BigInt(channelBucket - 40) * 864000000n) << 22n);
		const backfilledBucket = BucketUtils.makeBucket(backfilledId);
		expect(backfilledBucket).toBeLessThan(channelBucket);
		await channelRepository.upsertMessage({
			channel_id: channelId,
			bucket: backfilledBucket,
			message_id: backfilledId,
			author_id: createUserID(BigInt(owner.userId)),
			type: MessageTypes.DEFAULT,
			webhook_id: null,
			webhook_name: null,
			webhook_avatar_hash: null,
			content: 'imported history',
			edited_timestamp: null,
			pinned_timestamp: null,
			flags: 0,
			mention_everyone: false,
			mention_users: null,
			mention_roles: null,
			mention_channels: null,
			attachments: null,
			embeds: null,
			sticker_items: null,
			message_reference: null,
			message_snapshots: null,
			call: null,
			nsfw_emojis: null,
			has_reaction: false,
			version: 1,
		});

		const beforeSend = await channelRepository.listMessages(channelId, undefined, 100);
		expect(beforeSend.map((m) => m.id.toString())).toContain(backfilledId.toString());

		// The regression: this send used to reset created_bucket back up to the
		// channel's own creation bucket, dropping the imported history out of scan range.
		await sendChannelMessage(harness, owner.token, systemChannel.id, 'live message after backfill');

		const afterSend = await channelRepository.listMessages(channelId, undefined, 100);
		expect(afterSend.map((m) => m.id.toString())).toContain(backfilledId.toString());
	});
});
