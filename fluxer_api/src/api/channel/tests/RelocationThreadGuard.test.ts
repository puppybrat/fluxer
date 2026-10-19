// SPDX-License-Identifier: AGPL-3.0-or-later

// LOCAL-ONLY: tests for the relocation thread/forum guard (step 5a, D6) — exclude from upstream sync.

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {
	acceptInvite,
	createChannel,
	createChannelInvite,
	createDmChannel,
	createFriendship,
	createGuild,
} from '@app/api/channel/tests/ChannelTestUtils';
import {publish} from '@app/api/channel/tests/CrosspostTestUtils';
import {
	ALL_THREADS_ACTIVE,
	resetChannelThreadsConfig,
	setChannelThreadsConfig,
	threadsRequest,
} from '@app/api/channel/tests/ThreadTestUtils';
import {ensureSessionStarted, sendMessage} from '@app/api/message/tests/MessageTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import type {StartForumThreadResponse} from '@fluxer/schema/src/domains/channel/ForumRequestSchemas';
import type {ThreadChannelResponse} from '@fluxer/schema/src/domains/channel/ThreadRequestSchemas';
import type {MessageResponse} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

interface World {
	owner: TestAccount;
	friend: TestAccount;
	guildId: string;
	text: ChannelResponse;
	other: ChannelResponse;
}

