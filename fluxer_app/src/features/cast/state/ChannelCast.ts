// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
	CastCategory,
	CastCharacter,
	CastOverrideRow,
	CastOverrideUpdate,
	CastPrimary,
} from '@app/features/cast/commands/CastCommands';
import * as CastCommands from '@app/features/cast/commands/CastCommands';
import ComposerInCharacter from '@app/features/cast/state/ComposerInCharacter';
import GuildCastDisplay from '@app/features/cast/state/GuildCastDisplay';
import type {CastResolvedCharacterResponseType} from '@fluxer/schema/src/domains/cast/CastSchemas';
import {makeAutoObservable, runInAction} from 'mobx';

/**
 * Where a character stands at ONE specific scope (a category's own channel id, or a channel's own
 * id), relative to what it inherits from broader scopes:
 * - `local`     — decided here: a primaries row exists at this exact scope. Editable/removable here.
 * - `inherited` — present only because a broader scope (parent category or server) provides it.
 *                 Not editable here until it is either added locally or excluded.
 * - `excluded`  — a local excluded override hides it here, overriding whatever a broader scope says.
 */
export type CastScopeStatus = 'local' | 'inherited' | 'excluded';

export interface CastScopedRow {
	character: CastCharacter;
	status: CastScopeStatus;
	/** Resolved primary status for this channel; only meaningful for local/inherited rows. */
	isPrimary: boolean;
	/** The effective nickname resolved for this channel (display only), null when unset. */
	resolvedNickname: string | null;
	/**
	 * The override row at THIS exact scope, or null when none exists locally. This — never the
	 * resolved/inherited values — is what the edit modal must pre-fill from: pre-filling from an
	 * inherited value and saving unchanged would silently promote it into a real local override.
	 */
	localOverride: {nickname: string | null; pfpUrl: string | null; referenceImageUrl: string | null} | null;
}

/**
 * The cast as seen from a single channel/category scope. Separate from the server-scoped `Cast`
 * singleton because its whole job is the per-scope inherited/local/excluded distinction that the
 * guild tab has no concept of. Only one settings modal is open at a time, so a singleton is safe.
 */
class ChannelCast {
	guildId: string | null = null;
	/** The scope these rows are resolved for: the id of the channel/category being edited. */
	channelId: string | null = null;

	characters: Array<CastCharacter> = [];
	primaries: Array<CastPrimary> = [];
	categories: Array<CastCategory> = [];
	overrides: Array<CastOverrideRow> = [];
	/** The effective cast resolved for this channel (present characters only), from the scoped read. */
	resolvedCast: Array<CastResolvedCharacterResponseType> = [];
	loading = false;
	error: unknown = null;

	/** The full roster for the add picker. Loaded on demand, not as part of load(). */
	allCharacters: Array<CastCharacter> = [];
	allCharactersLoading = false;
	allCharactersError: unknown = null;

	pendingCharacterIds = new Set<string>();
	writeError: unknown = null;

	private activeLoadToken = 0;
	private activeAllCharactersToken = 0;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	async load(guildId: string, channelId: string): Promise<void> {
		const loadToken = ++this.activeLoadToken;
		runInAction(() => {
			this.guildId = guildId;
			this.channelId = channelId;
			this.loading = true;
			this.error = null;
		});
		try {
			const result = await CastCommands.getGuildCast(guildId, channelId);
			runInAction(() => {
				if (loadToken !== this.activeLoadToken) {
					return;
				}
				this.characters = result.characters;
				this.primaries = result.primaries;
				this.categories = result.categories;
				this.overrides = result.overrides;
				this.resolvedCast = result.resolved_cast ?? [];
				this.loading = false;
			});
		} catch (error) {
			runInAction(() => {
				if (loadToken !== this.activeLoadToken) {
					return;
				}
				this.loading = false;
				this.error = error;
			});
		}
	}

	async loadAllCharacters(guildId: string): Promise<void> {
		const token = ++this.activeAllCharactersToken;
		runInAction(() => {
			this.allCharactersLoading = true;
			this.allCharactersError = null;
		});
		try {
			const characters = await CastCommands.getAllCharacters(guildId);
			runInAction(() => {
				if (token !== this.activeAllCharactersToken) {
					return;
				}
				this.allCharacters = characters;
				this.allCharactersLoading = false;
			});
		} catch (error) {
			runInAction(() => {
				if (token !== this.activeAllCharactersToken) {
					return;
				}
				this.allCharactersLoading = false;
				this.allCharactersError = error;
			});
		}
	}

	/** character_ids with a primaries row at THIS exact scope — i.e. decided locally. */
	private get localPrimaryIds(): Set<string> {
		return new Set(
			this.primaries.filter((primary) => primary.channel_id === this.channelId).map((primary) => primary.character_id),
		);
	}

	/** override rows at THIS exact scope, keyed by character_id. */
	private get localOverridesByCharacterId(): Map<string, CastOverrideRow> {
		return new Map(
			this.overrides
				.filter((override) => override.channel_id === this.channelId)
				.map((override) => [override.character_id, override]),
		);
	}

