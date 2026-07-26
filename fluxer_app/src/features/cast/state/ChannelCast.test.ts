// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/cast/commands/CastCommands', () => ({
	getGuildCast: vi.fn(),
	getAllCharacters: vi.fn(),
	addCharacter: vi.fn(),
	removeCharacter: vi.fn(),
	setPrimary: vi.fn(),
	updateOverride: vi.fn(),
}));
vi.mock('@app/features/cast/state/ComposerInCharacter', () => ({default: {refresh: vi.fn()}}));
vi.mock('@app/features/cast/state/GuildCastDisplay', () => ({default: {refresh: vi.fn()}}));

import * as CastCommands from '@app/features/cast/commands/CastCommands';
import ChannelCast from '@app/features/cast/state/ChannelCast';

const CH = '1524705144518737920';

function character(id: string) {
	return {id, name: id, alias: null, ship: null, owner: 1, nickname: null, pfp_url: null, reference_image_url: null};
}

/**
 * A stateful fake of the personal-site cast tables mutated by the write commands exactly as the real
 * backend does (verified against the live API): a scoped add creates a scoped primaries row, a
 * scoped excluded override needs that membership, and getGuildCast projects resolved_cast for the
 * queried scope (excluded characters drop out of resolved_cast).
 */
function makeBackend(seedPrimaries: Array<{character_id: string; channel_id: string | null; is_primary: boolean}>) {
	const primaries = [...seedPrimaries];
	const overrides: Array<{
		character_id: string;
		channel_id: string | null;
		excluded: boolean;
		nickname: string | null;
		pfp_url: string | null;
		reference_image_url: string | null;
	}> = [];
	return {
		primaries,
		overrides,
		project(scope: string) {
			const ids = new Set(primaries.map((p) => p.character_id));
			const resolved = [...ids]
				.filter((id) => !overrides.some((o) => o.character_id === id && o.channel_id === scope && o.excluded))
				.map((id) => ({character_id: id, is_primary: false, nickname: null, pfp_url: null, reference_image_url: null}));
			return {
				characters: [...ids].map(character),
				categories: [],
				primaries: [...primaries],
				overrides: [...overrides],
				resolved_cast: resolved,
			};
		},
	};
}

function wireBackend(backend: ReturnType<typeof makeBackend>, roster: Array<ReturnType<typeof character>>) {
	vi.mocked(CastCommands.getGuildCast).mockImplementation(async (_g, ch) => backend.project(ch as string) as never);
	vi.mocked(CastCommands.getAllCharacters).mockResolvedValue(roster as never);
	vi.mocked(CastCommands.addCharacter).mockImplementation(async (_g, id, ch) => {
		if (ch != null && !backend.primaries.some((p) => p.character_id === id && p.channel_id === ch)) {
			backend.primaries.push({character_id: id, channel_id: ch, is_primary: false});
		}
		return {} as never;
	});
	vi.mocked(CastCommands.removeCharacter).mockImplementation(async (_g, id, ch) => {
		for (let i = backend.primaries.length - 1; i >= 0; i--) {
			if (backend.primaries[i]!.character_id === id && backend.primaries[i]!.channel_id === ch)
				backend.primaries.splice(i, 1);
		}
		for (let i = backend.overrides.length - 1; i >= 0; i--) {
			if (backend.overrides[i]!.character_id === id && backend.overrides[i]!.channel_id === ch)
				backend.overrides.splice(i, 1);
		}
		return {} as never;
	});
	vi.mocked(CastCommands.updateOverride).mockImplementation(async (_g, id, u) => {
		const ch = u.channelId ?? null;
		let row = backend.overrides.find((o) => o.character_id === id && o.channel_id === ch);
		if (!row) {
			row = {
				character_id: id,
				channel_id: ch,
				excluded: false,
				nickname: null,
				pfp_url: null,
				reference_image_url: null,
			};
			backend.overrides.push(row);
		}
		if (u.excluded != null) row.excluded = u.excluded;
		return {} as never;
	});
}

