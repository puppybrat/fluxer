// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
	CastCategory,
	CastCharacter,
	CastOverrideRow,
	CastOverrideUpdate,
	CastPrimary,
} from '@app/features/cast/commands/CastCommands';
import * as CastCommands from '@app/features/cast/commands/CastCommands';
import {refreshCastDisplayCaches} from '@app/features/cast/state/CastDisplayRefresh';
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
 * Which roster characters a picker may offer, given the rows already on screen.
 *
 * `inheritedCountsAsPresent` is the whole difference between the two picker rules: a surface that
 * LISTS inherited rows has already handled them and must not offer them again, while a surface that
 * shows local rows only needs the picker as the one way to pull an inherited character local.
 *
 * Deliberately a module-level function rather than a private method: `makeAutoObservable` annotates
 * prototype methods as actions, and an action untracks its observable reads — calling one from a
 * computed getter would sever that getter's dependency on `rows` and stop the picker updating.
 */
function offerableCharacters(
	allCharacters: ReadonlyArray<CastCharacter>,
	rows: ReadonlyArray<CastScopedRow>,
	inheritedCountsAsPresent: boolean,
): Array<CastCharacter> {
	const blockedIds = new Set(
		rows
			.filter((row) => inheritedCountsAsPresent || row.status !== 'inherited')
			.map((row) => row.character.id),
	);
	return allCharacters.filter((character) => !blockedIds.has(character.id));
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

	/**
	 * Whether a row's channel_id identifies THIS exact scope. A server-wide row (channel_id null) is
	 * never local — and the `this.channelId != null` guard is load-bearing: without it, a null scope
	 * would make `null === null` true and every server membership read as local, inverting the tab
	 * (inherited characters would vanish from the Add picker while excluded ones would reappear in it).
	 */
	private isLocalRow(channelId: string | null): boolean {
		return this.channelId != null && channelId === this.channelId;
	}

	/** character_ids with a primaries row at THIS exact scope — i.e. decided locally. */
	private get localPrimaryIds(): Set<string> {
		return new Set(
			this.primaries.filter((primary) => this.isLocalRow(primary.channel_id)).map((primary) => primary.character_id),
		);
	}

	/** override rows at THIS exact scope, keyed by character_id. */
	private get localOverridesByCharacterId(): Map<string, CastOverrideRow> {
		return new Map(
			this.overrides
				.filter((override) => this.isLocalRow(override.channel_id))
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
			if (this.isLocalRow(override.channel_id) && override.excluded && !resolvedIds.has(override.character_id)) {
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
	 * The picker offers only characters that are FULLY absent here — neither present (local or
	 * inherited) nor excluded. Every character already shown as a row is handled from its row instead:
	 * a present one via Edit/Primary (which silently takes local control of an inherited one) or
	 * Exclude/Remove, an excluded one via Un-exclude. Derived from `rows` so the two cannot disagree.
	 *
	 * This is the rule for the settings Cast tab, which lists inherited rows itself. A surface that
	 * shows LOCAL rows only wants `locallyAddableCharacters` instead.
	 */
	get addableCharacters(): Array<CastCharacter> {
		return offerableCharacters(this.allCharacters, this.rows, true);
	}

	/**
	 * The same picker, for a surface that renders only what this scope decides ITSELF — the Cast
	 * Overview. There an inherited character has no row at all, so the picker is the only way to pull
	 * it into local view, which is what must happen before it can be excluded or overridden here.
	 *
	 * Locally-present characters are still withheld, excluded ones included: an excluded character
	 * does have a local row and does show on that surface, so offering it again would be a second,
	 * worse way to un-exclude it.
	 */
	get locallyAddableCharacters(): Array<CastCharacter> {
		return offerableCharacters(this.allCharacters, this.rows, false);
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
			// Every display cache that renders cast identity, refreshed in one place so this path and
			// Cast's cannot drift. Notably this refreshes every tracked channel, not just the edited
			// scope — a category is never itself tracked, so refreshing only it would leave the channels
			// beneath it still showing a character just excluded from them.
			refreshCastDisplayCaches(guildId);
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

	/**
	 * Add a character locally at this scope (gives it a local presence row).
	 *
	 * The resolved primacy is captured BEFORE the add and restored after, because `add_to_cast`
	 * creates the membership row at is_primary=0 — and since character_primaries is both the
	 * membership table and the primacy flag, that row would shadow a broader scope's is_primary=1
	 * for the rest of the walk. Taking local control must change who decides, not what resolves.
	 *
	 * Deliberately does NOT touch the deliberate-demotion path: setPrimary(false) here still pins
	 * a character as non-primary at this scope while it stays primary server-wide, which is a real
	 * feature (see CastResolution.test.ts, 'resolves a top-level channel ... skipping the category
	 * hop'). Only the DEFAULT that a bare add lands on is corrected.
	 *
	 * LIMITATION — not atomic: the personal site exposes membership and primacy as two writes, so a
	 * failed follow-up leaves the character added but demoted. runWrite surfaces that as a write
	 * error and the reload shows the true state, so it is visible rather than silent, and re-adding
	 * is idempotent. The correct long-term model is a tri-state is_primary (NULL = no local opinion,
	 * distinguishing "explicitly not primary here" from "inherit"), which would make the default
	 * non-shadowing at the data layer and remove the second write entirely. That is a schema and
	 * wire-contract change on the personal site; not worth it for a single client, but it is the
	 * shape to reach for if this deployment ever grows a second real one.
	 */
	async addLocal(characterId: string): Promise<boolean> {
		const wasPrimaryHere = this.resolvedCast.some(
			(resolved) => resolved.character_id === characterId && resolved.is_primary,
		);
		return this.runWrite(characterId, async () => {
			await CastCommands.addCharacter(this.guildId as string, characterId, this.channelId);
			if (wasPrimaryHere) {
				await CastCommands.setPrimary(this.guildId as string, characterId, true, this.channelId);
			}
		});
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
