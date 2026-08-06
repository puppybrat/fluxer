// SPDX-License-Identifier: AGPL-3.0-or-later

import type {IPostgresClient} from '@pkgs/postgres/src/Client';

/**
 * Channel theme storage.
 *
 * These are real relational tables, unlike the rest of the application, which lives as tagged
 * JSONB inside the single `fluxer_kv` table. The theme data is genuinely relational and small
 * (a named library plus one row per themed channel), and the two invariants it depends on --
 * a channel holds either a named theme reference or a raw CSS blob but never both, and a named
 * theme cannot be deleted while a channel still references it -- are enforceable by the database
 * here but not expressible in the KV model, which has no per-table columns to constrain.
 *
 * This repository has no SQL migration files and no migration runner. Schema is applied by
 * idempotent DDL at service startup; `ensurePostgresKvSchema` is the existing instance of that
 * pattern. This function follows it and is called from the same two sites, so it runs on every
 * API and worker boot and is a no-op once the tables exist.
 *
 * `NAME_MAX_LENGTH` is mirrored by the application layer for validation; the CHECK is the
 * backstop, not the primary error path.
 */

const NAME_MAX_LENGTH = 100;

export async function ensureChannelThemeSchema(client: IPostgresClient): Promise<void> {
	await client.query(`
CREATE TABLE IF NOT EXISTS channel_themes (
	id bigserial PRIMARY KEY,
	name text NOT NULL UNIQUE CONSTRAINT channel_themes_name_length CHECK (char_length(name) BETWEEN 1 AND ${NAME_MAX_LENGTH}),
	css text NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now()
)`);
	await client.query(`
CREATE TABLE IF NOT EXISTS channel_theme_state (
	channel_id text PRIMARY KEY,
	theme_id bigint REFERENCES channel_themes (id) ON DELETE RESTRICT,
	css text,
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT channel_theme_state_ref_xor_blob CHECK (num_nonnulls(theme_id, css) <= 1)
)`);
	await client.query(
		'CREATE INDEX IF NOT EXISTS channel_theme_state_theme_id_idx ON channel_theme_state (theme_id) WHERE theme_id IS NOT NULL',
	);
}
