// SPDX-License-Identifier: AGPL-3.0-or-later

import GuildCastDisplay from '@app/features/cast/state/GuildCastDisplay';
import {useEffect} from 'react';

/**
 * Loads one channel's resolved cast, so its in-character messages render with the nickname and avatar
 * that apply there instead of the guild-wide identity.
 *
 * GuildChannelView does this for the channel in view. The desktop thread side panel renders a thread
 * next to its parent without mounting a GuildChannelView for it, so it calls this for the thread (step
 * 5a, D4). The server resolves a thread through thread -> parent -> categories, so the thread shows
 * the cast its parent chain gives it. A failed load falls back to the guild identity.
 */
export function useChannelCastDisplay(guildId: string | null | undefined, channelId: string): void {
	useEffect(() => {
		if (!guildId) return;
		void GuildCastDisplay.ensureChannelLoaded(guildId, channelId);
	}, [guildId, channelId]);
}
