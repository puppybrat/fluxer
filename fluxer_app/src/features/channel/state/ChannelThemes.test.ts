// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

// Every command the store calls, not just the ones a given test exercises: an absent export makes the
// store's call throw, and because loads and writes both swallow into writeError/libraryError, the
// suite would stay green while asserting on state that was never written.
vi.mock('@app/features/channel/commands/ChannelCommands', () => ({
	fetchChannelThemes: vi.fn(),
	fetchChannelAppearance: vi.fn(),
	createChannelTheme: vi.fn(),
	updateChannelTheme: vi.fn(),
	applyChannelTheme: vi.fn(),
	saveAndApplyChannelCss: vi.fn(),
	clearChannelAppearance: vi.fn(),
	deleteChannelTheme: vi.fn(),
}));

import * as ChannelCommands from '@app/features/channel/commands/ChannelCommands';
import ChannelThemes from '@app/features/channel/state/ChannelThemes';
import {HttpError} from '@app/features/platform/types/EndpointError';

/** The real DM channel this instance writes in, and a guild channel, for the two-channel cases. */
const CH = '1516491615135334400';
const CH_B = '1517785346346057728';

const STAMP = '2026-08-06T00:00:00.000Z';

interface FakeTheme {
	id: string;
	name: string;
	css: string;
	updated_at: string;
}

/**
 * A stateful fake of the two Postgres tables the theme routes own, mutated exactly as the real
 * backend does (verified against the live dev stack when those routes were built):
 *
 * - `channel_theme_state` holds at most one of theme_id/css per channel — the database enforces it
 *   with a CHECK — so both writes set both columns rather than only the one being changed.
 * - a delete is refused while any channel references the theme, answering 409 with the blocking
 *   channel_ids in the body.
 * - a channel with no row reads back as the all-null shape, not a 404.
 *
 * Mirroring the exclusivity here rather than returning canned rows is what lets the ref -> blob and
 * blob -> ref transitions be tested at all; a fake that echoed the request would pass either way.
 */
function makeBackend(seedThemes: Array<{id: string; name: string; css: string}> = []) {
	const themes: Array<FakeTheme> = seedThemes.map((theme) => ({...theme, updated_at: STAMP}));
	const state = new Map<string, {theme_id: string | null; css: string | null}>();
	let nextId = themes.length + 1;
	return {
		themes,
		state,
		find(themeId: string) {
			return themes.find((theme) => theme.id === themeId);
		},
		referencingChannels(themeId: string) {
			return [...state.entries()].filter(([, row]) => row.theme_id === themeId).map(([channelId]) => channelId);
		},
		nextId() {
			return String(nextId++);
		},
	};
}

/** A 409 shaped like ChannelThemeController's ConflictError, whose `data` is spread into the body. */
function conflict(path: string, body: Record<string, unknown>): HttpError {
	return new HttpError({method: 'DELETE', path, status: 409, body, responseHeaders: {}});
}

