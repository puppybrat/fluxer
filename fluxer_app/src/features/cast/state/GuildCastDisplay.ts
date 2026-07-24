// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CastCharacter} from '@app/features/cast/commands/CastCommands';
import * as CastCommands from '@app/features/cast/commands/CastCommands';
import {makeAutoObservable, runInAction} from 'mobx';

export interface CastDisplayIdentity {
	name: string;
	avatarUrl: string | null;
}

export interface CastDisplayCharacter {
	id: string;
	name: string;
	avatarUrl: string | null;
}

/**
 * Per-guild cast lookup for rendering in-character messages.
 *
 * Deliberately separate from the Cast store, which the settings tab owns and resets on close:
 * the message list needs this data to outlive that lifecycle, and needs it keyed by guild
 * because several guilds can be rendered across a session. Loading is per-guild and happens
 * once on channel mount rather than lazily per message, so a message cannot render as its
 * sender and then visibly flip to a character once a fetch lands.
 *
 * Holds only what display needs. Primaries and categories are the settings tab's business.
 */
class GuildCastDisplay {
	private readonly byGuild = new Map<string, Map<string, CastDisplayIdentity>>();
	private readonly inFlight = new Set<string>();

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	/**
	 * Fetches a guild's cast once. Repeat calls while a request is outstanding, or after one
	 * has completed, are no-ops — channel mounts are frequent and this must not re-fetch on
	 * every one. A failure leaves the guild unloaded so a later mount can retry.
	 */
	async ensureLoaded(guildId: string): Promise<void> {
		if (this.byGuild.has(guildId) || this.inFlight.has(guildId)) {
			return;
		}
		this.inFlight.add(guildId);
		try {
			const cast = await CastCommands.getGuildCast(guildId);
			runInAction(() => {
				this.byGuild.set(guildId, buildIdentityMap(cast.characters));
			});
		} catch {
			// Swallowed on purpose: a cast lookup failing must never break message rendering.
			// Unresolved characters fall back to the real sender, which is the same path an
			// unknown character takes.
		} finally {
			runInAction(() => {
				this.inFlight.delete(guildId);
			});
		}
	}

	/**
	 * The identity to render for a character, or null when it cannot be resolved — including
	 * when the guild is not loaded yet, or the character was removed from the cast after a
	 * message was attributed to it. Null means "render the real sender".
	 */
	getIdentity(guildId: string | undefined, characterId: string): CastDisplayIdentity | null {
		if (!guildId) {
			return null;
		}
		return this.byGuild.get(guildId)?.get(characterId) ?? null;
	}

	/**
	 * Every loaded character for a guild, for the "From character" search picker. Empty until the
	 * guild's cast has loaded (ensureLoaded) or when the guild has no cast configured.
	 */
	listCharacters(guildId: string | undefined): Array<CastDisplayCharacter> {
		if (!guildId) {
			return [];
		}
		const map = this.byGuild.get(guildId);
		if (!map) {
			return [];
		}
		return Array.from(map, ([id, identity]) => ({id, name: identity.name, avatarUrl: identity.avatarUrl}));
	}

	reset(): void {
		this.byGuild.clear();
		this.inFlight.clear();
	}
}

function buildIdentityMap(characters: ReadonlyArray<CastCharacter>): Map<string, CastDisplayIdentity> {
	const map = new Map<string, CastDisplayIdentity>();
	for (const character of characters) {
		// Same precedence the cast tab uses: a nickname is what this guild calls the character,
		// so it wins over the real name. Falls back to the id so there is always something.
		const name = character.nickname ?? character.name ?? character.id;
		map.set(character.id, {name, avatarUrl: character.pfp_url ?? null});
	}
	return map;
}

export default new GuildCastDisplay();
