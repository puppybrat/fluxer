// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	castOverviewRowControls,
	excludeWrite,
	primaryWrite,
	removeWrite,
} from '@app/features/cast/utils/CastOverviewRowModel';
import type {CastOverviewEntry, CastOverviewEntryStatus} from '@app/features/cast/utils/CastOverviewTree';
import {describe, expect, it} from 'vitest';

const GUILD = '1517785346346057728';
const CHANNEL = '1524705144518737920';
const CATEGORY = '1525755266912485376';
const CHARACTER = 'char-1';

function entry(overrides: Partial<CastOverviewEntry> = {}): CastOverviewEntry {
	const name = overrides.character?.name ?? 'Rowan';
	return {
		characterId: CHARACTER,
		name: name ?? CHARACTER,
		character: {
			id: CHARACTER,
			name,
			alias: null,
			ship: null,
			owner: 1,
			nickname: null,
			pfp_url: null,
			reference_image_url: null,
		},
		status: 'added',
		nickname: null,
		isPrimary: false,
		pfpUrl: null,
		localOverride: null,
		...overrides,
	};
}

const ALL_STATUSES: Array<CastOverviewEntryStatus> = ['added', 'edited', 'excluded'];

describe('which controls a Cast Overview row shows', () => {
	it('offers Exclude at category and channel scope', () => {
		expect(castOverviewRowControls('category', entry()).canExclude).toBe(true);
		expect(castOverviewRowControls('channel', entry()).canExclude).toBe(true);
	});

	/**
	 * Server-wide there is no broader scope to fall back to, so hiding a character there would only be
	 * a worse-behaved removal. The checkbox is absent rather than disabled.
	 */
	it('never offers Exclude server-wide, whatever the row status', () => {
		for (const status of ALL_STATUSES) {
			expect(castOverviewRowControls('server', entry({status})).canExclude).toBe(false);
		}
	});

	/**
	 * The overview only ever renders a scope's OWN rows — nothing inherited reaches it — so removal
	 * always applies, in every sub-state, at every scope. This is the rule most at risk of being
	 * quietly narrowed back to "added only", which would strand edited and excluded rows.
	 */
	it('offers Remove on every row, at every scope and in every status', () => {
		for (const scope of ['server', 'category', 'channel'] as const) {
			for (const status of ALL_STATUSES) {
				expect(castOverviewRowControls(scope, entry({status})).canRemove).toBe(true);
			}
		}
	});

	it('marks only the excluded status as excluded', () => {
		expect(castOverviewRowControls('channel', entry({status: 'added'})).isExcluded).toBe(false);
		expect(castOverviewRowControls('channel', entry({status: 'edited'})).isExcluded).toBe(false);
		expect(castOverviewRowControls('channel', entry({status: 'excluded'})).isExcluded).toBe(true);
	});

	it('reflects the scope primary flag', () => {
		expect(castOverviewRowControls('channel', entry({isPrimary: true})).isPrimary).toBe(true);
		expect(castOverviewRowControls('channel', entry({isPrimary: false})).isPrimary).toBe(false);
	});

	it('builds the profile link from the real name', () => {
		expect(castOverviewRowControls('server', entry()).profileUrl).toBe('https://obyr.us/c/rowan');
	});

	/**
	 * `name` falls back to the character id for display; the link must not, or it would point
	 * confidently at a page that cannot exist.
	 */
	it('offers no profile link when the roster carries no name', () => {
		const nameless = entry({character: {...entry().character, name: null}, name: CHARACTER});
		expect(castOverviewRowControls('server', nameless).profileUrl).toBeNull();
	});
});

describe('what each control writes', () => {
	describe('Primary', () => {
		it('scopes to the channel at a channel row', () => {
			expect(primaryWrite(GUILD, CHANNEL, entry(), true)).toEqual({
				kind: 'setPrimary',
				guildId: GUILD,
				characterId: CHARACTER,
				isPrimary: true,
				channelId: CHANNEL,
			});
		});

		/**
		 * undefined, not null: setPrimary omits channel_id entirely when undefined, which is the exact
		 * server-scope body the guild settings tab already sends. An explicit null is a body shape no
		 * existing call site produces.
		 */
		it('omits the channel entirely server-wide', () => {
			const write = primaryWrite(GUILD, null, entry(), true);
			expect(write).toMatchObject({kind: 'setPrimary', channelId: undefined});
			expect(Object.hasOwn(write, 'channelId')).toBe(true);
			expect((write as {channelId: unknown}).channelId).toBeUndefined();
		});

		it('carries the requested value both ways', () => {
			expect(primaryWrite(GUILD, CHANNEL, entry(), false)).toMatchObject({isPrimary: false});
		});
	});

	describe('Exclude', () => {
		/**
		 * The whole point of the confirmed model: excluding is a flag flip on the row that is already
		 * there. It must NOT add a membership row (there is one) and must NOT remove anything on the
		 * way back, or the nickname/avatar/reference the row carries would be destroyed by a toggle.
		 */
		it('only flips the excluded flag, in both directions', () => {
			expect(excludeWrite(GUILD, CHANNEL, entry({status: 'edited'}), true)).toEqual({
				kind: 'setExcluded',
				guildId: GUILD,
				characterId: CHARACTER,
				excluded: true,
				channelId: CHANNEL,
			});
			expect(excludeWrite(GUILD, CHANNEL, entry({status: 'excluded'}), false)).toEqual({
				kind: 'setExcluded',
				guildId: GUILD,
				characterId: CHARACTER,
				excluded: false,
				channelId: CHANNEL,
			});
		});

		it('is never a remove, so a round-trip cannot destroy the row', () => {
			const on = excludeWrite(GUILD, CATEGORY, entry({status: 'edited'}), true);
			const off = excludeWrite(GUILD, CATEGORY, entry({status: 'excluded'}), false);
			expect(on.kind).toBe('setExcluded');
			expect(off.kind).toBe('setExcluded');
		});

		it('scopes to the category at a category row', () => {
			expect(excludeWrite(GUILD, CATEGORY, entry(), true)).toMatchObject({channelId: CATEGORY});
		});
	});

	describe('Remove', () => {
		it('scopes to the channel at a channel row', () => {
			expect(removeWrite(GUILD, CHANNEL, entry())).toEqual({
				kind: 'remove',
				guildId: GUILD,
				characterId: CHARACTER,
				channelId: CHANNEL,
			});
		});

		it('omits the channel entirely server-wide', () => {
			expect(removeWrite(GUILD, null, entry())).toMatchObject({kind: 'remove', channelId: undefined});
		});

		it('is the same single call whatever sub-state the row is in', () => {
			for (const status of ALL_STATUSES) {
				expect(removeWrite(GUILD, CHANNEL, entry({status}))).toEqual({
					kind: 'remove',
					guildId: GUILD,
					characterId: CHARACTER,
					channelId: CHANNEL,
				});
			}
		});
	});
});
