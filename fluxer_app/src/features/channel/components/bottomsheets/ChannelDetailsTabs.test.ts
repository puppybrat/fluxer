// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	CHANNEL_DETAILS_TAB_ORDER,
	isChannelDetailsTabAvailable,
	resolveDefaultChannelDetailsTab,
} from '@app/features/channel/components/bottomsheets/ChannelDetailsTabs';
import {describe, expect, it} from 'vitest';

describe('channel details tabs', () => {
	it('puts Cast first, keeping Members and Pins as siblings', () => {
		expect(CHANNEL_DETAILS_TAB_ORDER).toEqual(['cast', 'members', 'pins']);
	});

	it('does not drop Members or Pins', () => {
		// The mobile sheet gains Cast; unlike desktop's side panel, it does not replace Members.
		expect(CHANNEL_DETAILS_TAB_ORDER).toContain('members');
		expect(CHANNEL_DETAILS_TAB_ORDER).toContain('pins');
	});

	it('defaults a guild channel to Cast', () => {
		expect(resolveDefaultChannelDetailsTab('1517785346346057728')).toBe('cast');
	});

	it('defaults a DM to Members, since a DM has no cast', () => {
		expect(resolveDefaultChannelDetailsTab(null)).toBe('members');
		expect(resolveDefaultChannelDetailsTab(undefined)).toBe('members');
	});

	it('offers Cast only where a guild exists', () => {
		expect(isChannelDetailsTabAvailable('cast', '123')).toBe(true);
		expect(isChannelDetailsTabAvailable('cast', null)).toBe(false);
	});

	it('always offers Members and Pins, guild or not', () => {
		for (const guildId of ['123', null]) {
			expect(isChannelDetailsTabAvailable('members', guildId)).toBe(true);
			expect(isChannelDetailsTabAvailable('pins', guildId)).toBe(true);
		}
	});

	it('keeps arrow-key navigation consistent with the rendered order', () => {
		// handleTabKeyDown walks CHANNEL_DETAILS_TAB_ORDER by index, so every tab must appear exactly
		// once or navigation would skip or repeat one.
		expect(new Set(CHANNEL_DETAILS_TAB_ORDER).size).toBe(CHANNEL_DETAILS_TAB_ORDER.length);
	});
});
