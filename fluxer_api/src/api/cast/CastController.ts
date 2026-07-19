// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {BadGatewayError} from '@fluxer/errors/src/domains/core/BadGatewayError';
import {BadRequestError} from '@fluxer/errors/src/domains/core/BadRequestError';
import {
	CastAllCharactersResponse,
	CastMutationResponse,
	CastOverrideUpdateRequest,
	CastResponse,
	CastSetPrimaryRequest,
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
/**
 * Normalises an override field to null. The personal site clears by writing null, but an
 * empty string is equally "unset" from a display perspective — collapsing both here means
 * clients can test one condition instead of two.
 */
function toOverrideValue(value: string | null | undefined): string | null {
	if (value == null) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed === '' ? null : trimmed;
}

function toCastResponse(payload: CastPayload) {
	// Server-scoped rows only: channel_id is always null today, and taking a channel-scoped
	// row here would attribute a narrower override to the whole guild.
	const overridesByCharacterId = new Map<string, {nickname: string | null; pfp_url: string | null}>();
	for (const override of payload.cast_overrides) {
		if (override.channel_id != null) {
			continue;
		}
		overridesByCharacterId.set(String(override.character_id), {
			nickname: toOverrideValue(override.nickname),
			pfp_url: toOverrideValue(override.pfp_url),
		});
	}

	return {
		characters: payload.characters.map((character) => {
			const override = overridesByCharacterId.get(String(character.id));
			return {
				id: String(character.id),
				name: character.name ?? null,
				alias: character.alias ?? null,
				ship: character.ship ?? null,
				nickname: override?.nickname ?? null,
				pfp_url: override?.pfp_url ?? null,
			};
		}),
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

	// Path is a sibling of /cast/characters/:character_id, not a literal segment underneath it.
	// `/cast/characters/all` would sit exactly where a parameterized route already matches, and
	// a later GET on :character_id would shadow it — the failure this codebase has already hit
	// once (see RelocateMessagesController's registration order). Avoided by construction here
	// rather than by depending on registration order staying correct.
	app.get(
		'/guilds/:guild_id/cast/all-characters',
		RateLimitMiddleware(RateLimitConfigs.GUILD_CAST_LIST_ALL),
		LoginRequired,
		Validator('param', GuildIdParam),
		OpenAPI({
			operationId: 'list_all_cast_characters',
			summary: 'List all cast characters',
			responseSchema: CastAllCharactersResponse,
			statusCode: 200,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: ['Guilds'],
			description:
				'List every character available on the personal site, regardless of whether it is in this guild cast. Intended for pickers that need to offer characters not yet added. Requires the MANAGE_GUILD permission.',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const guildId = createGuildID(ctx.req.valid('param').guild_id);

			// Gated as a write despite being a read: this exposes the whole roster rather than
			// anything scoped to the guild, and reusing the existing gate avoids inventing a
			// third permission concept for one route.
			await authorizeCastWrite(ctx.get('guildService'), userId, guildId);

			const result = await getCastClient().listAllCharacters();
			if (!result.ok) {
				if (result.failure.kind === 'not_configured') {
					return ctx.json({characters: []});
				}
				Logger.warn({guild_id: guildId.toString(), failure: result.failure}, 'Cast character listing failed');
				throw new BadGatewayError();
			}

			return ctx.json({
				// Always null here: this listing is not guild-scoped, so there is no guild whose
				// override could apply. The picker shows real names, which is what it should.
				characters: result.data.characters.map((character) => ({
					id: String(character.id),
					name: character.name ?? null,
					alias: character.alias ?? null,
					ship: character.ship ?? null,
					nickname: null,
					pfp_url: null,
				})),
			});
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

	// Kept separate from the override PATCH above rather than folded in as another body field:
	// the two write to different upstream actions, so combining them would make one request
	// fan out to two calls that can half-fail. Primary status also has a precondition the
	// override does not — the character must already be in the cast — and the endpoint answers
	// 409 when it is not, which maps here to the same 4xx passthrough as any other rejection.
	app.patch(
		'/guilds/:guild_id/cast/characters/:character_id/primary',
		RateLimitMiddleware(RateLimitConfigs.GUILD_CAST_SET_PRIMARY),
		LoginRequired,
		Validator('param', GuildIdCastCharacterIdParam),
		Validator('json', CastSetPrimaryRequest),
		OpenAPI({
			operationId: 'set_guild_cast_character_primary',
			summary: 'Set cast character primary',
			responseSchema: CastMutationResponse,
			statusCode: 200,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: ['Guilds'],
			description:
				'Set whether a cast character is a primary for the guild. The character must already be in the cast. The character ID is the personal site character ID, not a Fluxer snowflake. Requires the MANAGE_GUILD permission.',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const {guild_id, character_id} = ctx.req.valid('param');
			const {is_primary} = ctx.req.valid('json');
			const guildId = createGuildID(guild_id);

			await authorizeCastWrite(ctx.get('guildService'), userId, guildId);

			const result = await getCastClient().setPrimary(guildId.toString(), character_id, is_primary);
			if (!result.ok) {
				throwCastWriteFailure(guildId, result.failure);
			}
			return ctx.json({success: true, character_id: String(character_id), override: null});
		},
	);
}
