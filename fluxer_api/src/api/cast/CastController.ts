// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {BadGatewayError} from '@fluxer/errors/src/domains/core/BadGatewayError';
import {BadRequestError} from '@fluxer/errors/src/domains/core/BadRequestError';
import {
	CastMutationResponse,
	CastOverrideUpdateRequest,
	CastResponse,
} from '@fluxer/schema/src/domains/cast/CastSchemas';
import {GuildIdCastCharacterIdParam, GuildIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import type {CastFetchFailure, CastPayload} from '@pkgs/cast_client/src/CastClient';
import {getCastClient} from '@pkgs/cast_client/src/CastClient';
import type {GuildID, UserID} from '../BrandedTypes';
import {createGuildID} from '../BrandedTypes';
import {Logger} from '../Logger';
import {LoginRequired} from '../middleware/AuthMiddleware';

import {RateLimitMiddleware} from '../middleware/RateLimitMiddleware';
import {OpenAPI} from '../middleware/ResponseTypeMiddleware';
import {RateLimitConfigs} from '../RateLimitConfig';
import type {HonoApp} from '../types/HonoEnv';
import {Validator} from '../Validator';

function toStringOrNull(value: string | number | null | undefined): string | null {
	return value == null ? null : String(value);
}

function toBoolean(value: boolean | number | string | null | undefined): boolean {
	if (typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'number') {
		return value !== 0;
	}
	if (typeof value === 'string') {
		return value === '1' || value.toLowerCase() === 'true';
	}
	return false;
}

/**
 * Projects the external payload onto the trimmed shape Fluxer exposes. Anything not named
 * here is dropped on purpose — see CastSchemas for why.
 */
function toCastResponse(payload: CastPayload) {
	return {
		characters: payload.characters.map((character) => ({
			id: String(character.id),
			name: character.name ?? null,
			alias: character.alias ?? null,
			ship: character.ship ?? null,
		})),
		primaries: payload.primaries.map((primary) => ({
			character_id: String(primary.character_id),
			channel_id: toStringOrNull(primary.channel_id),
			is_primary: toBoolean(primary.is_primary),
		})),
		categories: payload.categories.map((category) => ({
			pair_slug: category.pair_slug ?? null,
			au_slug: category.au_slug ?? null,
			category_id: String(category.category_id ?? ''),
		})),
	};
}

const EMPTY_CAST_RESPONSE = {characters: [], primaries: [], categories: []};

interface GuildWriteAuth {
	checkPermission: (permission: bigint) => Promise<void>;
}

/**
 * Authorizes a cast write.
 *
 * The read route gates on guild membership alone; writes additionally require MANAGE_GUILD,
 * so an ordinary member cannot mutate data that lives on the personal site. Both checks run
 * before the external call — an unauthorized request must never reach the origin.
 */
async function authorizeCastWrite(
	guildService: {getGuildAuthenticated: (args: {userId: UserID; guildId: GuildID}) => Promise<GuildWriteAuth>},
	userId: UserID,
	guildId: GuildID,
): Promise<void> {
	const {checkPermission} = await guildService.getGuildAuthenticated({userId, guildId});
	await checkPermission(Permissions.MANAGE_GUILD);
}

/**
 * Maps a client failure onto an HTTP response. `not_configured` is a 502 here rather than
 * the read route's empty-shape fallback: silently reporting success for a write that never
 * happened would be a lie, whereas an empty read is merely uninformative.
 */
function throwCastWriteFailure(guildId: GuildID, failure: CastFetchFailure): never {
	Logger.warn({guild_id: guildId.toString(), failure}, 'Cast write failed');
	if (failure.kind === 'http_status' && failure.status >= 400 && failure.status < 500) {
		throw new BadRequestError({
			code: APIErrorCodes.INVALID_REQUEST,
			message: failure.message ?? 'The cast service rejected this request',
		});
	}
	throw new BadGatewayError();
}

export function CastController(app: HonoApp) {
	app.get(
		'/guilds/:guild_id/cast',
		RateLimitMiddleware(RateLimitConfigs.GUILD_CAST_GET),
		LoginRequired,
		Validator('param', GuildIdParam),
		OpenAPI({
			operationId: 'get_guild_cast',
			summary: 'Get guild cast',
			responseSchema: CastResponse,
			statusCode: 200,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: ['Guilds'],
			description:
				'Get the cast characters, primary assignments and category mappings for a guild. Returns empty arrays when the guild has no cast configured.',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const guildId = createGuildID(ctx.req.valid('param').guild_id);

			// Gate on guild access before touching the external service: cast data must never
			// be readable by an authenticated user who is not in the guild.
			await ctx.get('guildService').getGuildAuthenticated({userId, guildId});

			const result = await getCastClient().fetchForServer(guildId.toString());
			if (result.ok) {
				return ctx.json(toCastResponse(result.data));
			}

			// A deployment with no cast endpoint configured is a normal state, not an error:
			// the feature simply does not apply, so serve the same empty shape as an unmapped guild.
			if (result.failure.kind === 'not_configured') {
				return ctx.json(EMPTY_CAST_RESPONSE);
			}

			Logger.warn({guild_id: guildId.toString(), failure: result.failure}, 'Cast lookup failed');
			throw new BadGatewayError();
		},
	);

	app.post(
		'/guilds/:guild_id/cast/characters/:character_id',
		RateLimitMiddleware(RateLimitConfigs.GUILD_CAST_ADD),
		LoginRequired,
		Validator('param', GuildIdCastCharacterIdParam),
		OpenAPI({
			operationId: 'add_guild_cast_character',
			summary: 'Add cast character',
			responseSchema: CastMutationResponse,
			statusCode: 200,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: ['Guilds'],
			description:
				'Add a character to the guild cast. The character ID is the personal site character ID, not a Fluxer snowflake. Requires the MANAGE_GUILD permission.',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const {guild_id, character_id} = ctx.req.valid('param');
			const guildId = createGuildID(guild_id);

			await authorizeCastWrite(ctx.get('guildService'), userId, guildId);

			const result = await getCastClient().addToCast(guildId.toString(), character_id);
			if (!result.ok) {
				throwCastWriteFailure(guildId, result.failure);
			}
			return ctx.json({success: true, character_id: String(character_id), override: null});
		},
	);

	app.delete(
		'/guilds/:guild_id/cast/characters/:character_id',
		RateLimitMiddleware(RateLimitConfigs.GUILD_CAST_REMOVE),
		LoginRequired,
		Validator('param', GuildIdCastCharacterIdParam),
		OpenAPI({
			operationId: 'remove_guild_cast_character',
			summary: 'Remove cast character',
			responseSchema: CastMutationResponse,
			statusCode: 200,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: ['Guilds'],
			description:
				'Remove a character from the guild cast. The character ID is the personal site character ID, not a Fluxer snowflake. Requires the MANAGE_GUILD permission.',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const {guild_id, character_id} = ctx.req.valid('param');
			const guildId = createGuildID(guild_id);

			await authorizeCastWrite(ctx.get('guildService'), userId, guildId);

			const result = await getCastClient().removeFromCast(guildId.toString(), character_id);
			if (!result.ok) {
				throwCastWriteFailure(guildId, result.failure);
			}
			return ctx.json({success: true, character_id: String(character_id), override: null});
		},
	);

	app.patch(
		'/guilds/:guild_id/cast/characters/:character_id',
		RateLimitMiddleware(RateLimitConfigs.GUILD_CAST_UPDATE),
		LoginRequired,
		Validator('param', GuildIdCastCharacterIdParam),
		Validator('json', CastOverrideUpdateRequest),
		OpenAPI({
			operationId: 'update_guild_cast_character',
			summary: 'Update cast character override',
			responseSchema: CastMutationResponse,
			statusCode: 200,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: ['Guilds'],
			description:
				'Update the per-guild nickname and avatar override for a cast character. The character ID is the personal site character ID, not a Fluxer snowflake. Requires the MANAGE_GUILD permission.',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const {guild_id, character_id} = ctx.req.valid('param');
			const {nickname, pfp_url} = ctx.req.valid('json');
			const guildId = createGuildID(guild_id);

			await authorizeCastWrite(ctx.get('guildService'), userId, guildId);

			const result = await getCastClient().updateOverride(guildId.toString(), character_id, {
				nickname,
				pfpUrl: pfp_url,
			});
			if (!result.ok) {
				throwCastWriteFailure(guildId, result.failure);
			}
			return ctx.json({
				success: true,
				character_id: String(character_id),
				override: result.override
					? {
							character_id: String(character_id),
							nickname: result.override.nickname,
							pfp_url: result.override.pfpUrl,
						}
					: null,
			});
		},
	);
}
