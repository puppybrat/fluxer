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
// Both refreshes, not just the first: runWrite fans out to refresh AND refreshGuildChannels, and a
// mock missing either makes every write throw late and get swallowed, leaving the suite green for
// the wrong reason (`load` has already updated the rows by the time it throws).
vi.mock('@app/features/cast/state/GuildCastDisplay', () => ({
	default: {refresh: vi.fn(), refreshGuildChannels: vi.fn()},
}));

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
 *
 * `is_primary` in the projection follows the real most-specific-first walk (scoped row wins,
 * otherwise the server row) rather than being hardcoded false. That is what makes the shadowing
 * hazard visible here at all: a scoped add lands at is_primary=0 and would otherwise silently mask
 * a server-scope is_primary=1.
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
		primacyFor(id: string, scope: string) {
			const scoped = primaries.find((p) => p.character_id === id && p.channel_id === scope);
			if (scoped) {
				return scoped.is_primary;
			}
			return primaries.find((p) => p.character_id === id && p.channel_id === null)?.is_primary ?? false;
		},
		project(scope: string) {
			const ids = new Set(primaries.map((p) => p.character_id));
			const resolved = [...ids]
				.filter((id) => !overrides.some((o) => o.character_id === id && o.channel_id === scope && o.excluded))
				.map((id) => ({
					character_id: id,
					is_primary: this.primacyFor(id, scope),
					nickname: null,
					pfp_url: null,
					reference_image_url: null,
				}));
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
	// Mirrors the endpoint: primacy is a flag on an EXISTING membership row at that scope, never a
	// row-creating write (the real one answers 409 when the membership is absent).
	vi.mocked(CastCommands.setPrimary).mockImplementation(async (_g, id, isPrimary, ch) => {
		const row = backend.primaries.find((p) => p.character_id === id && p.channel_id === (ch ?? null));
		if (!row) {
			throw new Error(`setPrimary without membership at scope ${String(ch)}`);
		}
		row.is_primary = isPrimary;
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
		// Call history only — implementations are (re)installed by wireBackend inside each test. Without
		// this the suite has no clearMocks, so a "was never called" assertion would read a prior test's
		// calls and pass or fail for the wrong reason.
		vi.clearAllMocks();
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

		// The write must actually have completed. Without this the suite still passes when runWrite
		// throws late and swallows it, because `load` has already refreshed the rows by then.
		expect(ChannelCast.writeError).toBeNull();
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

	/**
	 * The Cast Overview renders each scope's LOCAL rows only, so an inherited character has no row
	 * there at all. Its picker therefore has to offer inherited characters — pulling one local is the
	 * prerequisite for excluding or overriding it at that scope — while the settings tab's picker must
	 * keep withholding them, because that tab lists them as rows already.
	 */
	describe('locallyAddableCharacters — the local-rows-only surface', () => {
		/** The same fixture as the first test: one of each status, plus a fully-absent character. */
		async function loadOneOfEachStatus() {
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
			return backend;
		}

		it('offers the inherited character as well as the absent one', async () => {
			await loadOneOfEachStatus();
			expect(ChannelCast.locallyAddableCharacters.map((c) => c.id).sort()).toEqual(['abs', 'inh']);
		});

		/**
		 * An excluded character DOES have a local row and DOES show on that surface, so offering it
		 * again would be a second, worse way to un-exclude it. Locally-present is likewise withheld.
		 */
		it('still withholds locally-present and excluded characters', async () => {
			await loadOneOfEachStatus();
			const offered = ChannelCast.locallyAddableCharacters.map((c) => c.id);
			expect(offered).not.toContain('loc');
			expect(offered).not.toContain('exc');
		});

		/** The regression that matters: the settings tab's rule must be untouched by all of this. */
		it('leaves the settings-tab rule withholding the inherited character', async () => {
			await loadOneOfEachStatus();
			expect(ChannelCast.addableCharacters.map((c) => c.id).sort()).toEqual(['abs']);
		});

		it('stops offering an inherited character once it has been pulled local', async () => {
			await loadOneOfEachStatus();
			expect(ChannelCast.locallyAddableCharacters.map((c) => c.id)).toContain('inh');

			await ChannelCast.addLocal('inh');

			expect(ChannelCast.writeError).toBeNull();
			expect(ChannelCast.rows.find((r) => r.character.id === 'inh')?.status).toBe('local');
			expect(ChannelCast.locallyAddableCharacters.map((c) => c.id)).not.toContain('inh');
			// And it was never on offer in the settings tab, before or after.
			expect(ChannelCast.addableCharacters.map((c) => c.id)).not.toContain('inh');
		});

		/**
		 * The two rules may only ever differ by inherited characters. Anything else diverging means one
		 * of them has drifted into a different notion of "already handled here".
		 */
		it('differs from the settings-tab rule by exactly the inherited characters', async () => {
			await loadOneOfEachStatus();
			const inheritedIds = ChannelCast.rows.filter((r) => r.status === 'inherited').map((r) => r.character.id);
			const settingsTab = new Set(ChannelCast.addableCharacters.map((c) => c.id));
			const overview = ChannelCast.locallyAddableCharacters.map((c) => c.id);
			expect(overview.filter((id) => !settingsTab.has(id)).sort()).toEqual([...inheritedIds].sort());
		});
	});

	/**
	 * Regression for the real #parent-test bug: character_primaries is both the membership table and
	 * the primacy flag, so the row a scoped add creates (is_primary=0) shadowed the server-scope
	 * is_primary=1 for the rest of the walk. Pulling a character into local view on the Cast Overview
	 * therefore silently demoted it. Taking local control must change who decides, not what resolves.
	 */
	describe('addLocal preserves resolved primacy', () => {
		it('an inherited-primary character stays primary once pulled local', async () => {
			const backend = makeBackend([{character_id: 'inh', channel_id: null, is_primary: true}]);
			wireBackend(backend, ['inh'].map(character));

			await ChannelCast.load('g', CH);
			// Primary here purely by inheritance — no row at this scope at all.
			expect(ChannelCast.rows.find((r) => r.character.id === 'inh')?.status).toBe('inherited');
			expect(ChannelCast.rows.find((r) => r.character.id === 'inh')?.isPrimary).toBe(true);

			await ChannelCast.addLocal('inh');

			expect(ChannelCast.writeError).toBeNull();
			// Now decided locally, but resolving to exactly what it did before.
			expect(ChannelCast.rows.find((r) => r.character.id === 'inh')?.status).toBe('local');
			expect(ChannelCast.rows.find((r) => r.character.id === 'inh')?.isPrimary).toBe(true);
			// The follow-up write is what carries the primacy across; without it the new scoped row
			// sits at is_primary=0 and shadows the server row.
			expect(CastCommands.setPrimary).toHaveBeenCalledWith('g', 'inh', true, CH);
			expect(backend.primaries.find((p) => p.character_id === 'inh' && p.channel_id === CH)?.is_primary).toBe(true);
		});

		it('a non-primary inherited character is pulled local with no setPrimary call', async () => {
			const backend = makeBackend([{character_id: 'inh', channel_id: null, is_primary: false}]);
			wireBackend(backend, ['inh'].map(character));

			await ChannelCast.load('g', CH);
			expect(ChannelCast.rows.find((r) => r.character.id === 'inh')?.isPrimary).toBe(false);

			await ChannelCast.addLocal('inh');

			expect(ChannelCast.writeError).toBeNull();
			expect(ChannelCast.rows.find((r) => r.character.id === 'inh')?.status).toBe('local');
			expect(ChannelCast.rows.find((r) => r.character.id === 'inh')?.isPrimary).toBe(false);
			// No spurious second write: the add already lands on the correct value.
			expect(CastCommands.setPrimary).not.toHaveBeenCalled();
		});
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
