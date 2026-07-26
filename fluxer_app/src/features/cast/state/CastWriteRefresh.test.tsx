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
// Stubbed only because resolving a real one needs Authentication and the owner-accounts route; this
// suite is about the DISPLAY caches. GuildCastDisplay is deliberately NOT mocked — it is the subject.
vi.mock('@app/features/cast/state/ComposerInCharacter', () => ({default: {refresh: vi.fn()}}));

import * as CastCommands from '@app/features/cast/commands/CastCommands';
import {useInCharacterOverride} from '@app/features/cast/hooks/useInCharacterOverride';
import Cast from '@app/features/cast/state/Cast';
import ChannelCast from '@app/features/cast/state/ChannelCast';
import GuildCastDisplay from '@app/features/cast/state/GuildCastDisplay';
import type {Message} from '@app/features/messaging/models/MessagingMessage';
import {renderToStaticMarkup} from 'react-dom/server';

const GUILD = 'g1';
const CHANNEL = 'c1';
const CHARACTER = 'ch1';
const REAL_NAME = 'Rowan';

/**
 * A stateful fake of the personal-site cast tables, mutated by the write commands as the real backend
 * does. Only what this suite exercises: one character, and nickname overrides at the server scope
 * (what the guild Cast tab writes) and the channel scope (what the channel/category tab writes).
 *
 * getGuildCast projects for the queried scope: `characters[].nickname` carries the SERVER-scope
 * override (the guild-wide view), while `resolved_cast[].nickname` carries the server -> channel walk,
 * which is what a message actually renders through.
 */
function makeBackend() {
	const nicknameByScope = new Map<string | null, string | null>();
	return {
		setNickname(scope: string | null, nickname: string | null): void {
			nicknameByScope.set(scope, nickname);
		},
		project(scope: string | null) {
			const serverNickname = nicknameByScope.get(null) ?? null;
			// The walk: a channel-scope nickname wins over the server one, which wins over unset.
			const resolvedNickname = (scope != null ? nicknameByScope.get(scope) : null) ?? serverNickname;
			return {
				characters: [
					{
						id: CHARACTER,
						name: REAL_NAME,
						alias: null,
						ship: null,
						owner: 1,
						nickname: serverNickname,
						pfp_url: null,
						reference_image_url: null,
					},
				],
				primaries: [],
				categories: [],
				overrides: [],
				resolved_cast: [
					{
						character_id: CHARACTER,
						is_primary: false,
						nickname: resolvedNickname,
						pfp_url: null,
						reference_image_url: null,
					},
				],
			};
		},
	};
}

function wireBackend(backend: ReturnType<typeof makeBackend>): void {
	vi.mocked(CastCommands.getGuildCast).mockImplementation(async (_g, ch) => backend.project(ch ?? null) as never);
	vi.mocked(CastCommands.updateOverride).mockImplementation(async (_g, _id, update) => {
		backend.setNickname(update.channelId ?? null, update.nickname ?? null);
		return {} as never;
	});
}

const message = {
	ic: true,
	castCharacterIds: [CHARACTER],
	channelId: CHANNEL,
	guildId: GUILD,
} as unknown as Message;

/** What the message list actually shows for this message, via the real hook and a real render. */
function renderedName(): string {
	let name = 'sender';
	function Probe() {
		const identity = useInCharacterOverride(message, GUILD);
		name = identity ? identity.displayName : 'sender';
		return null;
	}
	renderToStaticMarkup(<Probe />);
	return name;
}

/**
 * Drains pending microtasks. runWrite fires its display-cache refreshes with `void` (deliberately, so
 * the write does not block on them), so the test must let them land before asserting.
 */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

/** Exactly what ChannelChatLayout does on mount: the channel being viewed becomes tracked. */
async function openChannel(): Promise<void> {
	await GuildCastDisplay.ensureLoaded(GUILD);
	await GuildCastDisplay.ensureChannelLoaded(GUILD, CHANNEL);
}

describe('a cast write refreshes the caches the message list renders from', () => {
	let backend: ReturnType<typeof makeBackend>;

	beforeEach(() => {
		vi.clearAllMocks();
		GuildCastDisplay.reset();
		Cast.reset();
		ChannelCast.reset();
		backend = makeBackend();
		wireBackend(backend);
	});

	it('reflects a GUILD-scope nickname edit live, without a reload', async () => {
		await openChannel();
		expect(renderedName()).toBe(REAL_NAME);

		// The guild Cast tab's edit path: CastEditOverrideModal with no channelId calls Cast.updateOverride.
		await Cast.load(GUILD);
		await Cast.updateOverride(GUILD, CHARACTER, {nickname: 'Rowan the Brave'});
		await settle();

		// The server now says "Rowan the Brave" for this channel — a reload would show it.
		expect((await CastCommands.getGuildCast(GUILD, CHANNEL)).resolved_cast?.[0]?.nickname).toBe('Rowan the Brave');
		// So the open message list must show it too.
		expect(renderedName()).toBe('Rowan the Brave');
	});

	it('reflects a CHANNEL-scope nickname edit live, without a reload', async () => {
		await openChannel();
		expect(renderedName()).toBe(REAL_NAME);

		// The channel/category Cast tab's edit path.
		await ChannelCast.load(GUILD, CHANNEL);
		await ChannelCast.updateOverride(CHARACTER, {nickname: 'Rowan of C1'});
		await settle();

		expect(renderedName()).toBe('Rowan of C1');
	});

	it('reflects a GUILD-scope edit in the guild-level identity map too', async () => {
		await openChannel();

		await Cast.load(GUILD);
		await Cast.updateOverride(GUILD, CHARACTER, {nickname: 'Rowan the Brave'});
		await settle();

		// The search pickers (CharacterFilterSheet, message-search autocomplete) read this map, not the
		// channel one, so it has to move as well.
		expect(GuildCastDisplay.getIdentity(GUILD, CHARACTER)?.name).toBe('Rowan the Brave');
		expect(GuildCastDisplay.listCharacters(GUILD).map((c) => c.name)).toEqual(['Rowan the Brave']);
	});
});
