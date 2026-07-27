// SPDX-License-Identifier: AGPL-3.0-or-later

import ComposerInCharacter from '@app/features/cast/state/ComposerInCharacter';
import GuildCastDisplay from '@app/features/cast/state/GuildCastDisplay';
import {makeAutoObservable} from 'mobx';

/**
 * Bumped after every successful cast write, whichever scope or surface issued it.
 *
 * Some surfaces hold their OWN copy of a guild's cast rather than reading a store — the Cast
 * Overview takes one unscoped read per mount, deliberately, so the whole tree costs one request —
 * and they have no other way to learn that a write landed. Observing this counter lets them refetch
 * without each write path having to know who is listening.
 */
class CastWriteSignal {
	version = 0;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	bump(): void {
		this.version += 1;
	}
}

export const castWriteSignal = new CastWriteSignal();

/**
 * Refreshes every cache that renders cast identity, after a write at any scope.
 *
 * Extracted so `Cast`, `ChannelCast` and the Cast Overview cannot drift apart: CastWriteRefresh.test.tsx
 * pins that an open message list updates without a reload, and it only does so because ALL of these
 * run. Fire-and-forget by design — a write must not block on them.
 *
 * - `GuildCastDisplay.refresh` — the guild-level identity map the search pickers read.
 * - `GuildCastDisplay.refreshGuildChannels` — every tracked channel's own map. Needed even for a
 *   server-scope write, because a channel's loaded cast is authoritative for its message list
 *   (getChannelIdentity) and the resolution walk starts at the server scope. Needed for a CATEGORY
 *   write too, since a category is never itself tracked.
 * - `ComposerInCharacter.refresh` — the composer's optimistic primary resolution, or the next send
 *   flashes the previous primary until the server's MESSAGE_UPDATE corrects it.
 */
export function refreshCastDisplayCaches(guildId: string): void {
	void GuildCastDisplay.refresh(guildId);
	void GuildCastDisplay.refreshGuildChannels(guildId);
	void ComposerInCharacter.refresh(guildId);
	castWriteSignal.bump();
}
