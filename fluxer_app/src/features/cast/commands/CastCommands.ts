// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {http} from '@app/features/platform/transport/RestTransport';
import type {
	CastAllCharactersResponseType,
	CastCategoryResponseType,
	CastCharacterResponseType,
	CastMutationResponseType,
	CastOverrideRowResponseType,
	CastOwnerAccountResponseType,
	CastOwnerAccountsResponseType,
	CastPrimaryResponseType,
	CastResponseType,
} from '@fluxer/schema/src/domains/cast/CastSchemas';

export type CastCharacter = CastCharacterResponseType;
export type CastPrimary = CastPrimaryResponseType;
export type CastCategory = CastCategoryResponseType;
/** A raw per-scope override row (server/category/channel), as delivered for the resolution walk. */
export type CastOverrideRow = CastOverrideRowResponseType;
export type CastData = CastResponseType;
export type CastMutation = CastMutationResponseType;
export type CastOwnerAccount = CastOwnerAccountResponseType;

export interface CastOverrideUpdate {
	channelId?: string | null;
	nickname?: string | null;
	pfpUrl?: string | null;
	referenceImageUrl?: string | null;
	excluded?: boolean | null;
}

/**
 * `channelId` scopes the read: omitted (or null) is the server-wide view, a value asks for the
 * effective cast resolved for that channel — the response then also carries `resolved_cast`. The
 * raw `primaries`/`overrides` arrays stay unfiltered (every scope) either way, so a scoped caller
 * can still tell which rows are decided locally at that channel.
 */
async function requestGuildCast(guildId: string, channelId?: string | null): Promise<CastData> {
	const response = await http.get<CastData>(Endpoints.GUILD_CAST(guildId), {
		query: {channel_id: channelId ?? undefined},
	});
	return response.body;
}

export async function getGuildCast(guildId: string, channelId?: string | null): Promise<CastData> {
	return requestGuildCast(guildId, channelId);
}

/**
 * The full roster, not scoped to this guild's cast. The guild is still in the path because
 * the route authorizes against it — the caller needs MANAGE_GUILD somewhere to see this.
 */
export async function getAllCharacters(guildId: string): Promise<Array<CastCharacter>> {
	const response = await http.get<CastAllCharactersResponseType>(Endpoints.GUILD_CAST_ALL_CHARACTERS(guildId));
	return response.body.characters;
}

/**
 * Maps each personal-site owner index onto the Fluxer account that owns it. The guild is only the
 * authorization context — this route requires MANAGE_GUILD, so a caller without it gets a 403.
 */
export async function getOwnerAccounts(guildId: string): Promise<Array<CastOwnerAccount>> {
	const response = await http.get<CastOwnerAccountsResponseType>(Endpoints.GUILD_CAST_OWNER_ACCOUNTS(guildId));
	return response.body.owner_accounts;
}

/**
 * The characters a given Fluxer user owns in this guild's cast, for the "Manage characters" picker.
 * Mirrors the server's ownership check (MessageIcResolutionService): map the user to an owner index
 * via owner-accounts, then take this guild's cast characters belonging to that owner. Unlike
 * resolvePrimaryCharacterIds, this returns ALL owned characters (not just primaries), since the
 * picker lets the user attribute any of their own characters. Name/avatar precedence matches
 * GuildCastDisplay. Returns empty when the user has no owner mapping. Requires MANAGE_GUILD (the
 * owner-accounts route is gated), matching the existing IC toggle's visibility.
 */
export async function getOwnedCharacters(
	guildId: string,
	fluxerUserId: string,
): Promise<Array<{id: string; name: string; avatarUrl: string | null}>> {
	const [ownerAccounts, cast] = await Promise.all([getOwnerAccounts(guildId), getGuildCast(guildId)]);
	const ownerAccount = ownerAccounts.find((account) => account.fluxer_user_id === fluxerUserId);
	if (!ownerAccount) {
		return [];
	}
	return cast.characters
		.filter((character) => character.owner === ownerAccount.owner_index)
		.map((character) => ({
			id: character.id,
			name: character.nickname ?? character.name ?? character.id,
			avatarUrl: character.pfp_url ?? null,
		}));
}

/**
 * `channelId` scopes the membership: omitted (or null) adds server-wide, a value adds only at that
 * category/channel scope. A scoped add is what gives a character a local presence row there, which
 * both an explicit local override and (per the backend) any per-scope override then require.
 */
export async function addCharacter(
	guildId: string,
	characterId: string,
	channelId?: string | null,
): Promise<CastMutation> {
	const response = await http.post<CastMutation>(Endpoints.GUILD_CAST_CHARACTER(guildId, characterId), {
		query: {channel_id: channelId ?? undefined},
	});
	return response.body;
}

/**
 * `channelId` scopes the removal: omitted (or null) removes the server-wide membership, a value
 * removes only that scope's row. The backend cascades — removing a scope's membership also drops
 * that scope's override row — so this is the single call behind both "remove locally" and "un-hide".
 */
export async function removeCharacter(
	guildId: string,
	characterId: string,
	channelId?: string | null,
): Promise<CastMutation> {
	const response = await http.delete<CastMutation>(Endpoints.GUILD_CAST_CHARACTER(guildId, characterId), {
		query: {channel_id: channelId ?? undefined},
	});
	return response.body;
}

/**
 * Fields left undefined are omitted from the body entirely, preserving the backend's
 * distinction between "not supplied" and "explicitly cleared to null".
 */
export async function updateOverride(
	guildId: string,
	characterId: string,
	update: CastOverrideUpdate,
): Promise<CastMutation> {
	const body: Record<string, unknown> = {};
	if (update.channelId !== undefined) {
		body.channel_id = update.channelId;
	}
	if (update.nickname !== undefined) {
		body.nickname = update.nickname;
	}
	if (update.pfpUrl !== undefined) {
		body.pfp_url = update.pfpUrl;
	}
	if (update.referenceImageUrl !== undefined) {
		body.reference_image_url = update.referenceImageUrl;
	}
	if (update.excluded !== undefined) {
		body.excluded = update.excluded;
	}
	const response = await http.patch<CastMutation>(Endpoints.GUILD_CAST_CHARACTER(guildId, characterId), {body});
	return response.body;
}

/**
 * `channelId` scopes the primary flag: omitted leaves the body's channel_id out entirely (server
 * scope, unchanged behaviour for the guild tab), a value sets it for that scope. The character must
 * already be in the cast at the scope, matching the backend's constraint.
 */
export async function setPrimary(
	guildId: string,
	characterId: string,
	isPrimary: boolean,
	channelId?: string | null,
): Promise<CastMutation> {
	const body: Record<string, unknown> = {is_primary: isPrimary};
	if (channelId !== undefined) {
		body.channel_id = channelId;
	}
	const response = await http.patch<CastMutation>(Endpoints.GUILD_CAST_CHARACTER_PRIMARY(guildId, characterId), {
		body,
	});
	return response.body;
}
