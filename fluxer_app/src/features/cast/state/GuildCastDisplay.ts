// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CastCharacter, CastOverrideRow} from '@app/features/cast/commands/CastCommands';
import * as CastCommands from '@app/features/cast/commands/CastCommands';
import {makeAutoObservable, runInAction} from 'mobx';

export interface CastDisplayIdentity {
	name: string;
	avatarUrl: string | null;
	/** The per-guild reference image, or null. Shown when an in-character avatar is tapped. */
	referenceImageUrl: string | null;
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
	// Raw per-scope override rows per guild, stored alongside the flattened identity map. Not
	// consumed yet — held so the future server -> category -> channel resolution walk has the
	// per-scope data it needs; this plumbing change only stops it being dropped.
	private readonly overridesByGuild = new Map<string, ReadonlyArray<CastOverrideRow>>();
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
				this.overridesByGuild.set(guildId, cast.overrides);
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

	/**
	 * Forces a re-fetch of a guild's cast, replacing the cached identities in place. Called after a
	 * cast write (add/remove/override/primary) so open message lists pick up a newly added character
	 * or a changed pfp without a reload — ensureLoaded alone cannot, as it deliberately no-ops once a
	 * guild is loaded. Errors are swallowed: a failed refresh leaves the last-known identities, the
	 * same non-breaking fallback ensureLoaded takes.
	 */
	async refresh(guildId: string): Promise<void> {
		try {
			const cast = await CastCommands.getGuildCast(guildId);
			runInAction(() => {
				this.byGuild.set(guildId, buildIdentityMap(cast.characters));
				this.overridesByGuild.set(guildId, cast.overrides);
			});
		} catch {
			// Swallowed on purpose: a failed refresh must never break the write flow or rendering.
		}
	}

	/**
	 * The raw per-scope override rows for a guild (server/category/channel), or empty when unloaded.
	 * Exposed as-is for the future resolution walk; nothing resolves or merges them here yet.
	 */
	getOverrides(guildId: string | undefined): ReadonlyArray<CastOverrideRow> {
		if (!guildId) {
			return [];
		}
		return this.overridesByGuild.get(guildId) ?? [];
	}

	reset(): void {
		this.byGuild.clear();
		this.overridesByGuild.clear();
		this.inFlight.clear();
	}
}

function buildIdentityMap(characters: ReadonlyArray<CastCharacter>): Map<string, CastDisplayIdentity> {
	const map = new Map<string, CastDisplayIdentity>();
	for (const character of characters) {
		// Same precedence the cast tab uses: a nickname is what this guild calls the character,
		// so it wins over the real name. Falls back to the id so there is always something.
		const name = character.nickname ?? character.name ?? character.id;
		map.set(character.id, {
			name,
			avatarUrl: character.pfp_url ?? null,
			referenceImageUrl: character.reference_image_url ?? null,
		});
	}
	return map;
}

export default new GuildCastDisplay();
