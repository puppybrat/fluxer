// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it, vi} from 'vitest';

// Routes.ts pulls in marketingUrl -> RuntimeConfig, which reads runtime env at import time and is
// unrelated to the path helpers under test. Stubbing just that keeps this a real test of Routes.
vi.mock('@app/features/messaging/utils/MessagingUrlUtils', () => ({
	marketingUrl: (path: string) => `https://example.invalid/${path}`,
}));

const {Routes} = await import('@app/app/Routes');

const GUILD = '1517785346346057728';

/**
 * The cast page is a sibling of the members page under /channels/:guildId, so it shares that
 * route's shape and — critically — must not be mistaken for a channel id by anything that parses
 * the path segment after the guild.
 */
describe('guild cast route', () => {
	it('sits alongside the members route under the same guild prefix', () => {
		expect(Routes.guildCast(GUILD)).toBe(`/channels/${GUILD}/cast`);
		expect(Routes.guildMembers(GUILD)).toBe(`/channels/${GUILD}/members`);
	});

	it('is textually identical to a channel path whose id is "cast" — hence route order matters', () => {
		// This is not a bug: channel ids are snowflakes, never the word "cast". But it does mean
		// channelRoute's ':channelId' pattern WOULD match /cast, so castRoute has to be registered
		// ahead of channelRoute in the route tree, exactly as membersRoute already is.
		expect(Routes.guildChannel(GUILD, 'cast')).toBe(Routes.guildCast(GUILD));
	});

	it('yields the segment the sidebar checks for selection state', () => {
		const prefix = `/channels/${GUILD}/`;
		const tail = Routes.guildCast(GUILD).slice(prefix.length);
		const slash = tail.indexOf('/');
		expect(slash === -1 ? tail : tail.slice(0, slash)).toBe('cast');
	});

	it('keeps the members segment intact, since that route is still reachable', () => {
		const prefix = `/channels/${GUILD}/`;
		expect(Routes.guildMembers(GUILD).slice(prefix.length)).toBe('members');
	});
});
