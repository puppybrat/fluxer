// SPDX-License-Identifier: AGPL-3.0-or-later

import * as ChannelCommands from '@app/features/channel/commands/ChannelCommands';
import {HttpError} from '@app/features/platform/types/EndpointError';
import {action, makeAutoObservable, runInAction} from 'mobx';

/** A named theme from the shared library. `updatedAt` is the ISO string the API serializes. */
export interface ChannelThemeLibraryEntry {
	id: string;
	name: string;
	css: string;
	updatedAt: string;
}

/**
 * A channel's active state. The two fields are mutually exclusive — the database enforces it with a
 * CHECK — so at most one is ever non-null. Both null means the channel was explicitly cleared.
 */
export interface ChannelThemeActiveState {
	themeId: string | null;
	css: string | null;
}

/** A blocked delete reports the channels still referencing the theme, for the caller to name. */
export type DeleteThemeResult = {ok: true} | {ok: false; channelIds: Array<string>};

/**
 * Resolves the CSS a channel should render, given its active state and the library.
 *
 * Deliberately a module-level pure function rather than a private method: `makeAutoObservable`
 * annotates prototype methods, and calling one from a computed getter would sever that getter's
 * dependency on the observable reads inside it. Keeping the resolution rule out here means it can be
 * reused from a getter or a method without that hazard.
 */
function resolveThemeCss(
	active: ChannelThemeActiveState | undefined,
	library: ReadonlyMap<string, ChannelThemeLibraryEntry>,
): string | null {
	if (!active) {
		return null;
	}
	// Raw blob wins when set; the two are mutually exclusive server-side, so the order is a
	// formality rather than a precedence rule.
	if (active.css != null) {
		return active.css;
	}
	if (active.themeId != null) {
		// Null while the library is still loading. The hook treats that as "no theme" and the channel
		// renders unstyled until the library lands, which is the correct transient state.
		return library.get(active.themeId)?.css ?? null;
	}
	return null;
}

/**
 * Channel theme state: the named theme library, and which theme (or raw CSS blob) each channel has
 * active.
 *
 * `getThemeCss` is the render path — `useChannelThemeStyle` in ChannelLayout calls it on every
 * channel mount and must get `null` for an unthemed channel, since null is what makes the hook a
 * no-op. Everything else here exists for the theme editor.
 */
class ChannelThemes {
	private readonly library = new Map<string, ChannelThemeLibraryEntry>();
	private readonly activeByChannelId = new Map<string, ChannelThemeActiveState>();

	libraryLoading = false;
	libraryError: unknown = null;
	writeError: unknown = null;

	private libraryLoaded = false;
	private libraryInFlight = false;
	private readonly channelsLoaded = new Set<string>();
	private readonly channelsInFlight = new Set<string>();

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	// --- reads -------------------------------------------------------------------------------

	getThemeCss(channelId: string): string | null {
		return resolveThemeCss(this.activeByChannelId.get(channelId), this.library);
	}

	getChannelState(channelId: string): ChannelThemeActiveState | null {
		return this.activeByChannelId.get(channelId) ?? null;
	}

	getTheme(themeId: string): ChannelThemeLibraryEntry | null {
		return this.library.get(themeId) ?? null;
	}

