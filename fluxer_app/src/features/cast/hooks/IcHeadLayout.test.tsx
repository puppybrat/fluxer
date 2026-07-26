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

/**
 * Serves a cast as the API does. `roster` is the guild-wide characters list; `resolved` is the
 * channel's effective cast. They differ for an EXCLUDED character: the API keeps it in the roster
 * (it is still in the guild's cast) but drops it from resolved_cast for that channel. Removing a
 * character instead drops it from both. Defaults to the two agreeing.
 */
function serveCast(roster: Array<[string, string]>, resolved: Array<[string, string]> = roster): void {
	vi.mocked(CastCommands.getGuildCast).mockImplementation(
		async () =>
			({
				characters: roster.map(([id, name]) => character(id, name)),
				primaries: [],
				categories: [],
				overrides: [],
				resolved_cast: resolved.map(([id, name]) => resolvedRow(id, name)),
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

async function loadCast(roster: Array<[string, string]>, resolved: Array<[string, string]> = roster): Promise<void> {
	serveCast(roster, resolved);
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

	it('collapses to single layout when one is EXCLUDED at this scope', async () => {
		const message = messageWith(['ch1', 'ch2']);
		expect(renderLayout(message).layout).toBe('multi');

		// Exclusion, not removal: ch2 stays in the guild roster but drops out of this channel's
		// effective cast. It is no longer resolvable HERE, so it must behave exactly like a removal.
		await loadCast(
			[
				['ch1', 'Rowan'],
				['ch2', 'Sable'],
			],
			[['ch1', 'Rowan']],
		);

		expect(renderLayout(message)).toEqual({layout: 'single', names: ['Rowan']});
	});

	it('falls back to the sender when all are excluded at this scope', async () => {
		const message = messageWith(['ch1', 'ch2']);
		await loadCast(
			[
				['ch1', 'Rowan'],
				['ch2', 'Sable'],
			],
			[],
		);

		expect(renderLayout(message)).toEqual({layout: 'sender', names: []});
	});

	it('still shows a character before the channel cast has loaded', async () => {
		// The guild-identity fallback exists to avoid a sender -> character flash in the window before
		// a channel's resolved_cast arrives. Only the channel load is skipped here, so absence must be
		// read as "unknown yet", not as "excluded".
		GuildCastDisplay.reset();
		serveCast([
			['ch1', 'Rowan'],
			['ch2', 'Sable'],
		]);
		await GuildCastDisplay.ensureLoaded(GUILD);

		expect(renderLayout(messageWith(['ch1', 'ch2']))).toEqual({layout: 'multi', names: ['Rowan', 'Sable']});
	});

	it('applies an exclusion written at a CATEGORY scope to the channels under it', async () => {
		// The Cast tab is shared by channel and category settings, and refreshes "the scope that was
		// edited". A category is never itself rendering a message list, so refreshing only the edited
		// scope leaves the real channels underneath holding stale identities.
		const message = messageWith(['ch1', 'ch2']);
		expect(renderLayout(message).layout).toBe('multi');

		serveCast(
			[
				['ch1', 'Rowan'],
				['ch2', 'Sable'],
			],
			[['ch1', 'Rowan']],
		);
		// Exactly what ChannelCast.runWrite does after a write, with the edited scope being a category.
		await GuildCastDisplay.refresh(GUILD);
		await GuildCastDisplay.refreshGuildChannels(GUILD);

		expect(renderLayout(message)).toEqual({layout: 'single', names: ['Rowan']});
	});

	it('never renders multi and single at the same time', async () => {
		for (const ids of [['ch1'], ['ch1', 'ch2'], ['ch1', 'ch9'], ['ch8', 'ch9']]) {
			const {layout} = renderLayout(messageWith(ids));
			expect(['multi', 'single', 'sender']).toContain(layout);
		}
	});
});
