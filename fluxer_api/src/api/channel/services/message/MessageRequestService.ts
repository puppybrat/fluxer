// SPDX-License-Identifier: AGPL-3.0-or-later

import {UnclaimedAccountCannotSendMessagesError} from '@fluxer/errors/src/domains/channel/UnclaimedAccountCannotSendMessagesError';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {BadRequestError} from '@fluxer/errors/src/domains/core/BadRequestError';
import {CannotExecuteOnDmError} from '@fluxer/errors/src/domains/core/CannotExecuteOnDmError';
import {UnknownMessageError} from '@fluxer/errors/src/domains/channel/UnknownMessageError';
import type {
	BulkMessageFetchResponse,
	MessageResponse,
} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import type {ChannelID, MessageID, UserID} from '../../../BrandedTypes';
import type {RequestCache} from '../../../middleware/RequestCacheMiddleware';
import type {User} from '../../../models/User';
import type {MessageRequest, MessageUpdateRequest} from '../../MessageTypes';
import type {ChannelService} from '../ChannelService';
import {resolveIcCharacterIds} from './MessageIcResolutionService';
import {isPersonalNotesChannel} from './MessageHelpers';
import type {MessageResponseDataService} from './MessageResponseDataService';

export class MessageRequestService {
	constructor(
		private readonly channelService: ChannelService,
		private readonly responseDataService: MessageResponseDataService,
	) {}

	async listMessages(params: {
		userId: UserID;
		channelId: ChannelID;
		query: {
			limit: number;
			before?: MessageID;
			after?: MessageID;
			around?: MessageID;
		};
		requestCache: RequestCache;
	}): Promise<Array<MessageResponse>> {
		const access = await this.channelService.messages.retrieval.getResponseAccessContext({
			userId: params.userId,
			channelId: params.channelId,
		});
		return this.responseDataService.listMessages({
			userId: params.userId,
			channelId: params.channelId,
			limit: params.query.limit,
			before: params.query.before,
			after: params.query.after,
			around: params.query.around,
			access,
		});
	}

	async listMessagesBulk(params: {
		userId: UserID;
		requests: Array<{
			channelId: ChannelID;
			query: {
				limit: number;
				before?: MessageID;
				after?: MessageID;
				around?: MessageID;
			};
		}>;
		requestCache: RequestCache;
	}): Promise<BulkMessageFetchResponse> {
		const channels = await mapWithConcurrency(params.requests, 4, async (request) => ({
			channel_id: request.channelId.toString(),
			messages: await this.listMessages({
				userId: params.userId,
				channelId: request.channelId,
				query: request.query,
				requestCache: params.requestCache,
			}),
		}));
		return {channels};
	}

	async getMessage(params: {
		userId: UserID;
		channelId: ChannelID;
		messageId: MessageID;
		requestCache: RequestCache;
	}): Promise<MessageResponse> {
		const access = await this.channelService.messages.retrieval.getResponseAccessContext({
			userId: params.userId,
			channelId: params.channelId,
			messageId: params.messageId,
		});
		const response = await this.responseDataService.getMessage({
			userId: params.userId,
			channelId: params.channelId,
			messageId: params.messageId,
			access,
		});
		if (response === null) {
			throw new UnknownMessageError();
		}
		return response;
	}

	async sendMessage(params: {
		user: User;
		channelId: ChannelID;
		data: MessageRequest;
		requestCache: RequestCache;
	}): Promise<MessageResponse> {
		if (
			params.user.isUnclaimedAccount() &&
			!isPersonalNotesChannel({userId: params.user.id, channelId: params.channelId})
		) {
			throw new UnclaimedAccountCannotSendMessagesError();
		}
		const message = await this.channelService.messages.send.sendMessage({
			user: params.user,
			channelId: params.channelId,
			data: params.data,
			requestCache: params.requestCache,
		});
		const access = await this.channelService.messages.retrieval.getResponseAccessContext({
			userId: params.user.id,
			channelId: params.channelId,
		});
		return this.responseDataService.buildMessage({
			userId: params.user.id,
			message,
			access: {...access, messageHistoryCutoff: null, canReadMessageHistory: true},
			nonce: params.data.nonce,
			tts: params.data.tts ?? false,
		});
	}

