// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import Channels from '@app/features/channel/state/Channels';
import Invites from '@app/features/invite/state/Invites';
import {http} from '@app/features/platform/transport/RestTransport';
import {Logger} from '@app/features/platform/utils/AppLogger';
import Slowmode from '@app/features/slowmode/state/Slowmode';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import type {Channel, ChannelSlowmodeStateResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import type {Invite} from '@fluxer/schema/src/domains/invite/InviteSchemas';

const logger = new Logger('Channels');

export interface ChannelRtcRegion {
	id: string;
	name: string;
	emoji: string;
}

type ChannelCreateParams = Pick<
	Channel,
	'name' | 'url' | 'type' | 'parent_id' | 'bitrate' | 'user_limit' | 'voice_connection_limit'
> & {
	permission_overwrites?: Array<PermissionOverwritePatch>;
};
type ChannelUpdateParams = Partial<
	Pick<
		Channel,
		| 'name'
		| 'topic'
		| 'url'
		| 'nsfw'
		| 'nsfw_override'
		| 'content_warning_level'
		| 'content_warning_text'
		| 'bitrate'
		| 'user_limit'
		| 'voice_connection_limit'
		| 'icon'
		| 'owner_id'
		| 'rtc_region'
	>
>;

interface PermissionOverwritePatch {
	id: string;
	type: 0 | 1;
	allow: string;
	deny: string;
}

async function requestChannelCreate(guildId: string, params: ChannelCreateParams): Promise<Channel> {
	const response = await http.post<Channel>(Endpoints.GUILD_CHANNELS(guildId), {body: params});
	return response.body;
}

async function requestChannelPatch(
	channelId: string,
	body: ChannelUpdateParams | Record<string, unknown>,
): Promise<Channel> {
	const response = await http.patch<Channel>(Endpoints.CHANNEL(channelId), {body});
	return response.body;
}

function isPrivateChannel(channelId: string): boolean {
	const channel = Channels.getChannel(channelId);
	return (
		channel != null && !channel.guildId && (channel.type === ChannelTypes.DM || channel.type === ChannelTypes.GROUP_DM)
	);
}

function shouldOptimisticallyRemove(channelId: string, options?: RemoveChannelOptions): boolean {
	return options?.optimistic ?? isPrivateChannel(channelId);
}

function deleteChannelQuery(
	silent?: boolean,
	deleteMessages?: boolean,
): {silent?: true; delete_messages?: true} | undefined {
	if (!silent && !deleteMessages) return undefined;
	const query: {silent?: true; delete_messages?: true} = {};
	if (silent) query.silent = true;
	if (deleteMessages) query.delete_messages = true;
	return query;
}

function syncSlowmodeTimestamp(channelId: string, data: ChannelSlowmodeStateResponse): void {
	const {rate_limit_per_user, retry_after_ms, can_bypass} = data;
	if (rate_limit_per_user <= 0 || can_bypass) {
		Slowmode.clearChannel(channelId);
		return;
	}
	if (retry_after_ms <= 0) {
		Slowmode.clearChannel(channelId);
		return;
	}
	Slowmode.updateSlowmodeRemaining(channelId, retry_after_ms);
}

async function requestSlowmodeState(channelId: string): Promise<ChannelSlowmodeStateResponse | null> {
	const response = await http.get<ChannelSlowmodeStateResponse>(Endpoints.CHANNEL_SLOWMODE(channelId));
	const data = response.body;
	if (!data) return null;
	syncSlowmodeTimestamp(channelId, data);
	return data;
}

export async function create(guildId: string, params: ChannelCreateParams): Promise<Channel> {
	try {
		return await requestChannelCreate(guildId, params);
	} catch (error) {
		logger.error('Failed to create channel:', error);
		throw error;
	}
}

export async function update(channelId: string, params: ChannelUpdateParams): Promise<Channel> {
	try {
		return await requestChannelPatch(channelId, params);
	} catch (error) {
		logger.error(`Failed to update channel ${channelId}:`, error);
		throw error;
	}
}

export async function updateGroupDMNickname(
	channelId: string,
	userId: string,
	nickname: string | null,
): Promise<Channel> {
	try {
		return await requestChannelPatch(channelId, {
			nicks: {
				[userId]: nickname,
			},
		});
	} catch (error) {
		logger.error(`Failed to update nickname for user ${userId} in channel ${channelId}:`, error);
		throw error;
	}
}

export interface RemoveChannelOptions {
	optimistic?: boolean;
}

export async function remove(
	channelId: string,
	silent?: boolean,
	options?: RemoveChannelOptions & {deleteMessages?: boolean},
): Promise<void> {
	const removeOptimistically = shouldOptimisticallyRemove(channelId, options);
	if (removeOptimistically) {
		Channels.removeChannelOptimistically(channelId);
	}
	try {
		await http.delete(Endpoints.CHANNEL(channelId), {
			query: deleteChannelQuery(silent, options?.deleteMessages),
		});
		if (removeOptimistically) {
			Channels.clearOptimisticallyRemovedChannel(channelId);
		}
	} catch (error) {
		if (removeOptimistically) {
			Channels.rollbackChannelDeletion(channelId);
		}
		logger.error(`Failed to delete channel ${channelId}:`, error);
		throw error;
	}
}

export async function bulkDeleteMyMessages(channelId: string): Promise<void> {
	try {
		await http.post(Endpoints.CHANNEL_BULK_DELETE_MY_MESSAGES(channelId), {body: {}});
		logger.debug(`Deleted caller's messages in channel ${channelId}`);
	} catch (error) {
		logger.error(`Failed to delete caller's messages in channel ${channelId}:`, error);
		throw error;
	}
}

export async function updatePermissionOverwrites(
	channelId: string,
	permissionOverwrites: Array<PermissionOverwritePatch>,
): Promise<Channel> {
	try {
		return await requestChannelPatch(channelId, {permission_overwrites: permissionOverwrites});
	} catch (error) {
		logger.error(`Failed to update permission overwrites for channel ${channelId}:`, error);
		throw error;
	}
}

export async function fetchChannelInvites(channelId: string): Promise<Array<Invite>> {
	try {
		Invites.handleChannelInvitesFetchPending(channelId);
		const response = await http.get<Array<Invite>>(Endpoints.CHANNEL_INVITES(channelId));
		const data = response.body ?? [];
		Invites.handleChannelInvitesFetchSuccess(channelId, data);
		return data;
	} catch (error) {
		logger.error(`Failed to fetch invites for channel ${channelId}:`, error);
		Invites.handleChannelInvitesFetchError(channelId);
		throw error;
	}
}

const inFlightSlowmodeFetches = new Map<string, Promise<ChannelSlowmodeStateResponse | null>>();

export function fetchSlowmodeState(channelId: string): Promise<ChannelSlowmodeStateResponse | null> {
	const existing = inFlightSlowmodeFetches.get(channelId);
	if (existing) return existing;
	const promise = (async () => {
		try {
			return await requestSlowmodeState(channelId);
		} catch (error) {
			logger.error(`Failed to fetch slowmode state for channel ${channelId}:`, error);
			return null;
		} finally {
			inFlightSlowmodeFetches.delete(channelId);
		}
	})();
	inFlightSlowmodeFetches.set(channelId, promise);
	return promise;
}

export async function fetchRtcRegions(channelId: string): Promise<Array<ChannelRtcRegion>> {
	try {
		const response = await http.get<Array<ChannelRtcRegion>>(Endpoints.CHANNEL_RTC_REGIONS(channelId));
		return response.body ?? [];
	} catch (error) {
		logger.error(`Failed to fetch RTC regions for channel ${channelId}:`, error);
		throw error;
	}
}

/*
 * LOCAL-ONLY: channel theme commands. Thin wrappers over the local-only /themes and
 * /channels/:id/appearance routes (fluxer_api ChannelThemeController). Exclude from upstream sync.
 */

/** A named theme in the shared library. `updated_at` is an ISO string, as the API serializes it. */
export interface ChannelThemeResponse {
	id: string;
	name: string;
	css: string;
	updated_at: string;
}

/** A channel's active state, with the referenced theme already resolved by the server. */
export interface ChannelAppearanceResponse {
	channel_id: string;
	theme_id: string | null;
	theme_name: string | null;
	css: string | null;
	resolved_css: string | null;
	updated_at: string | null;
}

/** The write routes return the raw state row, without the join. */
export interface ChannelAppearanceStateResponse {
	channel_id: string;
	theme_id: string | null;
	css: string | null;
	updated_at: string;
}

export async function fetchChannelThemes(): Promise<Array<ChannelThemeResponse>> {
	const response = await http.get<Array<ChannelThemeResponse>>(Endpoints.CHANNEL_THEMES);
	return response.body ?? [];
}

export async function fetchChannelAppearance(channelId: string): Promise<ChannelAppearanceResponse> {
	const response = await http.get<ChannelAppearanceResponse>(Endpoints.CHANNEL_APPEARANCE(channelId));
	return response.body;
}

export async function createChannelTheme(name: string, css: string): Promise<ChannelThemeResponse> {
	const response = await http.post<ChannelThemeResponse>(Endpoints.CHANNEL_THEMES, {body: {name, css}});
	return response.body;
}

export async function updateChannelTheme(
	themeId: string,
	fields: {name?: string; css?: string},
): Promise<ChannelThemeResponse> {
	const response = await http.put<ChannelThemeResponse>(Endpoints.CHANNEL_THEME(themeId), {body: fields});
	return response.body;
}

export async function applyChannelTheme(channelId: string, themeId: string): Promise<ChannelAppearanceStateResponse> {
	const response = await http.post<ChannelAppearanceStateResponse>(
		Endpoints.CHANNEL_APPEARANCE_APPLY_THEME(channelId),
		{body: {theme_id: themeId}},
	);
	return response.body;
}

export async function saveAndApplyChannelCss(channelId: string, css: string): Promise<ChannelAppearanceStateResponse> {
	const response = await http.post<ChannelAppearanceStateResponse>(
		Endpoints.CHANNEL_APPEARANCE_SAVE_AND_APPLY(channelId),
		{body: {css}},
	);
	return response.body;
}

export async function clearChannelAppearance(channelId: string): Promise<void> {
	await http.delete(Endpoints.CHANNEL_APPEARANCE(channelId));
}

export async function deleteChannelTheme(themeId: string): Promise<void> {
	await http.delete(Endpoints.CHANNEL_THEME(themeId));
}
