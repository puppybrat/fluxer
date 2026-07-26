// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/cast/commands/CastCommands', () => ({
	getGuildCast: vi.fn(),
}));

import * as CastCommands from '@app/features/cast/commands/CastCommands';
import {useInCharacterOverride} from '@app/features/cast/hooks/useInCharacterOverride';
import {useMultiCharacterHeads} from '@app/features/cast/hooks/useMultiCharacterHeads';
import GuildCastDisplay from '@app/features/cast/state/GuildCastDisplay';
import type {Message} from '@app/features/messaging/models/MessagingMessage';
import {renderToStaticMarkup} from 'react-dom/server';

const GUILD = 'g1';
const CHANNEL = 'c1';

const character = (id: string, name: string) => ({
	id,
	owner: 1,
	name,
	nickname: null,
	alias: null,
	ship: null,
	pfp_url: null,
	reference_image_url: null,
});

const resolvedRow = (id: string, name: string) => ({
	character_id: id,
	is_primary: false,
	nickname: name,
	pfp_url: null,
	reference_image_url: null,
});

/** Serves a cast containing exactly the given characters, as the API would for guild and channel. */
function serveCast(ids: Array<[string, string]>): void {
	vi.mocked(CastCommands.getGuildCast).mockImplementation(
		async () =>
			({
				characters: ids.map(([id, name]) => character(id, name)),
				primaries: [],
				categories: [],
				overrides: [],
				resolved_cast: ids.map(([id, name]) => resolvedRow(id, name)),
			}) as never,
	);
}

/** A message frozen at send time with the given attributed character ids. Never rewritten. */
const messageWith = (ids: Array<string>) =>
	({
		ic: true,
		castCharacterIds: ids,
		channelId: CHANNEL,
		guildId: GUILD,
	}) as unknown as Message;

/**
 * Renders both head hooks exactly as UserMessage does and reports which layout they select. Going
 * through React (rather than calling the hooks directly) keeps useMemo real, so a stale memo would
 * show up here the same way it would in the app.
 */
function renderLayout(message: Message): {layout: string; names: Array<string>} {
	let result: {layout: string; names: Array<string>} = {layout: 'unset', names: []};
	function Probe() {
		const single = useInCharacterOverride(message, GUILD);
		const multi = useMultiCharacterHeads(message, GUILD);
		result = multi
			? {layout: 'multi', names: multi.map((head) => head.displayName)}
			: single
				? {layout: 'single', names: [single.displayName]}
				: {layout: 'sender', names: []};
		return null;
	}
	renderToStaticMarkup(<Probe />);
	return result;
}

async function loadCast(ids: Array<[string, string]>): Promise<void> {
	serveCast(ids);
	await GuildCastDisplay.refresh(GUILD);
	await GuildCastDisplay.refreshChannel(GUILD, CHANNEL);
}

describe('in-character head layout follows the RESOLVED character count', () => {
	beforeEach(async () => {
		GuildCastDisplay.reset();
		vi.mocked(CastCommands.getGuildCast).mockReset();
		serveCast([
			['ch1', 'Rowan'],
			['ch2', 'Sable'],
		]);
		await GuildCastDisplay.ensureLoaded(GUILD);
		await GuildCastDisplay.ensureChannelLoaded(GUILD, CHANNEL);
	});

	it('renders multi layout while both characters resolve', () => {
		expect(renderLayout(messageWith(['ch1', 'ch2']))).toEqual({layout: 'multi', names: ['Rowan', 'Sable']});
	});

	it('collapses to single layout when one is removed from the cast', async () => {
		const message = messageWith(['ch1', 'ch2']);
		expect(renderLayout(message).layout).toBe('multi');

		// The stored ids stay frozen at two — only the cast changes, exactly as a removal does.
		await loadCast([['ch1', 'Rowan']]);

		expect(message.castCharacterIds).toEqual(['ch1', 'ch2']); // never rewritten; no resave involved
		expect(renderLayout(message)).toEqual({layout: 'single', names: ['Rowan']});
	});

	it('falls back to the sender when none of them resolve', async () => {
		const message = messageWith(['ch1', 'ch2']);
		await loadCast([['ch9', 'Someone else']]);

		expect(renderLayout(message)).toEqual({layout: 'sender', names: []});
	});

	it('keeps multi layout when a third is removed but two remain', async () => {
		const message = messageWith(['ch1', 'ch2', 'ch3']);
		await loadCast([
			['ch1', 'Rowan'],
			['ch2', 'Sable'],
		]);

		expect(renderLayout(message)).toEqual({layout: 'multi', names: ['Rowan', 'Sable']});
	});

	it('never renders multi and single at the same time', async () => {
		for (const ids of [['ch1'], ['ch1', 'ch2'], ['ch1', 'ch9'], ['ch8', 'ch9']]) {
			const {layout} = renderLayout(messageWith(ids));
			expect(['multi', 'single', 'sender']).toContain(layout);
		}
	});
});
