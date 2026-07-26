// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelDetailsTab} from '@app/features/channel/components/bottomsheets/ChannelDetailsBottomSheetTypes';

/**
 * Tab order for the channel details sheet, left to right — also the order arrow-key navigation walks.
 *
 * Cast leads because this sheet is the mobile home of the Cast Overview, mirroring how the desktop
 * Cast Overview took over the Members side-panel slot. Members and Pins remain as siblings; mobile
 * never had the "replace Members outright" decision applied to it.
 */
export const CHANNEL_DETAILS_TAB_ORDER: ReadonlyArray<ChannelDetailsTab> = ['cast', 'members', 'pins'];

/**
 * The tab to open on when the caller does not name one.
 *
 * Cast is guild data, so it can only lead in a guild channel. A DM has no cast at all, so it keeps
 * Members — what the sheet showed before the Cast tab existed.
 */
export function resolveDefaultChannelDetailsTab(guildId: string | null | undefined): ChannelDetailsTab {
	return guildId != null ? 'cast' : 'members';
}

/** Whether a tab can be shown for this channel. Only Cast is conditional; it needs a guild. */
export function isChannelDetailsTabAvailable(tab: ChannelDetailsTab, guildId: string | null | undefined): boolean {
	return tab === 'cast' ? guildId != null : true;
}