describe('relocation refuses thread, forum and media channels and thread-bound messages (D6)', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		resetChannelThreadsConfig();
	});

	afterAll(async () => {
		resetChannelThreadsConfig();
		await harness.shutdown();
	});

	async function world(): Promise<World> {
		await setChannelThreadsConfig(ALL_THREADS_ACTIVE);
		const owner = await createTestAccount(harness);
		const friend = await createTestAccount(harness);
		await ensureSessionStarted(harness, owner.token);
		await ensureSessionStarted(harness, friend.token);
		const guild = await createGuild(harness, owner.token, 'relocation');
		const text = await createChannel(harness, owner.token, guild.id, 'text');
		const other = await createChannel(harness, owner.token, guild.id, 'other');
		const invite = await createChannelInvite(harness, owner.token, text.id);
		await acceptInvite(harness, friend.token, invite.code);
		return {owner, friend, guildId: guild.id, text, other};
	}

	function relocate(token: string, sourceChannelId: string, destChannelId: string, start: string, end = start) {
		return createBuilder<{movedCount: number}>(harness, token)
			.post('/channels/relocate-messages')
			.body({sourceChannelId, destChannelId, startMessageId: start, endMessageId: end});
	}

	async function threadFrom(w: World, message: MessageResponse): Promise<ThreadChannelResponse> {
		return threadsRequest<ThreadChannelResponse>(harness, w.owner.token)
			.post(`/channels/${w.text.id}/messages/${message.id}/threads`)
			.body({name: 'thread'})
			.expect(201)
			.execute();
	}

	async function forumOrMedia(w: World, type: number): Promise<ChannelResponse> {
		return threadsRequest<ChannelResponse>(harness, w.owner.token)
			.post(`/guilds/${w.guildId}/channels`)
			.body({name: type === ChannelTypes.GUILD_MEDIA ? 'media' : 'forum', type})
			.execute();
	}

	async function forumPost(w: World, forumId: string): Promise<StartForumThreadResponse> {
		return threadsRequest<StartForumThreadResponse>(harness, w.owner.token)
			.post(`/channels/${forumId}/threads`)
			.body({name: 'post', message: {content: 'hello'}})
			.expect(201)
			.execute();
	}

	// Thread channels exist only for thread-capable clients, so reads go out with the feature header.
	async function messagesIn(token: string, channelId: string): Promise<Array<string>> {
		const messages = await threadsRequest<Array<MessageResponse>>(harness, token)
			.get(`/channels/${channelId}/messages`)
			.execute();
		return messages.map((message) => message.id);
	}

	describe('channel types', () => {
		it('refuses a thread as the source', async () => {
			const w = await world();
			const thread = await threadFrom(w, await sendMessage(harness, w.owner.token, w.text.id, 'starter'));
			const inThread = await threadsRequest<MessageResponse>(harness, w.owner.token)
				.post(`/channels/${thread.id}/messages`)
				.body({content: 'reply in thread'})
				.execute();
			await relocate(w.owner.token, thread.id, w.other.id, inThread.id)
				.expect(400, APIErrorCodes.INVALID_CHANNEL_TYPE)
				.execute();
			expect(await messagesIn(w.owner.token, thread.id)).toContain(inThread.id);
		});

		it('refuses a thread as the destination', async () => {
			const w = await world();
			const thread = await threadFrom(w, await sendMessage(harness, w.owner.token, w.text.id, 'starter'));
			const plain = await sendMessage(harness, w.owner.token, w.text.id, 'plain');
			await relocate(w.owner.token, w.text.id, thread.id, plain.id)
				.expect(400, APIErrorCodes.INVALID_CHANNEL_TYPE)
				.execute();
			expect(await messagesIn(w.owner.token, w.text.id)).toContain(plain.id);
		});

		for (const [label, type] of [
			['forum', ChannelTypes.GUILD_FORUM],
			['media', ChannelTypes.GUILD_MEDIA],
		] as const) {
			it(`refuses a ${label} channel as the source`, async () => {
				const w = await world();
				const parent = await forumOrMedia(w, type);
				const plain = await sendMessage(harness, w.owner.token, w.text.id, 'plain');
				await relocate(w.owner.token, parent.id, w.other.id, plain.id)
					.expect(400, APIErrorCodes.INVALID_CHANNEL_TYPE)
					.execute();
			});

			it(`refuses a ${label} channel as the destination`, async () => {
				const w = await world();
				const parent = await forumOrMedia(w, type);
				const plain = await sendMessage(harness, w.owner.token, w.text.id, 'plain');
				await relocate(w.owner.token, w.text.id, parent.id, plain.id)
					.expect(400, APIErrorCodes.INVALID_CHANNEL_TYPE)
					.execute();
				expect(await messagesIn(w.owner.token, w.text.id)).toContain(plain.id);
			});
		}
	});

	describe('messages', () => {
		it('refuses a range containing the message a thread was started from', async () => {
			const w = await world();
			const before = await sendMessage(harness, w.owner.token, w.text.id, 'before');
			const starter = await sendMessage(harness, w.owner.token, w.text.id, 'starter');
			await threadFrom(w, starter);
			const after = await sendMessage(harness, w.owner.token, w.text.id, 'after');
			await relocate(w.owner.token, w.text.id, w.other.id, before.id, after.id)
				.expect(400, APIErrorCodes.RELOCATION_MESSAGE_NOT_MOVABLE)
				.execute();
			// Refused before anything moved: the messages around the starter stay put too.
			const remaining = await messagesIn(w.owner.token, w.text.id);
			expect(remaining).toEqual(expect.arrayContaining([before.id, starter.id, after.id]));
		});

		it('refuses a forum post', async () => {
			const w = await world();
			const forum = await forumOrMedia(w, ChannelTypes.GUILD_FORUM);
			const post = await forumPost(w, forum.id);
			const firstMessageId = post.message?.id ?? post.id;
			// A forum post is a thread under the forum, so its messages are refused with the channel.
			await relocate(w.owner.token, post.id, w.other.id, firstMessageId)
				.expect(400, APIErrorCodes.INVALID_CHANNEL_TYPE)
				.execute();
			expect(await messagesIn(w.owner.token, post.id)).toContain(firstMessageId);
		});

		it('refuses a published announcement', async () => {
			const w = await world();
			const news = await createChannel(harness, w.owner.token, w.guildId, 'news', ChannelTypes.GUILD_ANNOUNCEMENT);
			const announcement = await sendMessage(harness, w.owner.token, news.id, 'big news');
			await publish(harness, w.owner.token, news.id, announcement.id);
			await relocate(w.owner.token, news.id, w.other.id, announcement.id)
				.expect(400, APIErrorCodes.RELOCATION_MESSAGE_NOT_MOVABLE)
				.execute();
			expect(await messagesIn(w.owner.token, news.id)).toContain(announcement.id);
		});
	});

	describe('still allowed', () => {
		it('moves messages from a DM into a server channel', async () => {
			const w = await world();
			await createFriendship(harness, w.owner, w.friend);
			const dm = await createDmChannel(harness, w.owner.token, w.friend.userId);
			const first = await sendMessage(harness, w.owner.token, dm.id, 'from the dm');
			const second = await sendMessage(harness, w.friend.token, dm.id, 'reply in the dm');
			const result = await relocate(w.owner.token, dm.id, w.text.id, first.id, second.id).expect(200).execute();
			expect(result.movedCount).toBe(2);
			expect(await messagesIn(w.owner.token, w.text.id)).toEqual(expect.arrayContaining([first.id, second.id]));
		});

		it('moves messages between two server channels', async () => {
			const w = await world();
			const message = await sendMessage(harness, w.owner.token, w.text.id, 'to move');
			const result = await relocate(w.owner.token, w.text.id, w.other.id, message.id).expect(200).execute();
			expect(result.movedCount).toBe(1);
			expect(await messagesIn(w.owner.token, w.other.id)).toContain(message.id);
		});

		it('moves an unpublished message out of an announcement channel', async () => {
			const w = await world();
			const news = await createChannel(harness, w.owner.token, w.guildId, 'news', ChannelTypes.GUILD_ANNOUNCEMENT);
			const draft = await sendMessage(harness, w.owner.token, news.id, 'not published');
			const result = await relocate(w.owner.token, news.id, w.text.id, draft.id).expect(200).execute();
			expect(result.movedCount).toBe(1);
		});
	});
});