function wireBackend(backend: ReturnType<typeof makeBackend>) {
	vi.mocked(ChannelCommands.fetchChannelThemes).mockImplementation(
		async () => [...backend.themes].sort((a, b) => a.name.localeCompare(b.name)) as never,
	);
	vi.mocked(ChannelCommands.fetchChannelAppearance).mockImplementation(async (channelId) => {
		const row = backend.state.get(channelId);
		const theme = row?.theme_id != null ? backend.find(row.theme_id) : undefined;
		return {
			channel_id: channelId,
			theme_id: row?.theme_id ?? null,
			theme_name: theme?.name ?? null,
			css: row?.css ?? null,
			// The server resolves the join itself; the store ignores this and resolves locally, but the
			// fake still supplies it so a future reader is not misled about the wire shape.
			resolved_css: row?.css ?? theme?.css ?? null,
			updated_at: row ? STAMP : null,
		} as never;
	});
	vi.mocked(ChannelCommands.createChannelTheme).mockImplementation(async (name, css) => {
		if (backend.themes.some((theme) => theme.name === name)) {
			throw conflict('/themes', {code: 'CONFLICT', message: 'Conflict.'});
		}
		const created: FakeTheme = {id: backend.nextId(), name, css, updated_at: STAMP};
		backend.themes.push(created);
		return created as never;
	});
	vi.mocked(ChannelCommands.updateChannelTheme).mockImplementation(async (themeId, fields) => {
		const theme = backend.find(themeId);
		if (!theme) {
			throw new HttpError({method: 'PUT', path: `/themes/${themeId}`, status: 404, responseHeaders: {}});
		}
		// COALESCE semantics: an omitted field keeps its stored value.
		theme.name = fields.name ?? theme.name;
		theme.css = fields.css ?? theme.css;
		return {...theme} as never;
	});
	vi.mocked(ChannelCommands.applyChannelTheme).mockImplementation(async (channelId, themeId) => {
		backend.state.set(channelId, {theme_id: themeId, css: null});
		return {channel_id: channelId, theme_id: themeId, css: null, updated_at: STAMP} as never;
	});
	vi.mocked(ChannelCommands.saveAndApplyChannelCss).mockImplementation(async (channelId, css) => {
		backend.state.set(channelId, {theme_id: null, css});
		return {channel_id: channelId, theme_id: null, css, updated_at: STAMP} as never;
	});
	vi.mocked(ChannelCommands.clearChannelAppearance).mockImplementation(async (channelId) => {
		backend.state.delete(channelId);
	});
	vi.mocked(ChannelCommands.deleteChannelTheme).mockImplementation(async (themeId) => {
		const blocking = backend.referencingChannels(themeId);
		if (blocking.length > 0) {
			throw conflict(`/themes/${themeId}`, {
				code: 'CONFLICT',
				message: 'Conflict.',
				channel_ids: blocking,
			});
		}
		const index = backend.themes.findIndex((theme) => theme.id === themeId);
		if (index >= 0) {
			backend.themes.splice(index, 1);
		}
	});
}

/** Wires a backend and loads its library into the store, the state most tests start from. */
async function loadWith(seedThemes: Array<{id: string; name: string; css: string}>) {
	const backend = makeBackend(seedThemes);
	wireBackend(backend);
	await ChannelThemes.loadLibrary();
	return backend;
}

const MIDNIGHT = {id: '1', name: 'midnight', css: ':root { --background-primary: #000; }'};
const DAYLIGHT = {id: '2', name: 'daylight', css: ':root { --background-primary: #fff; }'};