	/**
	 * The unified display list: every character present here (from resolved_cast) plus every
	 * character explicitly excluded here (which resolved_cast omits by definition), each tagged with
	 * its scope status. Sorted by display name so the order is stable across refetches.
	 */
	get rows(): Array<CastScopedRow> {
		const characterById = new Map(this.characters.map((character) => [character.id, character]));
		const localPrimaryIds = this.localPrimaryIds;
		const localOverrides = this.localOverridesByCharacterId;
		const fallbackCharacter = (id: string): CastCharacter => ({
			id,
			name: null,
			alias: null,
			ship: null,
			owner: null,
			nickname: null,
			pfp_url: null,
			reference_image_url: null,
		});
		const toLocalOverride = (override: CastOverrideRow | undefined): CastScopedRow['localOverride'] =>
			override == null
				? null
				: {
						nickname: override.nickname,
						pfpUrl: override.pfp_url,
						referenceImageUrl: override.reference_image_url,
					};

		const rows: Array<CastScopedRow> = [];
		const resolvedIds = new Set<string>();
		for (const resolved of this.resolvedCast) {
			resolvedIds.add(resolved.character_id);
			rows.push({
				character: characterById.get(resolved.character_id) ?? fallbackCharacter(resolved.character_id),
				status: localPrimaryIds.has(resolved.character_id) ? 'local' : 'inherited',
				isPrimary: resolved.is_primary,
				resolvedNickname: resolved.nickname,
				localOverride: toLocalOverride(localOverrides.get(resolved.character_id)),
			});
		}
		// Excluded-here characters never appear in resolved_cast (that is what excluded means), so
		// surface them from the local override rows directly, or the user could never un-hide them.
		for (const override of this.overrides) {
			if (override.channel_id === this.channelId && override.excluded && !resolvedIds.has(override.character_id)) {
				rows.push({
					character: characterById.get(override.character_id) ?? fallbackCharacter(override.character_id),
					status: 'excluded',
					isPrimary: false,
					resolvedNickname: null,
					localOverride: toLocalOverride(override),
				});
			}
		}
		rows.sort((a, b) => {
			const an = (a.character.name ?? a.character.id).toLowerCase();
			const bn = (b.character.name ?? b.character.id).toLowerCase();
			return an < bn ? -1 : an > bn ? 1 : 0;
		});
		return rows;
	}

	/**
	 * The picker offers the full roster minus what is already decided locally here. Inherited and
	 * excluded characters stay offered on purpose: adding an inherited one takes local control of it,
	 * and there is nothing to add for one already local at this scope.
	 */
	get addableCharacters(): Array<CastCharacter> {
		const localIds = this.localPrimaryIds;
		return this.allCharacters.filter((character) => !localIds.has(character.id));
	}

	isPending(characterId: string): boolean {
		return this.pendingCharacterIds.has(characterId);
	}

	private async runWrite(characterId: string, action: () => Promise<unknown>): Promise<boolean> {
		const guildId = this.guildId;
		const channelId = this.channelId;
		if (guildId == null || channelId == null) {
			return false;
		}
		runInAction(() => {
			this.pendingCharacterIds.add(characterId);
			this.writeError = null;
		});
		try {
			await action();
			await this.load(guildId, channelId);
			// Mirror the guild tab: message rendering and the composer's optimistic in-character
			// resolution both cache a guild's cast independently, so refresh them after any write.
			void GuildCastDisplay.refresh(guildId);
			void ComposerInCharacter.refresh(guildId);
			runInAction(() => {
				this.pendingCharacterIds.delete(characterId);
			});
			return true;
		} catch (error) {
			runInAction(() => {
				this.pendingCharacterIds.delete(characterId);
				this.writeError = error;
			});
			return false;
		}
	}

	/** Add a character locally at this scope (gives it a local presence row). */
	async addLocal(characterId: string): Promise<boolean> {
		return this.runWrite(characterId, () =>
			CastCommands.addCharacter(this.guildId as string, characterId, this.channelId),
		);
	}

	/** Remove a character's local rows at this scope; the backend cascade also drops its override. */
	async removeLocal(characterId: string): Promise<boolean> {
		return this.runWrite(characterId, () =>
			CastCommands.removeCharacter(this.guildId as string, characterId, this.channelId),
		);
	}

	async setPrimary(characterId: string, isPrimary: boolean): Promise<boolean> {
		return this.runWrite(characterId, () =>
			CastCommands.setPrimary(this.guildId as string, characterId, isPrimary, this.channelId),
		);
	}

	async updateOverride(characterId: string, update: CastOverrideUpdate): Promise<boolean> {
		return this.runWrite(characterId, () =>
			CastCommands.updateOverride(this.guildId as string, characterId, {...update, channelId: this.channelId}),
		);
	}

	/**
	 * Exclude an inherited character here. The backend rejects an override at a scope with no local
	 * membership (409), so this must add the local presence row first, then flag it excluded — two
	 * calls, one logical action.
	 */
	async exclude(characterId: string): Promise<boolean> {
		return this.runWrite(characterId, async () => {
			await CastCommands.addCharacter(this.guildId as string, characterId, this.channelId);
			await CastCommands.updateOverride(this.guildId as string, characterId, {
				channelId: this.channelId,
				excluded: true,
			});
		});
	}

	/**
	 * Un-exclude: drop the local rows the exclude created. The cascade removes both the presence row
	 * and the excluded override, so the character falls back to whatever broader scopes provide.
	 */
	async unexclude(characterId: string): Promise<boolean> {
		return this.runWrite(characterId, () =>
			CastCommands.removeCharacter(this.guildId as string, characterId, this.channelId),
		);
	}

	clearWriteError(): void {
		this.writeError = null;
	}

	reset(): void {
		this.activeLoadToken += 1;
		this.activeAllCharactersToken += 1;
		this.guildId = null;
		this.channelId = null;
		this.characters = [];
		this.primaries = [];
		this.categories = [];
		this.overrides = [];
		this.resolvedCast = [];
		this.allCharacters = [];
		this.loading = false;
		this.allCharactersLoading = false;
		this.error = null;
		this.allCharactersError = null;
		this.writeError = null;
		this.pendingCharacterIds = new Set<string>();
	}
}

export default new ChannelCast();
