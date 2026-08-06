/*
 * LOCAL-ONLY: This file is a local-only addition to fluxer_api and will never exist upstream.
 * It is the only data access path for the channel theme tables created by
 * ensureChannelThemeSchema (see database/ChannelThemeSchema.ts).
 *
 * Unlike every other repository in this codebase, this one talks to real relational tables via
 * IPostgresClient rather than going through the KV DSL (defineTable/fetchOne/fetchMany). That is
 * deliberate: channel_themes and channel_theme_state are genuine Postgres tables with a foreign
 * key and CHECK constraints, none of which the KV model can express. Do not port this to the KV
 * DSL — the constraints are the reason the tables exist in that form.
 *
 * Lines to check on upstream merge: none — exclude this file entirely from any upstream sync.
 */

// SPDX-License-Identifier: AGPL-3.0-or-later

import {getDefaultPostgresClient, type PostgresQueryable} from '@pkgs/postgres/src/Client';

/**
 * `id` is `bigserial`, which node-postgres returns as a string rather than a number, so it is
 * carried as a string end to end. That also keeps it consistent with how every other ID crosses
 * this API's wire format.
 */
export interface ChannelThemeRow {
	id: string;
	name: string;
	css: string;
	updated_at: Date;
}

export interface ChannelThemeStateRow {
	channel_id: string;
	theme_id: string | null;
	css: string | null;
	updated_at: Date;
}

/**
 * A channel's active state with the referenced theme already resolved, so a caller never has to
 * make a second round trip to turn a theme reference into CSS. `resolved_css` is whichever of the
 * two sources is actually in effect; it is null only when the channel has no theme at all.
 */
export interface ChannelAppearance {
	channel_id: string;
	theme_id: string | null;
	theme_name: string | null;
	css: string | null;
	resolved_css: string | null;
	updated_at: Date;
}

export interface DeleteThemeResult {
	deleted: boolean;
	/** Channel IDs still referencing the theme. Non-empty only when `deleted` is false. */
	blocked_by: Array<string>;
}

export class ChannelThemeRepository {
	private client(): PostgresQueryable {
		return getDefaultPostgresClient();
	}

	async listThemes(): Promise<Array<ChannelThemeRow>> {
		const result = await this.client().query<ChannelThemeRow>(
			'SELECT id, name, css, updated_at FROM channel_themes ORDER BY name ASC',
		);
		return result.rows;
	}

	async getTheme(themeId: string): Promise<ChannelThemeRow | null> {
		const result = await this.client().query<ChannelThemeRow>(
			'SELECT id, name, css, updated_at FROM channel_themes WHERE id = $1',
			[themeId],
		);
		return result.rows[0] ?? null;
	}

	async createTheme(name: string, css: string): Promise<ChannelThemeRow> {
		const result = await this.client().query<ChannelThemeRow>(
			'INSERT INTO channel_themes (name, css) VALUES ($1, $2) RETURNING id, name, css, updated_at',
			[name, css],
		);
		return result.rows[0]!;
	}

	/**
	 * Partial update. Both fields are optional and a field left undefined keeps its stored value,
	 * so a caller can rename without resending the CSS blob. Returns null when the theme is gone.
	 */
	async updateTheme(themeId: string, fields: {name?: string; css?: string}): Promise<ChannelThemeRow | null> {
		const result = await this.client().query<ChannelThemeRow>(
			`UPDATE channel_themes
			SET name = COALESCE($2, name),
				css = COALESCE($3, css),
				updated_at = now()
			WHERE id = $1
			RETURNING id, name, css, updated_at`,
			[themeId, fields.name ?? null, fields.css ?? null],
		);
		return result.rows[0] ?? null;
	}

	async getChannelAppearance(channelId: string): Promise<ChannelAppearance | null> {
		const result = await this.client().query<ChannelAppearance>(
			`SELECT s.channel_id,
				s.theme_id,
				t.name AS theme_name,
				s.css,
				COALESCE(s.css, t.css) AS resolved_css,
				s.updated_at
			FROM channel_theme_state s
			LEFT JOIN channel_themes t ON t.id = s.theme_id
			WHERE s.channel_id = $1`,
			[channelId],
		);
		return result.rows[0] ?? null;
	}

	/**
	 * Points a channel at a named theme, clearing any raw blob. Writing both columns explicitly
	 * rather than only the one being set is what keeps the mutual-exclusivity CHECK satisfied on
	 * an upsert over an existing row of the opposite kind.
	 */
	async applyTheme(channelId: string, themeId: string): Promise<ChannelThemeStateRow> {
		const result = await this.client().query<ChannelThemeStateRow>(
			`INSERT INTO channel_theme_state (channel_id, theme_id, css)
			VALUES ($1, $2, NULL)
			ON CONFLICT (channel_id) DO UPDATE
				SET theme_id = EXCLUDED.theme_id, css = NULL, updated_at = now()
			RETURNING channel_id, theme_id, css, updated_at`,
			[channelId, themeId],
		);
		return result.rows[0]!;
	}

	/** Writes a raw CSS blob to a channel, detaching it from any named theme. */
	async saveRawCss(channelId: string, css: string): Promise<ChannelThemeStateRow> {
		const result = await this.client().query<ChannelThemeStateRow>(
			`INSERT INTO channel_theme_state (channel_id, theme_id, css)
			VALUES ($1, NULL, $2)
			ON CONFLICT (channel_id) DO UPDATE
				SET theme_id = NULL, css = EXCLUDED.css, updated_at = now()
			RETURNING channel_id, theme_id, css, updated_at`,
			[channelId, css],
		);
		return result.rows[0]!;
	}

	async clearChannelAppearance(channelId: string): Promise<boolean> {
		const result = await this.client().query('DELETE FROM channel_theme_state WHERE channel_id = $1', [channelId]);
		return (result.rowCount ?? 0) > 0;
	}

	/**
	 * Deletes a named theme, refusing while any channel still references it and reporting which
	 * ones do so the caller can name them. The read and the delete share one transaction, and the
	 * rows are locked for the duration, so a channel cannot start referencing the theme between
	 * the check and the delete. The FK's ON DELETE RESTRICT is still the final backstop.
	 */
	async deleteTheme(themeId: string): Promise<DeleteThemeResult> {
		return getDefaultPostgresClient().transaction(async (tx) => {
			const referencing = await tx.query<{channel_id: string}>(
				'SELECT channel_id FROM channel_theme_state WHERE theme_id = $1 ORDER BY channel_id ASC FOR UPDATE',
				[themeId],
			);
			if (referencing.rows.length > 0) {
				return {deleted: false, blocked_by: referencing.rows.map((row) => row.channel_id)};
			}
			const result = await tx.query('DELETE FROM channel_themes WHERE id = $1', [themeId]);
			return {deleted: (result.rowCount ?? 0) > 0, blocked_by: []};
		});
	}
}
