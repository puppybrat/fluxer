// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {http} from '@app/features/platform/transport/RestTransport';
import type {
	CastAllCharactersResponseType,
	CastCategoryResponseType,
	CastCharacterResponseType,
	CastMutationResponseType,
	CastPrimaryResponseType,
	CastResponseType,
} from '@fluxer/schema/src/domains/cast/CastSchemas';

export type CastCharacter = CastCharacterResponseType;
export type CastPrimary = CastPrimaryResponseType;
export type CastCategory = CastCategoryResponseType;
export type CastData = CastResponseType;
export type CastMutation = CastMutationResponseType;

export interface CastOverrideUpdate {
	nickname?: string | null;
	pfpUrl?: string | null;
}

async function requestGuildCast(guildId: string): Promise<CastData> {
	const response = await http.get<CastData>(Endpoints.GUILD_CAST(guildId));
	return response.body;
}

export async function getGuildCast(guildId: string): Promise<CastData> {
	return requestGuildCast(guildId);
}

/**
 * The full roster, not scoped to this guild's cast. The guild is still in the path because
 * the route authorizes against it — the caller needs MANAGE_GUILD somewhere to see this.
 */
export async function getAllCharacters(guildId: string): Promise<Array<CastCharacter>> {
	const response = await http.get<CastAllCharactersResponseType>(Endpoints.GUILD_CAST_ALL_CHARACTERS(guildId));
	return response.body.characters;
}

export async function addCharacter(guildId: string, characterId: string): Promise<CastMutation> {
	const response = await http.post<CastMutation>(Endpoints.GUILD_CAST_CHARACTER(guildId, characterId));
	return response.body;
}

export async function removeCharacter(guildId: string, characterId: string): Promise<CastMutation> {
	const response = await http.delete<CastMutation>(Endpoints.GUILD_CAST_CHARACTER(guildId, characterId));
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
	if (update.nickname !== undefined) {
		body.nickname = update.nickname;
	}
	if (update.pfpUrl !== undefined) {
		body.pfp_url = update.pfpUrl;
	}
	const response = await http.patch<CastMutation>(Endpoints.GUILD_CAST_CHARACTER(guildId, characterId), {body});
	return response.body;
}

export async function setPrimary(guildId: string, characterId: string, isPrimary: boolean): Promise<CastMutation> {
	const response = await http.patch<CastMutation>(Endpoints.GUILD_CAST_CHARACTER_PRIMARY(guildId, characterId), {
		body: {is_primary: isPrimary},
	});
	return response.body;
}
