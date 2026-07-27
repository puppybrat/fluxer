// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it, vi} from 'vitest';

// Routes pulls in marketingUrl, which reaches the runtime config and throws without the bootstrap
// the proxy injects. Stubbed so the real Routes.guildCast can still be asserted against — the point
// of importing it here is to check the entry's ACTUAL navigation target, not a copy of it.
vi.mock('@app/features/messaging/utils/MessagingUrlUtils', () => ({marketingUrl: () => ''}));

import {Routes} from '@app/app/Routes';
import {
	asGuildPageSegment,
	GUILD_PAGE_SEGMENTS,
	getGuildChannelSegment,
	getGuildPathSegment,
	isGuildPageRoute,
	showsGuildContent,
} from '@app/features/navigation/utils/GuildRouteSegments';

const GUILD = '1517785346346057728';
const CHANNEL = '1524705144518737920';
const OTHER_GUILD = '1525755266912485376';

describe('guild route segments', () => {
	it('covers both guild-level pages', () => {
		expect([...GUILD_PAGE_SEGMENTS]).toEqual(['members', 'cast']);
	});

	it('reads the segment after the guild', () => {
		expect(getGuildPathSegment(`/channels/${GUILD}/cast`, GUILD)).toBe('cast');
		expect(getGuildPathSegment(`/channels/${GUILD}/members`, GUILD)).toBe('members');
		expect(getGuildPathSegment(`/channels/${GUILD}/${CHANNEL}`, GUILD)).toBe(CHANNEL);
	});

	it('ignores trailing path parts, such as a message id', () => {
		expect(getGuildPathSegment(`/channels/${GUILD}/${CHANNEL}/123456`, GUILD)).toBe(CHANNEL);
	});

	it('returns null at the guild root and for another guild', () => {
		expect(getGuildPathSegment(`/channels/${GUILD}`, GUILD)).toBeNull();
		expect(getGuildPathSegment(`/channels/${GUILD}/`, GUILD)).toBeNull();
		expect(getGuildPathSegment(`/channels/${OTHER_GUILD}/cast`, GUILD)).toBeNull();
	});

	/** The bug: these routes have no :channelId, so a channelId-only check renders nothing. */
	it('recognises the guild pages, which carry no channel id', () => {
		expect(isGuildPageRoute(`/channels/${GUILD}/cast`, GUILD)).toBe(true);
		expect(isGuildPageRoute(`/channels/${GUILD}/members`, GUILD)).toBe(true);
	});

	it('does not mistake a channel for a guild page', () => {
		expect(isGuildPageRoute(`/channels/${GUILD}/${CHANNEL}`, GUILD)).toBe(false);
		expect(isGuildPageRoute(`/channels/${GUILD}`, GUILD)).toBe(false);
	});

	it('does not treat a page segment as a channel id', () => {
		expect(getGuildChannelSegment(`/channels/${GUILD}/cast`, GUILD)).toBeNull();
		expect(getGuildChannelSegment(`/channels/${GUILD}/members`, GUILD)).toBeNull();
		expect(getGuildChannelSegment(`/channels/${GUILD}/${CHANNEL}`, GUILD)).toBe(CHANNEL);
	});

	it('narrows raw segments correctly', () => {
		expect(asGuildPageSegment('cast')).toBe('cast');
		expect(asGuildPageSegment('members')).toBe('members');
		expect(asGuildPageSegment(CHANNEL)).toBeNull();
		expect(asGuildPageSegment(null)).toBeNull();
	});

	it('is scoped to the guild it is asked about', () => {
		// A pathname under a different guild must never read as this guild's page, or the layout
		// would render one guild's page inside another's shell.
		expect(isGuildPageRoute(`/channels/${OTHER_GUILD}/cast`, GUILD)).toBe(false);
		expect(isGuildPageRoute(`/channels/${OTHER_GUILD}/cast`, OTHER_GUILD)).toBe(true);
	});

	/**
	 * The exact decision GuildLayout's mobile branch makes. Before the fix it was Boolean(channelId)
	 * alone, so the two guild pages — which have no :channelId — rendered the channel list instead.
	 */
	describe('mobile content decision', () => {
		it('shows content for the cast page, which has no channel id', () => {
			expect(showsGuildContent(`/channels/${GUILD}/cast`, GUILD, undefined)).toBe(true);
		});

		it('shows content for the members page, which has no channel id', () => {
			expect(showsGuildContent(`/channels/${GUILD}/members`, GUILD, undefined)).toBe(true);
		});

		it('still shows content for a normal channel (regression)', () => {
			expect(showsGuildContent(`/channels/${GUILD}/${CHANNEL}`, GUILD, CHANNEL)).toBe(true);
		});

		it('still shows content for a channel deep-linked to a message (regression)', () => {
			expect(showsGuildContent(`/channels/${GUILD}/${CHANNEL}/999`, GUILD, CHANNEL)).toBe(true);
		});

		it('still falls back to the channel list at the guild root (regression)', () => {
			expect(showsGuildContent(`/channels/${GUILD}`, GUILD, undefined)).toBe(false);
			expect(showsGuildContent(`/channels/${GUILD}/`, GUILD, undefined)).toBe(false);
		});

		it("does not show another guild's page inside this guild", () => {
			expect(showsGuildContent(`/channels/${OTHER_GUILD}/cast`, GUILD, undefined)).toBe(false);
		});

		it('is path-driven, so every navigation path behaves identically', () => {
			// Settings modal, guild header menu and the sidebar all end at the same transitionTo, so
			// they cannot diverge here — the decision sees only the resulting pathname.
			const fromAnyPath = `/channels/${GUILD}/cast`;
			expect(showsGuildContent(fromAnyPath, GUILD, undefined)).toBe(true);
			expect(showsGuildContent(fromAnyPath, GUILD, null)).toBe(true);
		});
	});

	/**
	 * The sidebar's pinned Cast entry is not platform-gated: the same list is the desktop sidebar and
	 * the mobile "no channel selected" screen, so tapping the entry there has to land on the Cast page
	 * rather than fall back to the channel list.
	 *
	 * Built from Routes.guildCast rather than a hand-written path, so the entry's REAL navigation
	 * target is what gets checked — if that route string ever moves, this fails instead of quietly
	 * testing a path nothing navigates to.
	 */
	describe('the sidebar Cast entry, which mobile now shows too', () => {
		const castPath = Routes.guildCast(GUILD);

		it('targets the route the layout recognises as guild content', () => {
			expect(castPath).toBe(`/channels/${GUILD}/cast`);
			// No :channelId on this route — the exact condition that used to render the channel list.
			expect(showsGuildContent(castPath, GUILD, undefined)).toBe(true);
		});

		it('leaves no channel looking selected in the list behind it', () => {
			expect(getGuildChannelSegment(castPath, GUILD)).toBeNull();
			expect(asGuildPageSegment(getGuildPathSegment(castPath, GUILD))).toBe('cast');
		});

		/**
		 * The entry uses the same transitionTo as a channel tap, and a channel tap still has to behave
		 * exactly as before — this is the regression the un-gating could plausibly cause.
		 */
		it('does not disturb ordinary channel selection', () => {
			const channelPath = Routes.guildChannel(GUILD, CHANNEL);
			expect(showsGuildContent(channelPath, GUILD, CHANNEL)).toBe(true);
			expect(getGuildChannelSegment(channelPath, GUILD)).toBe(CHANNEL);
			expect(asGuildPageSegment(getGuildPathSegment(channelPath, GUILD))).toBeNull();
		});

		/** Identical to the guild-header-menu path, because both resolve to the same pathname. */
		it('is indistinguishable from the guild-header-menu route', () => {
			expect(Routes.guildCast(GUILD)).toBe(castPath);
			expect(showsGuildContent(castPath, GUILD, undefined)).toBe(
				showsGuildContent(`/channels/${GUILD}/cast`, GUILD, undefined),
			);
		});
	});
});
