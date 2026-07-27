// SPDX-License-Identifier: AGPL-3.0-or-later

import {characterProfileUrl, slugifyCharacterName} from '@app/features/cast/utils/CharacterSlug';
import {describe, expect, it} from 'vitest';

/**
 * The personal site's `characters/app/common/slugify.js`, reproduced verbatim from
 * https://obyr.us/characters/app/common/slugify.js as fetched on 2026-07-27.
 *
 * Kept here as the differential oracle: the port is only correct insofar as it agrees with this, so
 * the suite compares the two over a corpus rather than asserting hand-written expectations that
 * could encode the same mistake twice. If the site changes, re-fetch and update this copy — a
 * failure here means generated /c/:slug links have started 404ing.
 */
function referenceSlugify(str: string): string {
	str = str.normalize('NFD').replace(/[̀-ͯ]/g, '');
	str = str.replace(/'/g, '');
	str = str.replace(/[^a-zA-Z0-9]+/g, '-');
	str = str.replace(/^-+|-+$/g, '');
	str = str.toLowerCase();
	return str;
}

const CORPUS = [
	// Plain and multi-word.
	'Rowan',
	'rowan',
	'Rowan Blackwood',
	'  Rowan   Blackwood  ',
	// Apostrophes: ASCII is stripped, typographic is not (it becomes a hyphen).
	"O'Brien",
	'O’Brien',
	"D'Artagnan de la Fère",
	// Accents that decompose under NFD. "Renée" is the one accented name on the real roster.
	'Renée',
	'Zoë',
	'Zoë O’Brien',
	'José Álvarez',
	'Ægir',
	// Characters with no NFD decomposition — these survive to the hyphen rule.
	'Søren',
	'Straße',
	// Punctuation, symbols and digits.
	'Mira-7',
	'Mira_7',
	'Captain (Ret.) Vex',
	'A.B.C.',
	'!!!',
	'---',
	'-Vex-',
	'#1 Fan',
	'Rowan & Mira',
	'Rowan/Mira',
	// Non-Latin scripts reduce to nothing once non-alphanumerics are stripped.
	'カムイ',
	'Кира',
	// Edge cases.
	'',
	' ',
	'a',
];

describe('slugifyCharacterName', () => {
	it.each(CORPUS)('matches the site reference for %j', (name) => {
		expect(slugifyCharacterName(name)).toBe(referenceSlugify(name));
	});

	/**
	 * Pinned separately from the differential check so the intended behaviour is readable, and so a
	 * matching pair of mistakes in port AND oracle would still be caught here.
	 */
	/** Taken from the live roster (29 characters), so this is a link that has to work in practice. */
	it('slugs the real accented name on the roster', () => {
		expect(slugifyCharacterName('Renée')).toBe('renee');
		expect(characterProfileUrl('Renée')).toBe('https://obyr.us/c/renee');
	});

	it('produces the documented slugs', () => {
		expect(slugifyCharacterName('Rowan')).toBe('rowan');
		expect(slugifyCharacterName("Zoë O'Brien")).toBe('zoe-obrien');
		expect(slugifyCharacterName('Rowan Blackwood')).toBe('rowan-blackwood');
		expect(slugifyCharacterName('Mira-7')).toBe('mira-7');
	});

	it('trims leading and trailing hyphens rather than leaving them', () => {
		// The step most easily missed when porting from prose; a stray dash breaks the site's lookup.
		expect(slugifyCharacterName('-Vex-')).toBe('vex');
		expect(slugifyCharacterName('Captain (Ret.) Vex')).toBe('captain-ret-vex');
	});

	it('strips only the ASCII apostrophe, exactly as the site does', () => {
		expect(slugifyCharacterName("O'Brien")).toBe('obrien');
		// U+2019 is not stripped; it is a non-alphanumeric and becomes a hyphen.
		expect(slugifyCharacterName('O’Brien')).toBe('o-brien');
	});

	it('collapses a run of non-alphanumerics into a single hyphen', () => {
		expect(slugifyCharacterName('Rowan   &&&   Mira')).toBe('rowan-mira');
	});

	it('reduces a name with no alphanumerics to the empty string', () => {
		expect(slugifyCharacterName('!!!')).toBe('');
		expect(slugifyCharacterName('カムイ')).toBe('');
	});
});

describe('characterProfileUrl', () => {
	it('builds the site profile link', () => {
		expect(characterProfileUrl('Rowan')).toBe('https://obyr.us/c/rowan');
		expect(characterProfileUrl("Zoë O'Brien")).toBe('https://obyr.us/c/zoe-obrien');
	});

	/**
	 * The overview falls back to the character id when the roster carries no name. Linking to a slug
	 * built from an id would be a confident link to a page that cannot exist, so there is no link.
	 */
	it('returns null when there is no usable name', () => {
		expect(characterProfileUrl(null)).toBeNull();
		expect(characterProfileUrl(undefined)).toBeNull();
		expect(characterProfileUrl('')).toBeNull();
		expect(characterProfileUrl('!!!')).toBeNull();
		expect(characterProfileUrl('カムイ')).toBeNull();
	});
});
