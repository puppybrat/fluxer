// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CastCategory, CastCharacter, CastOverrideUpdate, CastPrimary} from '@app/features/cast/commands/CastCommands';
import * as CastCommands from '@app/features/cast/commands/CastCommands';
import {makeAutoObservable, runInAction} from 'mobx';

class Cast {
	characters: Array<CastCharacter> = [];
	primaries: Array<CastPrimary> = [];
	categories: Array<CastCategory> = [];
	loading = false;
	/**
	 * The actual error, not a boolean. Cast reads cross a service boundary (Fluxer -> the
	 * personal site), so "unreachable" and "not permitted" are meaningfully different and
	 * the UI should be able to tell them apart.
	 */
	error: unknown = null;

	/** The full roster for the add picker. Loaded on demand, not as part of load(). */
	allCharacters: Array<CastCharacter> = [];
	allCharactersLoading = false;
	allCharactersError: unknown = null;

	/**
	 * Write state is tracked per character rather than as one global flag, so a slow remove
	 * on one row cannot make every other row appear busy. `writeError` stays global because
	 * only one write is initiated at a time from this UI.
	 */
	pendingCharacterIds = new Set<string>();
	writeError: unknown = null;

	private activeLoadToken = 0;
	private activeAllCharactersToken = 0;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	get hasLoaded(): boolean {
		return !this.loading && this.error == null;
	}

	/**
	 * Always refetches: the tab is expected to show current data every time it opens, and
	 * cast membership changes on the personal site out of band. The guild is an explicit
	 * argument rather than read from a selection singleton so the caller owns the scope.
	 */
	async load(guildId: string): Promise<void> {
		const loadToken = ++this.activeLoadToken;
		runInAction(() => {
			this.loading = true;
			this.error = null;
		});
		try {
			const result = await CastCommands.getGuildCast(guildId);
			runInAction(() => {
				if (loadToken !== this.activeLoadToken) {
					return;
				}
				this.characters = result.characters;
				this.primaries = result.primaries;
				this.categories = result.categories;
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

	/**
	 * Loads the full roster for the add picker. Kept separate from load() so opening the tab
	 * does not pay for data only the picker needs.
	 */
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
	 * Characters not yet in this guild's cast — what the picker offers. Derived rather than
	 * stored so it cannot drift from the two lists it depends on.
	 */
	get addableCharacters(): Array<CastCharacter> {
		const existing = new Set(this.characters.map((character) => character.id));
		return this.allCharacters.filter((character) => !existing.has(character.id));
	}

	isPrimary(characterId: string): boolean {
		return this.primaries.some((primary) => primary.character_id === characterId && primary.is_primary);
	}

	isPending(characterId: string): boolean {
		return this.pendingCharacterIds.has(characterId);
	}

	/**
	 * Every write funnels through here so the pending/error bookkeeping cannot drift between
	 * methods, and so each one refetches on success: the personal site owns the resulting
	 * state, and reconstructing it locally would be guessing at what it did.
	 */
	private async runWrite(guildId: string, characterId: string, action: () => Promise<unknown>): Promise<boolean> {
		runInAction(() => {
			this.pendingCharacterIds.add(characterId);
			this.writeError = null;
		});
		try {
			await action();
			await this.load(guildId);
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

	async addCharacter(guildId: string, characterId: string): Promise<boolean> {
		return this.runWrite(guildId, characterId, () => CastCommands.addCharacter(guildId, characterId));
	}

	async removeCharacter(guildId: string, characterId: string): Promise<boolean> {
		return this.runWrite(guildId, characterId, () => CastCommands.removeCharacter(guildId, characterId));
	}

	async updateOverride(guildId: string, characterId: string, update: CastOverrideUpdate): Promise<boolean> {
		return this.runWrite(guildId, characterId, () => CastCommands.updateOverride(guildId, characterId, update));
	}

	async setPrimary(guildId: string, characterId: string, isPrimary: boolean): Promise<boolean> {
		return this.runWrite(guildId, characterId, () => CastCommands.setPrimary(guildId, characterId, isPrimary));
	}

	clearWriteError(): void {
		this.writeError = null;
	}

	reset(): void {
		this.activeLoadToken += 1;
		this.activeAllCharactersToken += 1;
		this.characters = [];
		this.primaries = [];
		this.categories = [];
		this.allCharacters = [];
		this.loading = false;
		this.allCharactersLoading = false;
		this.error = null;
		this.allCharactersError = null;
		this.writeError = null;
		this.pendingCharacterIds = new Set<string>();
	}
}

export default new Cast();
