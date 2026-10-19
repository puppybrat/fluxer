// SPDX-License-Identifier: AGPL-3.0-or-later

import {type ChannelID, createChannelID, type GuildID, type MessageID, type UserID} from '@app/api/BrandedTypes';
import {buildAncestorChain} from '@app/api/cast/CastResolution';
import type {ChannelRepository} from '@app/api/channel/ChannelRepository';
import type {MessageRequest, MessageUpdateRequest} from '@app/api/channel/MessageTypes';
import type {AuthenticatedChannel} from '@app/api/channel/services/AuthenticatedChannel';
import type {ChannelService} from '@app/api/channel/services/ChannelService';
import type {CrosspostSourceService} from '@app/api/channel/services/message/CrosspostSourceService';
import {dispatchMessageUpdateBroadcast} from '@app/api/channel/services/message/MessageGatewayDispatch';
import {resolveIcCharacterIds} from '@app/api/channel/services/message/MessageIcResolutionService';
import type {MessageResponseDataService} from '@app/api/channel/services/message/MessageResponseDataService';
import {carriesThreadArtifact, maskThreadArtifactsFor} from '@app/api/channel/services/message/ThreadMessageResponses';
import {isPersonalNotesChannelId} from '@app/api/channel/services/PersonalNotesChannelRepair';
import {isTainted, type ThreadViewer, viewerActive} from '@app/api/experiment/ChannelThreadsGate';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {User} from '@app/api/models/User';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {THREAD_FEATURE_CHANNEL_TYPES} from '@fluxer/constants/src/ThreadConstants';
import {InvalidChannelTypeError} from '@fluxer/errors/src/domains/channel/InvalidChannelTypeError';
import {UnclaimedAccountCannotSendMessagesError} from '@fluxer/errors/src/domains/channel/UnclaimedAccountCannotSendMessagesError';
import {UnknownMessageError} from '@fluxer/errors/src/domains/channel/UnknownMessageError';
import {BadRequestError} from '@fluxer/errors/src/domains/core/BadRequestError';
import {CannotExecuteOnDmError} from '@fluxer/errors/src/domains/core/CannotExecuteOnDmError';
import type {CrosspostSourceResponse} from '@fluxer/schema/src/domains/message/CrosspostSourceSchemas';
import type {
	BulkMessageFetchResponse,
	MessageChannelMentionResponse,
	MessageResponse,
} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';

function mentionsThreadChannel(mentions: ReadonlyArray<MessageChannelMentionResponse> | null | undefined): boolean {
	return mentions?.some((mention) => THREAD_FEATURE_CHANNEL_TYPES.has(mention.type)) ?? false;
}

function carriesMaskableThreadData(response: MessageResponse): boolean {
	if (carriesThreadArtifact(response) || mentionsThreadChannel(response.mention_channels)) return true;
	if (response.message_snapshots?.some((snapshot) => mentionsThreadChannel(snapshot.mention_channels))) return true;
	const referenced = response.referenced_message;
	return referenced != null && carriesMaskableThreadData(referenced);
}

export class MessageRequestService {
	constructor(
		private readonly channelService: ChannelService,
		private readonly responseDataService: MessageResponseDataService,
		private readonly crosspostSourceService: CrosspostSourceService,
		private readonly channelRepository: ChannelRepository,
		private readonly gatewayService: IGatewayService,
	) {}

	async listMessages(params: {
		userId: UserID;
		viewer: ThreadViewer;
		channelId: ChannelID;
		query: {
			limit: number;
			before?: MessageID;
			after?: MessageID;
			around?: MessageID;
		};
		requestCache: RequestCache;
	}): Promise<Array<MessageResponse>> {
		const retrieval = this.channelService.messages.retrieval;
		const {access, authChannel} = await retrieval.getResponseAccess({
			viewer: params.viewer,
			userId: params.userId,
			channelId: params.channelId,
		});
		if (authChannel.channel.isThreadOnly()) throw new InvalidChannelTypeError();
		const request = {
			userId: params.userId,
			channelId: params.channelId,
			limit: params.query.limit,
			before: params.query.before,
			after: params.query.after,
			around: params.query.around,
			access,
		};
		let responses = await this.responseDataService.listMessages(request);
		if (await this.needsThreadsMask(params.viewer, authChannel.channel.guildId, responses)) {
			responses = await this.responseDataService.listMessages({...request, threadsMask: true});
		}
		return retrieval.threadResponses.shape({
			viewer: params.viewer,
			userId: params.userId,
			authChannel,
			responses,
			requestCache: params.requestCache,
			query: params.query,
		});
	}

