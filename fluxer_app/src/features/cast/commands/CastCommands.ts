// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {http} from '@app/features/platform/transport/RestTransport';
import type {
	CastCategoryResponseType,
	CastCharacterResponseType,
	CastPrimaryResponseType,
	CastResponseType,
} from '@fluxer/schema/src/domains/cast/CastSchemas';

export type CastCharacter = CastCharacterResponseType;
export type CastPrimary = CastPrimaryResponseType;
export type CastCategory = CastCategoryResponseType;
export type CastData = CastResponseType;

async function requestGuildCast(guildId: string): Promise<CastData> {
	const response = await http.get<CastData>(Endpoints.GUILD_CAST(guildId));
	return response.body;
}

export async function getGuildCast(guildId: string): Promise<CastData> {
	return requestGuildCast(guildId);
}