	async editMessage(params: {
		userId: UserID;
		channelId: ChannelID;
		messageId: MessageID;
		data: MessageUpdateRequest;
		requestCache: RequestCache;
	}): Promise<MessageResponse> {
		const message = await this.channelService.messages.edit.editMessage({
			userId: params.userId,
			channelId: params.channelId,
			messageId: params.messageId,
			data: params.data,
			requestCache: params.requestCache,
		});
		const access = await this.channelService.messages.retrieval.getResponseAccessContext({
			userId: params.userId,
			channelId: params.channelId,
			messageId: message.id,
		});
		return this.responseDataService.buildMessage({
			userId: params.userId,
			message,
			access,
		});
	}

	/**
	 * Marks a message in or out of character.
	 *
	 * Any guild member may toggle any message — marking something in-character is ordinary
	 * authoring, not cast administration, so this is not gated on MANAGE_GUILD. Attribution is
	 * always resolved against the message *author*, never the caller, so toggling someone
	 * else's message cannot attribute it to your characters.
	 *
	 * Re-indexes explicitly: this write path does not otherwise touch the search index (edit
	 * and relocate do not either), so without this a message toggled IC would never become
	 * findable by character.
	 */
	async setMessageIc(params: {
		userId: UserID;
		channelId: ChannelID;
		messageId: MessageID;
		ic: boolean;
		characterIds?: Array<string>;
		requestCache: RequestCache;
	}): Promise<MessageResponse> {
		// retrieval.getMessage performs the read-access check, so a user who cannot see the
		// message cannot toggle it either.
		const authChannel = await this.channelService.messages.channelAuth.getChannelAuthenticated({
			userId: params.userId,
			channelId: params.channelId,
		});
		const guildId = authChannel.channel.guildId;
		if (!guildId) {
			// Cast membership is per-guild, so a DM has no owner mapping to resolve against.
			throw new CannotExecuteOnDmError();
		}
		const existing = await this.channelService.messages.retrieval.getMessage({
			userId: params.userId,
			channelId: params.channelId,
			messageId: params.messageId,
		});

		let characterIds: Array<string> = [];
		if (params.ic) {
			const authorId = existing.authorId;
			if (!authorId) {
				throw new BadRequestError({
					code: APIErrorCodes.CAST_OWNER_NOT_LINKED,
					message: 'This message has no author to attribute characters to.',
				});
			}
			const resolved = await resolveIcCharacterIds({
				guildId,
				senderId: authorId,
				characterIds: params.characterIds,
			});
			characterIds = resolved.characterIds;
		}

		const updated = await this.channelService.messages.persistence.setIcState({
			message: existing,
			ic: params.ic,
			castCharacterIds: characterIds,
		});
		// authorIsBot only affects the indexed authorType, which this toggle does not change;
		// false matches how the value is derived for a normal user message.
		void this.channelService.messages.search.indexMessage(updated, false);

		const access = await this.channelService.messages.retrieval.getResponseAccessContext({
			userId: params.userId,
			channelId: params.channelId,
			messageId: updated.id,
		});
		return this.responseDataService.buildMessage({userId: params.userId, message: updated, access});
	}
}

async function mapWithConcurrency<T, TResult>(
	items: ReadonlyArray<T>,
	concurrency: number,
	mapper: (item: T, index: number) => Promise<TResult>,
): Promise<Array<TResult>> {
	const results = new Array<TResult>(items.length);
	let nextIndex = 0;
	async function worker(): Promise<void> {
		for (;;) {
			const index = nextIndex++;
			if (index >= items.length) return;
			results[index] = await mapper(items[index], index);
		}
	}
	await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, () => worker()));
	return results;
}