	/** The library as a list, name-sorted, for the editor's theme picker. */
	get themes(): Array<ChannelThemeLibraryEntry> {
		return [...this.library.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	// --- writes from outside the API path ----------------------------------------------------

	/**
	 * Sets a channel's CSS directly, without touching the server. Predates the API and is kept as-is:
	 * it writes a raw blob, matching what `save-and-apply` produces, and clears any theme reference so
	 * the local state cannot hold both.
	 */
	@action
	setThemeCss(channelId: string, css: string | null): void {
		if (css == null) {
			this.activeByChannelId.delete(channelId);
		} else {
			this.activeByChannelId.set(channelId, {themeId: null, css});
		}
	}

	// --- loading -----------------------------------------------------------------------------

	async loadLibrary(): Promise<void> {
		runInAction(() => {
			this.libraryLoading = true;
			this.libraryError = null;
		});
		try {
			const themes = await ChannelCommands.fetchChannelThemes();
			runInAction(() => {
				this.library.clear();
				for (const theme of themes) {
					this.library.set(theme.id, {
						id: theme.id,
						name: theme.name,
						css: theme.css,
						updatedAt: theme.updated_at,
					});
				}
				this.libraryLoaded = true;
				this.libraryLoading = false;
			});
		} catch (error) {
			runInAction(() => {
				this.libraryLoading = false;
				this.libraryError = error;
			});
		}
	}

	/**
	 * Loads the library at most once. Channel mounts are frequent and must not re-fetch on each one.
	 * A failure leaves it unloaded so a later mount retries.
	 */
	async ensureLibraryLoaded(): Promise<void> {
		if (this.libraryLoaded || this.libraryInFlight) {
			return;
		}
		this.libraryInFlight = true;
		try {
			await this.loadLibrary();
		} finally {
			runInAction(() => {
				this.libraryInFlight = false;
			});
		}
	}

	async loadChannelState(channelId: string): Promise<void> {
		try {
			const appearance = await ChannelCommands.fetchChannelAppearance(channelId);
			runInAction(() => {
				this.applyStateLocally(channelId, appearance.theme_id, appearance.css);
				this.channelsLoaded.add(channelId);
			});
		} catch (error) {
			// Swallowed like GuildCastDisplay's loads: a theme lookup failing must never break the
			// channel. The channel renders unthemed, which is the same path an untheme'd channel takes.
			runInAction(() => {
				this.writeError = error;
			});
		}
	}

	/** Loads one channel's active state at most once, deduped per channel. */
	async ensureChannelStateLoaded(channelId: string): Promise<void> {
		if (this.channelsLoaded.has(channelId) || this.channelsInFlight.has(channelId)) {
			return;
		}
		this.channelsInFlight.add(channelId);
		try {
			await this.loadChannelState(channelId);
		} finally {
			runInAction(() => {
				this.channelsInFlight.delete(channelId);
			});
		}
	}

	// --- library mutations -------------------------------------------------------------------

	async createTheme(name: string, css: string): Promise<ChannelThemeLibraryEntry | null> {
		runInAction(() => {
			this.writeError = null;
		});
		try {
			const created = await ChannelCommands.createChannelTheme(name, css);
			const entry: ChannelThemeLibraryEntry = {
				id: created.id,
				name: created.name,
				css: created.css,
				updatedAt: created.updated_at,
			};
			runInAction(() => {
				this.library.set(entry.id, entry);
			});
			return entry;
		} catch (error) {
			runInAction(() => {
				this.writeError = error;
			});
			return null;
		}
	}

	/**
	 * Overwrites a named theme. Every channel referencing it picks the new CSS up automatically, since
	 * they hold a reference rather than a copy and `getThemeCss` resolves through the library.
	 */
	async updateTheme(themeId: string, fields: {name?: string; css?: string}): Promise<boolean> {
		runInAction(() => {
			this.writeError = null;
		});
		try {
			const updated = await ChannelCommands.updateChannelTheme(themeId, fields);
			runInAction(() => {
				this.library.set(updated.id, {
					id: updated.id,
					name: updated.name,
					css: updated.css,
					updatedAt: updated.updated_at,
				});
			});
			return true;
		} catch (error) {
			runInAction(() => {
				this.writeError = error;
			});
			return false;
		}
	}

	/**
	 * Deletes a named theme. The server refuses while any channel references it; that 409 carries the
	 * blocking channel IDs, which are handed back rather than swallowed so the caller can confirm
	 * against real channel names.
	 */
	async deleteTheme(themeId: string): Promise<DeleteThemeResult> {
		runInAction(() => {
			this.writeError = null;
		});
		try {
			await ChannelCommands.deleteChannelTheme(themeId);
			runInAction(() => {
				this.library.delete(themeId);
			});
			return {ok: true};
		} catch (error) {
			const channelIds = blockedChannelIdsFrom(error);
			if (channelIds) {
				return {ok: false, channelIds};
			}
			runInAction(() => {
				this.writeError = error;
			});
			return {ok: false, channelIds: []};
		}
	}

	// --- per-channel mutations ---------------------------------------------------------------

	async applyTheme(channelId: string, themeId: string): Promise<boolean> {
		return this.runChannelWrite(channelId, async () => {
			const state = await ChannelCommands.applyChannelTheme(channelId, themeId);
			return {themeId: state.theme_id, css: state.css};
		});
	}

	async saveAndApply(channelId: string, css: string): Promise<boolean> {
		return this.runChannelWrite(channelId, async () => {
			const state = await ChannelCommands.saveAndApplyChannelCss(channelId, css);
			return {themeId: state.theme_id, css: state.css};
		});
	}

	async clearChannelTheme(channelId: string): Promise<boolean> {
		runInAction(() => {
			this.writeError = null;
		});
		try {
			await ChannelCommands.clearChannelAppearance(channelId);
			runInAction(() => {
				this.activeByChannelId.delete(channelId);
				this.channelsLoaded.add(channelId);
			});
			return true;
		} catch (error) {
			runInAction(() => {
				this.writeError = error;
			});
			return false;
		}
	}

	/**
	 * Runs a channel-state write and stores what the server actually returned, rather than what was
	 * requested. The server is the authority on which of the two columns ended up set, so echoing its
	 * response is what keeps the local state from ever holding both.
	 */
	private async runChannelWrite(channelId: string, write: () => Promise<ChannelThemeActiveState>): Promise<boolean> {
		runInAction(() => {
			this.writeError = null;
		});
		try {
			const state = await write();
			runInAction(() => {
				this.applyStateLocally(channelId, state.themeId, state.css);
				this.channelsLoaded.add(channelId);
			});
			return true;
		} catch (error) {
			runInAction(() => {
				this.writeError = error;
			});
			return false;
		}
	}

	/**
	 * Mirrors a server state row locally. A row with neither field set is dropped rather than stored:
	 * an absent entry and an all-null entry mean the same thing to `getThemeCss`, and keeping one
	 * representation avoids the editor having to test for both.
	 */
	private applyStateLocally(channelId: string, themeId: string | null, css: string | null): void {
		if (themeId == null && css == null) {
			this.activeByChannelId.delete(channelId);
			return;
		}
		this.activeByChannelId.set(channelId, {themeId, css});
	}

	clearWriteError(): void {
		this.writeError = null;
	}
}

/**
 * Extracts the blocking channel IDs from a refused delete, or null when the error is anything else.
 * Shape comes from ChannelThemeController's ConflictError, whose `data` is spread into the body.
 */
function blockedChannelIdsFrom(error: unknown): Array<string> | null {
	if (!(error instanceof HttpError) || error.status !== 409) {
		return null;
	}
	const body = error.body;
	if (typeof body !== 'object' || body === null) {
		return null;
	}
	const channelIds = (body as {channel_ids?: unknown}).channel_ids;
	if (!Array.isArray(channelIds)) {
		return null;
	}
	return channelIds.filter((id): id is string => typeof id === 'string');
}

export default new ChannelThemes();
