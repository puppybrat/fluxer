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
	private readonly eligibleByGuild = new Map<string, boolean>();
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
		if (!guildId) {
			return false;
		}
		return this.eligibleByGuild.get(guildId) ?? false;
	}

	/**
	 * Resolves eligibility once per guild. Repeat calls while a request is outstanding, or after one
	 * has completed, are no-ops. A failure leaves the guild unresolved so a later mount can retry.
	 */
	async ensureEligibility(guildId: string): Promise<void> {
		if (this.eligibleByGuild.has(guildId) || this.inFlight.has(guildId)) {
			return;
		}
		this.inFlight.add(guildId);
		try {
			const eligible = await resolveEligibility(guildId);
			runInAction(() => {
				this.eligibleByGuild.set(guildId, eligible);
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

	reset(): void {
		this.icByChannel.clear();
		this.eligibleByGuild.clear();
		this.inFlight.clear();
	}
}

/**
 * Mirrors the server's resolution (MessageIcResolutionService): map the current user to an owner
 * index, then check whether any character primary in this guild belongs to that owner. Primaries
 * are not filtered by channel scope here, matching how the server resolves them.
 */
async function resolveEligibility(guildId: string): Promise<boolean> {
	const currentUserId = Authentication.currentUserId;
	if (!currentUserId) {
		return false;
	}
	const [ownerAccounts, cast] = await Promise.all([
		CastCommands.getOwnerAccounts(guildId),
		CastCommands.getGuildCast(guildId),
	]);
	const ownerAccount = ownerAccounts.find((account) => account.fluxer_user_id === currentUserId);
	if (!ownerAccount) {
		return false;
	}
	const primaryCharacterIds = new Set(
		cast.primaries.filter((primary) => primary.is_primary).map((primary) => primary.character_id),
	);
	return cast.characters.some(
		(character) => character.owner === ownerAccount.owner_index && primaryCharacterIds.has(character.id),
	);
}

export default new ComposerInCharacter();