describe('ChannelCast — scoped picker filter', () => {
	beforeEach(() => {
		ChannelCast.reset();
	});

	it('the picker offers only fully-absent characters (not present or excluded)', async () => {
		// inh: server row only (inherited). exc: server + channel rows + channel exclude. loc: channel row.
		const backend = makeBackend([
			{character_id: 'inh', channel_id: null, is_primary: false},
			{character_id: 'exc', channel_id: null, is_primary: false},
			{character_id: 'exc', channel_id: CH, is_primary: false},
			{character_id: 'loc', channel_id: CH, is_primary: false},
		]);
		backend.overrides.push({
			character_id: 'exc',
			channel_id: CH,
			excluded: true,
			nickname: null,
			pfp_url: null,
			reference_image_url: null,
		});
		wireBackend(backend, ['inh', 'exc', 'loc', 'abs'].map(character));

		await ChannelCast.load('g', CH);
		await ChannelCast.loadAllCharacters('g');

		const byStatus = new Map(ChannelCast.rows.map((r) => [r.character.id, r.status]));
		expect(byStatus.get('inh')).toBe('inherited');
		expect(byStatus.get('loc')).toBe('local');
		expect(byStatus.get('exc')).toBe('excluded');

		// Only the fully-absent 'abs' is offered. inh (inherited) and loc (local) are present, exc is
		// excluded — all shown as rows and acted on there (Edit/Primary/Exclude/Remove/Un-exclude).
		expect(ChannelCast.addableCharacters.map((c) => c.id).sort()).toEqual(['abs']);
	});

	it('excluding an inherited character removes it from the picker (Issue 1)', async () => {
		const backend = makeBackend([{character_id: 'inh', channel_id: null, is_primary: false}]);
		wireBackend(backend, ['inh', 'other'].map(character));

		await ChannelCast.load('g', CH);
		await ChannelCast.loadAllCharacters('g');
		// inh is inherited (present) so it is not in the picker; only the fully-absent 'other' is.
		expect(ChannelCast.addableCharacters.map((c) => c.id)).toEqual(['other']);

		await ChannelCast.exclude('inh');

		expect(ChannelCast.rows.find((r) => r.character.id === 'inh')?.status).toBe('excluded');
		expect(ChannelCast.addableCharacters.map((c) => c.id)).not.toContain('inh');
	});

	it('adding an inherited character promotes it to local with full access (Issue 2)', async () => {
		const backend = makeBackend([{character_id: 'inh', channel_id: null, is_primary: false}]);
		wireBackend(backend, ['inh'].map(character));

		await ChannelCast.load('g', CH);
		expect(ChannelCast.rows.find((r) => r.character.id === 'inh')?.status).toBe('inherited');

		await ChannelCast.addLocal('inh');

		// Now local: the tab gives it Edit / Primary / Remove, and the picker stops offering it.
		expect(ChannelCast.rows.find((r) => r.character.id === 'inh')?.status).toBe('local');
		await ChannelCast.loadAllCharacters('g');
		expect(ChannelCast.addableCharacters.map((c) => c.id)).not.toContain('inh');
	});

	it('a server-scope (null) row is never treated as local, even if the scope is unset', async () => {
		const backend = makeBackend([{character_id: 'srv', channel_id: null, is_primary: false}]);
		wireBackend(backend, ['srv', 'abs'].map(character));
		await ChannelCast.load('g', CH);
		await ChannelCast.loadAllCharacters('g');

		// Force the degenerate torn/unset-scope state: scope null while server primaries remain loaded.
		ChannelCast.channelId = null;

		// The server member must NOT be classified local (the exact inversion this guards against): it
		// stays 'inherited' (present via the server row), so it shows as a row and the picker offers only
		// the fully-absent 'abs'. Without the guard it would read as 'local' and warp both.
		expect(ChannelCast.rows.every((r) => r.status !== 'local')).toBe(true);
		expect(ChannelCast.rows.find((r) => r.character.id === 'srv')?.status).toBe('inherited');
		expect(ChannelCast.addableCharacters.map((c) => c.id)).toEqual(['abs']);
	});
});