	private async needsThreadsMask(
		viewer: ThreadViewer,
		guildId: GuildID | null,
		responses: Array<MessageResponse>,
	): Promise<boolean> {
		if (guildId === null || viewerActive(viewer, guildId)) return false;
		if (!responses.some(carriesMaskableThreadData)) return false;
		return isTainted(guildId);
	}

	async listMessagesBulk(params: {
		userId: UserID;
		viewer: ThreadViewer;
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
				viewer: params.viewer,
				channelId: request.channelId,
				query: request.query,
				requestCache: params.requestCache,
			}),
		}));
		return {channels};
	}

	async getMessage(params: {
		userId: UserID;
		viewer: ThreadViewer;
		channelId: ChannelID;
		messageId: MessageID;
		requestCache: RequestCache;
	}): Promise<MessageResponse> {
		const retrieval = this.channelService.messages.retrieval;
		const {access, authChannel} = await retrieval.getResponseAccess({
			viewer: params.viewer,
			userId: params.userId,
			channelId: params.channelId,
			messageId: params.messageId,
		});
		const starter = await retrieval.threadResponses.getStarter({
			viewer: params.viewer,
			userId: params.userId,
			authChannel,
			messageId: params.messageId,
			requestCache: params.requestCache,
		});
		if (starter) return starter;
		const request = {
			userId: params.userId,
			channelId: params.channelId,
			messageId: params.messageId,
			access,
		};
		let response = await this.responseDataService.getMessage(request);
		if (response !== null && (await this.needsThreadsMask(params.viewer, authChannel.channel.guildId, [response]))) {
			response = await this.responseDataService.getMessage({...request, threadsMask: true});
		}
		if (response === null) {
			throw new UnknownMessageError();
		}
		const [shaped] = await retrieval.threadResponses.shape({
			viewer: params.viewer,
			userId: params.userId,
			authChannel,
			responses: [response],
			requestCache: params.requestCache,
		});
		if (!shaped) {
			throw new UnknownMessageError();
		}
		return shaped;
	}

	async getCrosspostSource(params: {
		userId: UserID;
		viewer: ThreadViewer;
		channelId: ChannelID;
		messageId: MessageID;
		requestCache: RequestCache;
	}): Promise<CrosspostSourceResponse> {
		const message = await this.getMessage(params);
		return this.crosspostSourceService.getSource(message);
	}

	async sendMessage(params: {
		user: User;
		viewer: ThreadViewer;
		channelId: ChannelID;
		data: MessageRequest;
		requestCache: RequestCache;
	}): Promise<MessageResponse> {
		if (
			params.user.isUnclaimedAccount() &&
			!isPersonalNotesChannelId({userId: params.user.id, channelId: params.channelId})
		) {
			throw new UnclaimedAccountCannotSendMessagesError();
		}
		const {message, authChannel} = await this.channelService.messages.send.sendMessage({
			viewer: params.viewer,
			user: params.user,
			channelId: params.channelId,
			data: params.data,
			requestCache: params.requestCache,
		});
		const access = await this.channelService.messages.retrieval.getResponseAccessContext({
			viewer: params.viewer,
			userId: params.user.id,
			channelId: params.channelId,
			authChannel,
		});
		const response = await this.responseDataService.buildMessage({
			userId: params.user.id,
			message,
			access: {...access, messageHistoryCutoff: null, canReadMessageHistory: true},
			nonce: params.data.nonce,
			tts: params.data.tts ?? false,
		});
		const [shaped] = maskThreadArtifactsFor(params.viewer, authChannel.channel.guildId, [response]);
		return shaped ?? response;
	}

	async crosspostMessage(params: {
		userId: UserID;
		viewer: ThreadViewer;
		channelId: ChannelID;
		messageId: MessageID;
		requestCache: RequestCache;
	}): Promise<MessageResponse> {
		const {message, authChannel} = await this.channelService.messages.crosspost.crosspostMessage(params);
		const retrieval = this.channelService.messages.retrieval;
		const access = await retrieval.getResponseAccessContext({
			viewer: params.viewer,
			userId: params.userId,
			channelId: params.channelId,
			messageId: message.id,
			authChannel,
		});
		const response = await this.responseDataService.buildMessage({
			userId: params.userId,
			message,
			access,
		});
		const [shaped] = await retrieval.threadResponses.shape({
			viewer: params.viewer,
			userId: params.userId,
			authChannel,
			responses: [response],
			requestCache: params.requestCache,
		});
		return shaped ?? response;
	}

	async validateForumStarter(params: {
		user: User;
		parentAuth: AuthenticatedChannel;
		data: MessageRequest;
	}): Promise<void> {
		if (params.user.isUnclaimedAccount()) throw new UnclaimedAccountCannotSendMessagesError();
		await this.channelService.messages.send.validateForumStarter(params);
	}

	async sendForumStarter(params: {
		user: User;
		viewer: ThreadViewer;
		parentAuth: AuthenticatedChannel;
		threadId: ChannelID;
		data: MessageRequest;
		requestCache: RequestCache;
	}): Promise<MessageResponse> {
		if (params.user.isUnclaimedAccount()) throw new UnclaimedAccountCannotSendMessagesError();
		const {message, authChannel} = await this.channelService.messages.send.sendMessage({
			viewer: params.viewer,
			user: params.user,
			channelId: params.threadId,
			data: params.data,
			requestCache: params.requestCache,
			forumStarter: {parentAuth: params.parentAuth},
		});
		const access = await this.channelService.messages.retrieval.getResponseAccessContext({
			viewer: params.viewer,
			userId: params.user.id,
			channelId: params.threadId,
			authChannel,
		});
		return this.responseDataService.buildMessage({
			userId: params.user.id,
			message,
			access: {...access, messageHistoryCutoff: null, canReadMessageHistory: true},
		});
	}

	async editMessage(params: {
		userId: UserID;
		viewer: ThreadViewer;
		channelId: ChannelID;
		messageId: MessageID;
		data: MessageUpdateRequest;
		requestCache: RequestCache;
	}): Promise<MessageResponse> {
		const {message, authChannel} = await this.channelService.messages.edit.editMessage({
			viewer: params.viewer,
			userId: params.userId,
			channelId: params.channelId,
			messageId: params.messageId,
			data: params.data,
			requestCache: params.requestCache,
		});
		const access = await this.channelService.messages.retrieval.getResponseAccessContext({
			viewer: params.viewer,
			userId: params.userId,
			channelId: params.channelId,
			messageId: message.id,
			authChannel,
		});
		const response = await this.responseDataService.buildMessage({
			userId: params.userId,
			message,
			access,
		});
		const [shaped] = maskThreadArtifactsFor(params.viewer, authChannel.channel.guildId, [response]);
		return shaped ?? response;
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
		viewer: ThreadViewer;
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
			viewer: params.viewer,
		});
		const guildId = authChannel.channel.guildId;
		if (!guildId) {
			// Cast membership is per-guild, so a DM has no owner mapping to resolve against.
			throw new CannotExecuteOnDmError();
		}
		const existing = await this.channelService.messages.retrieval.getMessage({
			userId: params.userId,
			viewer: params.viewer,
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
			const ancestorChain = await buildAncestorChain(
				authChannel.channel.parentId ? authChannel.channel.parentId.toString() : null,
				async (channelId) => {
					const ancestor = await this.channelRepository.channelData.findUnique(createChannelID(BigInt(channelId)));
					return ancestor?.parentId ? ancestor.parentId.toString() : null;
				},
			);
			const resolved = await resolveIcCharacterIds({
				guildId,
				senderId: authorId,
				channelId: params.channelId.toString(),
				ancestorChain,
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

		// Broadcast the same MESSAGE_UPDATE an edit emits, so connected clients reflect the
		// in-character change live rather than only on a manual refresh. Without this the toggle
		// is a local-only view for whoever pressed it.
		await dispatchMessageUpdateBroadcast({
			gatewayService: this.gatewayService,
			channel: authChannel.channel,
			message: updated,
		});

		const access = await this.channelService.messages.retrieval.getResponseAccessContext({
			viewer: params.viewer,
			userId: params.userId,
			channelId: params.channelId,
			messageId: updated.id,
			authChannel,
		});
		const response = await this.responseDataService.buildMessage({userId: params.userId, message: updated, access});
		const [shaped] = maskThreadArtifactsFor(params.viewer, guildId, [response]);
		return shaped ?? response;
	}
}
