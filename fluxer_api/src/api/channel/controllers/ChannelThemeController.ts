/*
 * LOCAL-ONLY: This file is a local-only addition to fluxer_api and will never exist upstream.
 * It exposes the channel theme editor's API: a named theme library under /themes and per-channel
 * active state under /channels/:channel_id/appearance. Backed by ChannelThemeRepository, which
 * talks to real Postgres tables rather than the KV store.
 *
 * Do not confuse this with the upstream ThemeController (theme/ThemeController.ts), which owns
 * POST /users/@me/themes — a per-user shareable theme, an unrelated feature. The /themes prefix
 * used here is otherwise unclaimed.
 *
 * Lines to check on upstream merge: none — exclude this file entirely from any upstream sync.
 */

// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {UnknownChannelError} from '@fluxer/errors/src/domains/channel/UnknownChannelError';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';
import {MissingAccessError} from '@fluxer/errors/src/domains/core/MissingAccessError';
import {NotFoundError} from '@fluxer/errors/src/domains/core/NotFoundError';
import {ChannelIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import type {Context} from 'hono';
import {z} from 'zod';
import type {ChannelID} from '../../BrandedTypes';
import {createChannelID} from '../../BrandedTypes';
import {DefaultUserOnly, LoginRequired} from '../../middleware/AuthMiddleware';
import type {HonoApp, HonoEnv} from '../../types/HonoEnv';
import {Validator} from '../../Validator';
import {
	type ChannelAppearance,
	ChannelThemeRepository,
	type ChannelThemeRow,
	type ChannelThemeStateRow,
} from '../repositories/ChannelThemeRepository';

const THEME_NAME_MAX_LENGTH = 100;
const THEME_CSS_MAX_LENGTH = 100_000;

const SnowflakeLikeId = z.string().regex(/^\d+$/u, 'Must be a numeric ID');

const ThemeIdParam = z.object({theme_id: SnowflakeLikeId});

const ThemeCreateRequest = z.object({
	name: z.string().trim().min(1).max(THEME_NAME_MAX_LENGTH),
	css: z.string().max(THEME_CSS_MAX_LENGTH),
});

const ThemeUpdateRequest = z
	.object({
		name: z.string().trim().min(1).max(THEME_NAME_MAX_LENGTH).optional(),
		css: z.string().max(THEME_CSS_MAX_LENGTH).optional(),
	})
	.refine((value) => value.name !== undefined || value.css !== undefined, {
		message: 'At least one of name or css must be provided',
	});

const ApplyThemeRequest = z.object({theme_id: SnowflakeLikeId});

const SaveAndApplyRequest = z.object({css: z.string().max(THEME_CSS_MAX_LENGTH)});

const repository = new ChannelThemeRepository();

function serializeTheme(row: ChannelThemeRow) {
	return {id: row.id, name: row.name, css: row.css, updated_at: row.updated_at.toISOString()};
}

function serializeState(row: ChannelThemeStateRow) {
	return {
		channel_id: row.channel_id,
		theme_id: row.theme_id,
		css: row.css,
		updated_at: row.updated_at.toISOString(),
	};
}

function serializeAppearance(row: ChannelAppearance) {
	return {
		channel_id: row.channel_id,
		theme_id: row.theme_id,
		theme_name: row.theme_name,
		css: row.css,
		resolved_css: row.resolved_css,
		updated_at: row.updated_at.toISOString(),
	};
}

/**
 * Authorizes a channel appearance read or write.
 *
 * A guild channel gates on MANAGE_GUILD against its own guild, matching every other
 * administrative channel operation. A DM or group DM has no guild to check against
 * (`ChannelRow.guild_id` is nullable), so it falls back to recipient membership — the same shape
 * VoiceDiagnosticsService and the group DM services already use for DM-reachable code paths.
 *
 * This matters for more than completeness: this instance's primary writing channel is a bare DM,
 * so a strict MANAGE_GUILD-only gate would make the feature unreachable exactly where it is most
 * wanted. In this deployment the fallback grants access to precisely the same two accounts, since
 * both users are permanent MANAGE_GUILD admins and are the only recipients of that DM.
 */
async function authorizeChannelAppearance(ctx: Context<HonoEnv>, channelId: ChannelID): Promise<void> {
	const channel = await ctx.get('channelRepository').findUnique(channelId);
	if (!channel) {
		throw new UnknownChannelError();
	}
	const userId = ctx.get('user').id;
	if (channel.guildId) {
		const {checkPermission} = await ctx.get('guildService').getGuildAuthenticated({
			userId,
			guildId: channel.guildId,
		});
		await checkPermission(Permissions.MANAGE_GUILD);
		return;
	}
	if (!channel.recipientIds.has(userId)) {
		throw new MissingAccessError();
	}
}

export function ChannelThemeController(app: HonoApp) {
	// The named theme library is instance-global: a theme is not owned by any guild, so there is
	// no guild context to run a MANAGE_GUILD check against here. These routes gate on an
	// authenticated non-bot user; the per-channel routes below are where the real authorization
	// happens, since applying a theme is the only action with a visible effect.
	app.get('/themes', LoginRequired, DefaultUserOnly, async (ctx) => {
		const themes = await repository.listThemes();
		return ctx.json(themes.map(serializeTheme));
	});

	app.post('/themes', LoginRequired, DefaultUserOnly, Validator('json', ThemeCreateRequest), async (ctx) => {
		const {name, css} = ctx.req.valid('json');
		const existing = await repository.listThemes();
		if (existing.some((theme) => theme.name === name)) {
			throw new ConflictError({
				code: APIErrorCodes.CONFLICT,
				message: 'A theme with that name already exists',
			});
		}
		return ctx.json(serializeTheme(await repository.createTheme(name, css)), 201);
	});

	app.put(
		'/themes/:theme_id',
		LoginRequired,
		DefaultUserOnly,
		Validator('param', ThemeIdParam),
		Validator('json', ThemeUpdateRequest),
		async (ctx) => {
			const {theme_id} = ctx.req.valid('param');
			const updated = await repository.updateTheme(theme_id, ctx.req.valid('json'));
			if (!updated) {
				throw new NotFoundError({code: APIErrorCodes.NOT_FOUND, message: 'Unknown theme'});
			}
			return ctx.json(serializeTheme(updated));
		},
	);

	app.delete(
		'/themes/:theme_id',
		LoginRequired,
		DefaultUserOnly,
		Validator('param', ThemeIdParam),
		async (ctx) => {
			const {theme_id} = ctx.req.valid('param');
			const result = await repository.deleteTheme(theme_id);
			if (!result.deleted && result.blocked_by.length > 0) {
				// The blocking channel IDs travel in the error body; the caller resolves them to
				// names, which this layer has no reason to load.
				throw new ConflictError({
					code: APIErrorCodes.CONFLICT,
					message: 'Theme is still applied to one or more channels',
					data: {channel_ids: result.blocked_by},
				});
			}
			if (!result.deleted) {
				throw new NotFoundError({code: APIErrorCodes.NOT_FOUND, message: 'Unknown theme'});
			}
			return ctx.body(null, 204);
		},
	);

	app.get('/channels/:channel_id/appearance', LoginRequired, Validator('param', ChannelIdParam), async (ctx) => {
		const channelId = createChannelID(ctx.req.valid('param').channel_id);
		await authorizeChannelAppearance(ctx, channelId);
		const appearance = await repository.getChannelAppearance(channelId.toString());
		// An unthemed channel is a normal state, not an error: report the empty shape so a client
		// can treat "no theme" and "theme cleared" identically.
		if (!appearance) {
			return ctx.json({
				channel_id: channelId.toString(),
				theme_id: null,
				theme_name: null,
				css: null,
				resolved_css: null,
				updated_at: null,
			});
		}
		return ctx.json(serializeAppearance(appearance));
	});

	app.post(
		'/channels/:channel_id/appearance/apply-theme',
		LoginRequired,
		Validator('param', ChannelIdParam),
		Validator('json', ApplyThemeRequest),
		async (ctx) => {
			const channelId = createChannelID(ctx.req.valid('param').channel_id);
			await authorizeChannelAppearance(ctx, channelId);
			const {theme_id} = ctx.req.valid('json');
			// Checked before the write so a bad reference surfaces as a 404 naming the theme,
			// rather than as a foreign key violation from the database driver.
			if (!(await repository.getTheme(theme_id))) {
				throw new NotFoundError({code: APIErrorCodes.NOT_FOUND, message: 'Unknown theme'});
			}
			return ctx.json(serializeState(await repository.applyTheme(channelId.toString(), theme_id)));
		},
	);

	app.post(
		'/channels/:channel_id/appearance/save-and-apply',
		LoginRequired,
		Validator('param', ChannelIdParam),
		Validator('json', SaveAndApplyRequest),
		async (ctx) => {
			const channelId = createChannelID(ctx.req.valid('param').channel_id);
			await authorizeChannelAppearance(ctx, channelId);
			const {css} = ctx.req.valid('json');
			return ctx.json(serializeState(await repository.saveRawCss(channelId.toString(), css)));
		},
	);

	app.delete('/channels/:channel_id/appearance', LoginRequired, Validator('param', ChannelIdParam), async (ctx) => {
		const channelId = createChannelID(ctx.req.valid('param').channel_id);
		await authorizeChannelAppearance(ctx, channelId);
		await repository.clearChannelAppearance(channelId.toString());
		// Idempotent: clearing an already-unthemed channel is a success, not a 404.
		return ctx.body(null, 204);
	});
}
