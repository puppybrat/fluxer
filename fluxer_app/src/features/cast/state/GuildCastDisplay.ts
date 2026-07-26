// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CastCharacter, CastOverrideRow} from '@app/features/cast/commands/CastCommands';
import * as CastCommands from '@app/features/cast/commands/CastCommands';
import type {CastResolvedCharacterResponseType} from '@fluxer/schema/src/domains/cast/CastSchemas';
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
	// Channel-scoped identities, keyed by the message's channel id, built from that channel's
	// resolved_cast (the server -> category -> channel walk). A character present here renders with
	// its effective per-channel nickname/pfp; anything not present falls back to the guild identity.
	private readonly byChannel = new Map<string, Map<string, CastDisplayIdentity>>();
	private readonly channelInFlight = new Set<string>();

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
	 * Fetches one channel's effective cast (resolved_cast) once, so messages in that channel render
	 * with their channel/category-scoped nickname and pfp rather than the guild-wide identity. Deduped
	 * per channel like ensureLoaded; a failure leaves the channel unloaded so a later mount retries and
	 * getChannelIdentity simply falls back to the guild identity in the meantime.
	 */
	async ensureChannelLoaded(guildId: string, channelId: string): Promise<void> {
		if (this.byChannel.has(channelId) || this.channelInFlight.has(channelId)) {
			return;
		}
		this.channelInFlight.add(channelId);
		try {
			const cast = await CastCommands.getGuildCast(guildId, channelId);
			runInAction(() => {
				this.byChannel.set(channelId, buildChannelIdentityMap(cast.resolved_cast ?? [], cast.characters));
			});
		} catch {
			// Swallowed on purpose: same non-breaking fallback as ensureLoaded — rendering drops to the
			// guild identity (or the real sender) rather than failing.
		} finally {
			runInAction(() => {
				this.channelInFlight.delete(channelId);
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
	 * The identity to render for a character in a specific channel: the channel's effective (walked)
	 * identity when the character is present there, otherwise the guild-wide identity. The fallback
	 * covers a character excluded from the channel after a message was attributed to it, and the window
	 * before the channel's cast has loaded — in both cases a sensible guild identity shows, never a gap.
	 */
	getChannelIdentity(
		guildId: string | undefined,
		channelId: string | undefined,
		characterId: string,
	): CastDisplayIdentity | null {
		if (channelId) {
			const channelIdentity = this.byChannel.get(channelId)?.get(characterId);
			if (channelIdentity) {
				return channelIdentity;
			}
		}
		return this.getIdentity(guildId, characterId);
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
	 * Re-fetches one channel's effective cast after a scoped cast write, so an open message list in
	 * that channel picks up a new channel/category override without a reload. Only refreshes a channel
	 * already tracked — an untracked one has nothing rendering against it and loads lazily on mount.
	 */
	async refreshChannel(guildId: string, channelId: string): Promise<void> {
		if (!this.byChannel.has(channelId)) {
			return;
		}
		try {
			const cast = await CastCommands.getGuildCast(guildId, channelId);
			runInAction(() => {
				this.byChannel.set(channelId, buildChannelIdentityMap(cast.resolved_cast ?? [], cast.characters));
			});
		} catch {
			// Swallowed on purpose: a failed refresh leaves the last-known channel identities.
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
		this.byChannel.clear();
		this.channelInFlight.clear();
	}
}

/**
 * Builds a channel's identity map from its resolved_cast (the effective per-field walk) plus the base
 * character names, which resolved_cast does not carry. Name precedence mirrors the guild map: the
 * resolved (channel/category/server) nickname wins, then the real name, then the id. pfp and reference
 * come straight from resolved_cast, which has already merged the scopes per field.
 */
function buildChannelIdentityMap(
	resolved: ReadonlyArray<CastResolvedCharacterResponseType>,
	characters: ReadonlyArray<CastCharacter>,
): Map<string, CastDisplayIdentity> {
	const baseNameById = new Map(characters.map((character) => [character.id, character.name]));
	const map = new Map<string, CastDisplayIdentity>();
	for (const row of resolved) {
		const name = row.nickname ?? baseNameById.get(row.character_id) ?? row.character_id;
		map.set(row.character_id, {
			name,
			avatarUrl: row.pfp_url ?? null,
			referenceImageUrl: row.reference_image_url ?? null,
		});
	}
	return map;
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