describe('ChannelThemes — theme resolution and library state', () => {
	beforeEach(async () => {
		// ChannelThemes has no reset() (unlike ChannelCast), so the singleton is returned to a clean
		// state through its public API: loadLibrary against an empty backend clears the library map,
		// and setThemeCss(_, null) drops each channel entry. Mocks are cleared afterwards so a
		// "was never called" assertion cannot read this setup's own calls.
		wireBackend(makeBackend());
		await ChannelThemes.loadLibrary();
		for (const channelId of [CH, CH_B]) {
			ChannelThemes.setThemeCss(channelId, null);
		}
		ChannelThemes.clearWriteError();
		vi.clearAllMocks();
	});

	describe('getThemeCss — the render path ChannelLayout depends on', () => {
		it('returns null for an unthemed channel', async () => {
			await loadWith([MIDNIGHT]);
			// Null is what makes useChannelThemeStyle a no-op; anything else injects a style element.
			expect(ChannelThemes.getThemeCss(CH)).toBeNull();
		});

		it('resolves CSS through the library for a themeId ref', async () => {
			await loadWith([MIDNIGHT]);

			expect(await ChannelThemes.applyTheme(CH, MIDNIGHT.id)).toBe(true);

			// The write must actually have completed. Without this the assertion below could pass off a
			// stale or coincidental value while the write silently failed into writeError.
			expect(ChannelThemes.writeError).toBeNull();
			expect(ChannelThemes.getThemeCss(CH)).toBe(MIDNIGHT.css);
			expect(ChannelThemes.getChannelState(CH)).toEqual({themeId: MIDNIGHT.id, css: null});
		});

		it('returns the raw blob directly for a css blob', async () => {
			await loadWith([MIDNIGHT]);
			const blob = ':root { --background-primary: #222; }';

			expect(await ChannelThemes.saveAndApply(CH, blob)).toBe(true);

			expect(ChannelThemes.writeError).toBeNull();
			expect(ChannelThemes.getThemeCss(CH)).toBe(blob);
			// Not merely "css is set" — the theme reference must be gone, or the local state holds both
			// and contradicts the database CHECK the two writes exist to respect.
			expect(ChannelThemes.getChannelState(CH)).toEqual({themeId: null, css: blob});
		});

		/**
		 * A reference the library cannot resolve yet is the ordinary state between the channel-state
		 * load landing and the library load landing. It must read as "no theme" rather than throwing,
		 * so the channel renders unstyled for that moment and restyles once the library arrives.
		 */
		it('returns null for a themeId ref whose theme is not in the library', async () => {
			const backend = makeBackend([MIDNIGHT]);
			wireBackend(backend);
			backend.state.set(CH, {theme_id: MIDNIGHT.id, css: null});

			// Channel state loaded, library deliberately never loaded.
			await ChannelThemes.loadChannelState(CH);

			expect(ChannelThemes.getChannelState(CH)).toEqual({themeId: MIDNIGHT.id, css: null});
			expect(ChannelThemes.getThemeCss(CH)).toBeNull();
		});

		/**
		 * The server drops a cleared channel's row entirely, but a row with both columns null is still
		 * representable. Storing it as absent keeps one representation of "no theme", so the editor
		 * never has to test for both an absent entry and an all-null one.
		 */
		it('stores a server row with both themeId and css null as absent', async () => {
			const backend = makeBackend([MIDNIGHT]);
			wireBackend(backend);
			backend.state.set(CH, {theme_id: null, css: null});

			await ChannelThemes.loadChannelState(CH);

			expect(ChannelThemes.getChannelState(CH)).toBeNull();
			expect(ChannelThemes.getThemeCss(CH)).toBeNull();
		});
	});

	describe('library mutations', () => {
		/**
		 * The reason a channel stores a reference rather than a copy: overwriting a named theme has to
		 * reach every channel using it without touching any channel row. Two channels, because a
		 * single one cannot distinguish "propagated" from "this channel happened to be rewritten".
		 */
		it('a theme overwrite propagates to every channel referencing it', async () => {
			await loadWith([MIDNIGHT, DAYLIGHT]);
			await ChannelThemes.applyTheme(CH, MIDNIGHT.id);
			await ChannelThemes.applyTheme(CH_B, MIDNIGHT.id);
			expect(ChannelThemes.writeError).toBeNull();

			const rewritten = ':root { --background-primary: #123456; }';
			expect(await ChannelThemes.updateTheme(MIDNIGHT.id, {css: rewritten})).toBe(true);

			expect(ChannelThemes.getThemeCss(CH)).toBe(rewritten);
			expect(ChannelThemes.getThemeCss(CH_B)).toBe(rewritten);
			// No channel row was rewritten to carry the new CSS — they still hold the reference.
			expect(ChannelThemes.getChannelState(CH)).toEqual({themeId: MIDNIGHT.id, css: null});
		});

		it('a rename leaves the CSS, and channels, untouched', async () => {
			await loadWith([MIDNIGHT]);
			await ChannelThemes.applyTheme(CH, MIDNIGHT.id);

			expect(await ChannelThemes.updateTheme(MIDNIGHT.id, {name: 'midnight-v2'})).toBe(true);

			expect(ChannelThemes.getTheme(MIDNIGHT.id)?.name).toBe('midnight-v2');
			expect(ChannelThemes.getTheme(MIDNIGHT.id)?.css).toBe(MIDNIGHT.css);
			expect(ChannelThemes.getThemeCss(CH)).toBe(MIDNIGHT.css);
		});

		it('createTheme adds to the library and returns the created entry', async () => {
			await loadWith([]);

			const created = await ChannelThemes.createTheme('fresh', ':root { --x: 1; }');

			expect(created?.name).toBe('fresh');
			expect(ChannelThemes.getTheme(created?.id as string)?.css).toBe(':root { --x: 1; }');
			expect(ChannelThemes.themes.map((theme) => theme.name)).toEqual(['fresh']);
		});

		it('a duplicate name is reported as a write error, not added', async () => {
			await loadWith([MIDNIGHT]);

			expect(await ChannelThemes.createTheme('midnight', ':root {}')).toBeNull();

			expect(ChannelThemes.writeError).toBeInstanceOf(HttpError);
			expect(ChannelThemes.themes).toHaveLength(1);
		});

		it('exposes the library name-sorted for the picker', async () => {
			await loadWith([MIDNIGHT, DAYLIGHT]);
			expect(ChannelThemes.themes.map((theme) => theme.name)).toEqual(['daylight', 'midnight']);
		});
	});

	describe('deleteTheme', () => {
		/**
		 * The blocked delete is the one error path with a payload the caller must act on: the editor
		 * resolves these IDs to channel names for the confirmation dialog. Swallowing it into writeError
		 * like every other failure would leave the dialog with nothing to name.
		 */
		it('surfaces channelIds on a 409 and keeps the theme in the library', async () => {
			await loadWith([MIDNIGHT]);
			await ChannelThemes.applyTheme(CH, MIDNIGHT.id);
			expect(ChannelThemes.writeError).toBeNull();

			const result = await ChannelThemes.deleteTheme(MIDNIGHT.id);

			expect(result).toEqual({ok: false, channelIds: [CH]});
			expect(ChannelThemes.getTheme(MIDNIGHT.id)).not.toBeNull();
			// A refusal is a normal outcome the caller handles, not a failure to report separately.
			expect(ChannelThemes.writeError).toBeNull();
		});

		it('reports every blocking channel, not just the first', async () => {
			await loadWith([MIDNIGHT]);
			await ChannelThemes.applyTheme(CH, MIDNIGHT.id);
			await ChannelThemes.applyTheme(CH_B, MIDNIGHT.id);

			const result = await ChannelThemes.deleteTheme(MIDNIGHT.id);

			expect(result).toEqual({ok: false, channelIds: [CH, CH_B]});
		});

		it('removes an unreferenced theme from the library', async () => {
			await loadWith([MIDNIGHT]);

			expect(await ChannelThemes.deleteTheme(MIDNIGHT.id)).toEqual({ok: true});

			expect(ChannelThemes.getTheme(MIDNIGHT.id)).toBeNull();
			expect(ChannelThemes.themes).toHaveLength(0);
		});

		it('succeeds once the blocking channel is cleared', async () => {
			await loadWith([MIDNIGHT]);
			await ChannelThemes.applyTheme(CH, MIDNIGHT.id);
			expect(await ChannelThemes.deleteTheme(MIDNIGHT.id)).toEqual({ok: false, channelIds: [CH]});

			expect(await ChannelThemes.clearChannelTheme(CH)).toBe(true);

			expect(await ChannelThemes.deleteTheme(MIDNIGHT.id)).toEqual({ok: true});
		});
	});

	describe('clearChannelTheme', () => {
		it('removes the entry so the channel reads as unthemed', async () => {
			await loadWith([MIDNIGHT]);
			await ChannelThemes.saveAndApply(CH, ':root { --x: 1; }');
			expect(ChannelThemes.getThemeCss(CH)).not.toBeNull();

			expect(await ChannelThemes.clearChannelTheme(CH)).toBe(true);

			expect(ChannelThemes.writeError).toBeNull();
			expect(ChannelThemes.getThemeCss(CH)).toBeNull();
			expect(ChannelThemes.getChannelState(CH)).toBeNull();
		});

		it('leaves other channels alone', async () => {
			await loadWith([MIDNIGHT]);
			await ChannelThemes.applyTheme(CH, MIDNIGHT.id);
			await ChannelThemes.saveAndApply(CH_B, ':root { --y: 2; }');

			await ChannelThemes.clearChannelTheme(CH);

			expect(ChannelThemes.getThemeCss(CH)).toBeNull();
			expect(ChannelThemes.getThemeCss(CH_B)).toBe(':root { --y: 2; }');
		});
	});

	/**
	 * The two writes are the only way a channel's kind changes, and each must clear the other column.
	 * Asserted through the store rather than the fake so a store that echoed its own request instead of
	 * the server's response would fail here.
	 */
	describe('mutual exclusivity across transitions', () => {
		it('a raw blob over an existing theme ref clears the ref', async () => {
			await loadWith([MIDNIGHT]);
			await ChannelThemes.applyTheme(CH, MIDNIGHT.id);

			await ChannelThemes.saveAndApply(CH, ':root { --x: 1; }');

			expect(ChannelThemes.getChannelState(CH)).toEqual({themeId: null, css: ':root { --x: 1; }'});
		});

		it('a theme ref over an existing raw blob clears the blob', async () => {
			await loadWith([MIDNIGHT]);
			await ChannelThemes.saveAndApply(CH, ':root { --x: 1; }');

			await ChannelThemes.applyTheme(CH, MIDNIGHT.id);

			expect(ChannelThemes.getChannelState(CH)).toEqual({themeId: MIDNIGHT.id, css: null});
			expect(ChannelThemes.getThemeCss(CH)).toBe(MIDNIGHT.css);
		});
	});
});

