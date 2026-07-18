// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CastCategory, CastCharacter, CastPrimary} from '@app/features/cast/commands/CastCommands';
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
	private activeLoadToken = 0;

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

	isPrimary(characterId: string): boolean {
		return this.primaries.some((primary) => primary.character_id === characterId && primary.is_primary);
	}

	reset(): void {
		this.activeLoadToken += 1;
		this.characters = [];
		this.primaries = [];
		this.categories = [];
		this.loading = false;
		this.error = null;
	}
}

export default new Cast();
