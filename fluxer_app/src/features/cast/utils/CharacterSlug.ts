// SPDX-License-Identifier: AGPL-3.0-or-later

/** Where the personal site serves character profiles. `/c/:slug` is resolved by slugifying names. */
const CHARACTER_PROFILE_BASE = 'https://obyr.us/c';

/**
 * A faithful port of the personal site's own `characters/app/common/slugify.js`.
 *
 * Ported rather than reinvented because the site resolves `/c/:slug` by running THIS algorithm over
 * its own character names — any divergence produces a link that 404s. The steps, and their order,
 * mirror the original exactly, deliberately including the parts that look like oversights:
 *
 * - Only the ASCII apostrophe (U+0027) is stripped. A typographic `’` therefore falls through to the
 *   non-alphanumeric rule and becomes a hyphen, which is what the site does.
 * - The accent strip is NFD-then-drop-combining-marks, so it only removes accents that decompose.
 *   Characters with no decomposition (ø, ß) survive to the non-alphanumeric rule and become hyphens.
 *
 * Do not "improve" either without changing the site first, or the two stop agreeing.
 */
export function slugifyCharacterName(name: string): string {
	return name
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/'/g, '')
		.replace(/[^a-zA-Z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase();
}

/**
 * The public profile URL for a character, or null when there is no usable name to slug.
 *
 * Null rather than a link to an empty slug: the overview falls back to the character id when the
 * roster carries no name, and slugging an id would produce a confident link to a page that cannot
 * exist. Omitting the menu entry is the honest outcome.
 */
export function characterProfileUrl(name: string | null | undefined): string | null {
	if (name == null) {
		return null;
	}
	const slug = slugifyCharacterName(name);
	return slug === '' ? null : `${CHARACTER_PROFILE_BASE}/${slug}`;
}
