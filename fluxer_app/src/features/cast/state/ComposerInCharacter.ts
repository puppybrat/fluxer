// SPDX-License-Identifier: AGPL-3.0-or-later

import Authentication from '@app/features/auth/state/Authentication';
import * as CastCommands from '@app/features/cast/commands/CastCommands';
import {makeAutoObservable, runInAction} from 'mobx';

/**
 * Composer in-character state — two concerns, each keyed by its natural scope.
 *
 * The IC/OOC toggle is per-channel, so each channel's composer remembers its own state
 * independently. Kept in memory rather than persisted: going in-character is a deliberate
 * per-session choice, and a persisted "on" could outlive the eligibility that justified it.
 *
 * Eligibility — does the current user have a usable primary character here — is per-guild, since a
 * guild's cast is per-guild. It needs the current user's owner index, which only the owner-accounts
 * route exposes, and that route requires MANAGE_GUILD. A member without it gets a 403 and resolves
 * to ineligible, so the toggle stays hidden. This is a known limitation of gating this way: only
 * members who can read owner-accounts (i.e. MANAGE_GUILD) and have a primary see the toggle.
 */
class ComposerInCharacter {
	private readonly icByChannel = new Map<string, boolean>();
	private readonly primaryIdsByGuild = new Map<string, ReadonlyArray<string>>();
	private readonly inFlight = new Set<string>();

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	isChannelInCharacter(channelId: string): boolean {
		return this.icByChannel.get(channelId) ?? false;
	}

	toggleChannel(channelId: string): void {
		this.icByChannel.set(channelId, !this.isChannelInCharacter(channelId));
	}

	setChannel(channelId: string, value: boolean): void {
		this.icByChannel.set(channelId, value);
	}

	/**
	 * Whether the current user has a primary character in this guild's cast — the gate for showing
	 * the composer toggle. False until ensureEligibility resolves, and false for a DM, a guild whose
	 * lookup failed, or a user with no primary.
	 */
	hasUsablePrimary(guildId: string | undefined): boolean {
		return this.getPrimaryCharacterIds(guildId).length > 0;
	}

	/**
	 * The current user's primary character ids in this guild, or empty. Used to render a just-sent
	 * message in-character optimistically, so the sender sees no OOC→IC flash before the server
	 * confirms. Mirrors the server's resolution, which attributes to all of the author's primaries.
	 */
	getPrimaryCharacterIds(guildId: string | undefined): ReadonlyArray<string> {
		if (!guildId) {
			return EMPTY_IDS;
		}
		return this.primaryIdsByGuild.get(guildId) ?? EMPTY_IDS;
	}

	/**
	 * Resolves eligibility once per guild. Repeat calls while a request is outstanding, or after one
	 * has completed, are no-ops. A failure leaves the guild unresolved so a later mount can retry.
	 */
	async ensureEligibility(guildId: string): Promise<void> {
		if (this.primaryIdsByGuild.has(guildId) || this.inFlight.has(guildId)) {
			return;
		}
		this.inFlight.add(guildId);
		try {
			const primaryIds = await resolvePrimaryCharacterIds(guildId);
			runInAction(() => {
				this.primaryIdsByGuild.set(guildId, primaryIds);
			});
		} catch {
			// Swallowed on purpose: a member without MANAGE_GUILD gets a 403 from owner-accounts,
			// which just means the toggle stays hidden. Leaving the guild unresolved lets a later
			// mount retry (e.g. once the user is granted the permission).
		} finally {
			runInAction(() => {
				this.inFlight.delete(guildId);
			});
		}
	}

	/**
	 * Re-resolves and replaces this guild's cached primary-character ids. Called after a cast write
	 * (e.g. changing which character is primary) so the optimistic in-character render on the next
	 * send reflects current primaries — ensureEligibility caches its snapshot once and would
	 * otherwise leave the sender briefly showing the previous primary until the server's
	 * MESSAGE_UPDATE corrects it.
	 */
	async refresh(guildId: string): Promise<void> {
		try {
			const primaryIds = await resolvePrimaryCharacterIds(guildId);
			runInAction(() => {
				this.primaryIdsByGuild.set(guildId, primaryIds);
			});
		} catch {
			// Swallowed on purpose: a failed refresh keeps the last-known eligibility rather than
			// dropping the toggle, matching how ensureEligibility treats a failed lookup.
		}
	}

	reset(): void {
		this.icByChannel.clear();
		this.primaryIdsByGuild.clear();
		this.inFlight.clear();
	}
}

const EMPTY_IDS: ReadonlyArray<string> = [];

/**
 * Mirrors the server's resolution (MessageIcResolutionService): map the current user to an owner
 * index, then collect this guild's primary characters belonging to that owner. Primaries are not
 * filtered by channel scope here, matching how the server resolves them. Returns empty when the
 * user has no owner mapping or no primary.
 */
async function resolvePrimaryCharacterIds(guildId: string): Promise<ReadonlyArray<string>> {
	const currentUserId = Authentication.currentUserId;
	if (!currentUserId) {
		return EMPTY_IDS;
	}
	const [ownerAccounts, cast] = await Promise.all([
		CastCommands.getOwnerAccounts(guildId),
		CastCommands.getGuildCast(guildId),
	]);
	const ownerAccount = ownerAccounts.find((account) => account.fluxer_user_id === currentUserId);
	if (!ownerAccount) {
		return EMPTY_IDS;
	}
	const primaryCharacterIds = new Set(
		cast.primaries.filter((primary) => primary.is_primary).map((primary) => primary.character_id),
	);
	return cast.characters
		.filter((character) => character.owner === ownerAccount.owner_index && primaryCharacterIds.has(character.id))
		.map((character) => character.id);
}

export default new ComposerInCharacter();