/**
 * `ensureLibraryLoaded` latches on a private flag that survives for the life of the singleton, and
 * ChannelThemes exposes no reset. These cases therefore need a genuinely fresh instance, which
 * `vi.resetModules()` provides — but it also re-runs the mock factory, so the commands module has to
 * be re-imported alongside the store or the test would install its implementation on a different
 * mock object than the fresh store calls.
 */
describe('ChannelThemes — ensureLibraryLoaded dedup', () => {
	async function freshStore() {
		vi.resetModules();
		const commands = await import('@app/features/channel/commands/ChannelCommands');
		const {default: store} = await import('@app/features/channel/state/ChannelThemes');
		// `vi.resetModules()` gives a fresh store instance but NOT fresh mocks — the factory's vi.fn()s
		// survive it, so call history carries over from every earlier test in the file. Verified
		// directly: across a reset the store instance differs while the mock function is identical.
		// Clearing here is what makes the absolute call counts below mean what they say.
		vi.clearAllMocks();
		vi.mocked(commands.fetchChannelThemes).mockResolvedValue([]);
		return {store, commands};
	}

	it('fetches exactly once across concurrent calls', async () => {
		const {store, commands} = await freshStore();

		// Both start before either resolves — the in-flight guard, not the loaded flag, is what has to
		// hold here. A store that only checked the loaded flag would fetch twice.
		await Promise.all([store.ensureLibraryLoaded(), store.ensureLibraryLoaded()]);

		expect(commands.fetchChannelThemes).toHaveBeenCalledTimes(1);
	});

	it('does not fetch again on a repeat call after the load completes', async () => {
		const {store, commands} = await freshStore();
		await store.ensureLibraryLoaded();
		expect(commands.fetchChannelThemes).toHaveBeenCalledTimes(1);

		// Channel mounts are frequent; a second mount must cost nothing.
		await store.ensureLibraryLoaded();
		await store.ensureLibraryLoaded();

		expect(commands.fetchChannelThemes).toHaveBeenCalledTimes(1);
	});

	/**
	 * A failed load must not latch, or one transient error would leave the library empty for the whole
	 * session and every themed channel rendering unstyled until a reload.
	 */
	it('retries after a failed load', async () => {
		const {store, commands} = await freshStore();
		vi.mocked(commands.fetchChannelThemes).mockRejectedValueOnce(new Error('network'));

		await store.ensureLibraryLoaded();
		expect(store.libraryError).toBeInstanceOf(Error);

		await store.ensureLibraryLoaded();

		expect(commands.fetchChannelThemes).toHaveBeenCalledTimes(2);
		expect(store.libraryError).toBeNull();
	});

	it('dedups per channel for channel state', async () => {
		const {store, commands} = await freshStore();
		vi.mocked(commands.fetchChannelAppearance).mockResolvedValue({
			channel_id: CH,
			theme_id: null,
			theme_name: null,
			css: null,
			resolved_css: null,
			updated_at: null,
		});

		await Promise.all([store.ensureChannelStateLoaded(CH), store.ensureChannelStateLoaded(CH)]);
		await store.ensureChannelStateLoaded(CH);
		// A different channel is a separate load, not covered by the first one's latch.
		await store.ensureChannelStateLoaded(CH_B);

		expect(commands.fetchChannelAppearance).toHaveBeenCalledTimes(2);
	});
});
