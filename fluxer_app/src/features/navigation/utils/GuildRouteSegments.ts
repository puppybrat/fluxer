// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Guild routes whose path segment sits where a channel id normally would, but which address a
 * guild-level PAGE that replaces the channel view rather than a channel.
 *
 * These exist because `/channels/:guildId/:channelId` and `/channels/:guildId/members` are the same
 * shape — anything parsing the segment after the guild has to know which of the two it is holding,
 * or it will treat "members" as a channel id (or, worse, decide no channel is selected and render
 * nothing). Keeping the list here means the router, the sidebar and the layout all agree; when the
 * next such page is added, this is the only list to extend.
 */
export const GUILD_PAGE_SEGMENTS = ['members', 'cast'] as const;

export type GuildPageSegment = (typeof GUILD_PAGE_SEGMENTS)[number];

/**
 * The path segment directly after `/channels/:guildId`, or null when the pathname is not under that
 * guild (or is the guild root, which selects no channel and no page).
 */
export function getGuildPathSegment(pathname: string, guildId: string): string | null {
	const prefix = `/channels/${guildId}/`;
	if (!pathname.startsWith(prefix)) {
		return null;
	}
	const tail = pathname.slice(prefix.length);
	const slash = tail.indexOf('/');
	const segment = slash === -1 ? tail : tail.slice(0, slash);
	return segment.length > 0 ? segment : null;
}

/** Narrows a raw segment to a guild page, or null when it is a channel id (or absent). */
export function asGuildPageSegment(segment: string | null): GuildPageSegment | null {
	if (segment == null) {
		return null;
	}
	return (GUILD_PAGE_SEGMENTS as ReadonlyArray<string>).includes(segment) ? (segment as GuildPageSegment) : null;
}

/**
 * Whether this pathname addresses a guild-level page rather than a channel.
 *
 * The mobile layout needs this because it otherwise decides what to render purely from the presence
 * of a `:channelId` route param, which these routes do not have — leaving it convinced nothing is
 * selected and falling back to the channel list.
 */
export function isGuildPageRoute(pathname: string, guildId: string): boolean {
	return asGuildPageSegment(getGuildPathSegment(pathname, guildId)) != null;
}

/** The channel id in this pathname, or null when it addresses a guild page or no channel at all. */
export function getGuildChannelSegment(pathname: string, guildId: string): string | null {
	const segment = getGuildPathSegment(pathname, guildId);
	return segment != null && asGuildPageSegment(segment) == null ? segment : null;
}

/**
 * Whether the guild's main content area has something to show — the exact decision the mobile layout
 * makes between rendering a page and falling back to the channel list.
 *
 * Lives here, beside the segment parsing it depends on, so the decision is testable without mounting
 * GuildLayout and so the sidebar and the layout share one definition of "a guild page is open".
 */
export function showsGuildContent(pathname: string, guildId: string, channelId: string | null | undefined): boolean {
	return Boolean(channelId) || isGuildPageRoute(pathname, guildId);
}
