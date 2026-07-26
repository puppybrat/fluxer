// SPDX-License-Identifier: AGPL-3.0-or-later

import Authentication from '@app/features/auth/state/Authentication';
import * as CastCommands from '@app/features/cast/commands/CastCommands';
import {makeAutoObservable, runInAction} from 'mobx';

/**
 * Composer in-character state — two concerns, each keyed by channel.
 *
 * The IC/OOC toggle is per-channel, so each channel's composer remembers its own state
 * independently. Kept in memory rather than persisted: going in-character is a deliberate
 * per-session choice, and a persisted "on" could outlive the eligibility that justified it.
 *
 * Eligibility — does the current user have a usable primary character HERE — is per-channel, because
 * a primary can be overridden or excluded per channel/category: the same user can have a primary in
 * one channel and none in another. Resolution walks the channel's resolved_cast, so the toggle and
 * the optimistic render only ever reflect what is actually primary in the current channel. It needs
 * the current user's owner index, which only the owner-accounts route exposes, and that route
 * requires MANAGE_GUILD. A member without it gets a 403 and resolves to ineligible, so the toggle
 * stays hidden — a known limitation of gating this way.
 */
class ComposerInCharacter {
	private readonly icByChannel = new Map<string, boolean>();
	private readonly primaryIdsByChannel = new Map<string, ReadonlyArray<string>>();
	// The guild each resolved channel belongs to, so a guild-wide write can re-resolve exactly the
	// channels it could affect without a separate lookup.
	private readonly guildByChannel = new Map<string, string>();
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
	 * Whether the current user has a primary character in THIS channel's effective cast — the gate for
	 * showing the composer toggle. False until ensureEligibility resolves, and false for a DM, a
	 * channel whose lookup failed, or a user with no primary here.
	 */
	hasUsablePrimary(channelId: string | undefined): boolean {
		return this.getPrimaryCharacterIds(channelId).length > 0;
	}

	/**
	 * The current user's primary character ids in THIS channel, or empty. Used to render a just-sent
	 * message in-character optimistically, so the sender sees no OOC→IC flash before the server
	 * confirms. Mirrors the server's resolution, which attributes to all of the author's primaries
	 * that are primary in this channel — never another channel's overrides or the guild default.
	 */
	getPrimaryCharacterIds(channelId: string | undefined): ReadonlyArray<string> {
		if (!channelId) {
			return EMPTY_IDS;
		}
		return this.primaryIdsByChannel.get(channelId) ?? EMPTY_IDS;
	}

	/**
	 * Resolves eligibility once per channel. Repeat calls while a request is outstanding, or after one
	 * has completed, are no-ops. A failure leaves the channel unresolved so a later mount can retry.
	 */
	async ensureEligibility(guildId: string, channelId: string): Promise<void> {
		if (this.primaryIdsByChannel.has(channelId) || this.inFlight.has(channelId)) {
			return;
		}
		this.inFlight.add(channelId);
		try {
			const primaryIds = await resolvePrimaryCharacterIds(guildId, channelId);
			runInAction(() => {
				this.primaryIdsByChannel.set(channelId, primaryIds);
				this.guildByChannel.set(channelId, guildId);
			});
		} catch {
			// Swallowed on purpose: a member without MANAGE_GUILD gets a 403 from owner-accounts,
			// which just means the toggle stays hidden. Leaving the channel unresolved lets a later
			// mount retry (e.g. once the user is granted the permission).
		} finally {
			runInAction(() => {
				this.inFlight.delete(channelId);
			});
		}
	}

	/**
	 * Re-resolves every cached channel in this guild after a cast write. A write can be server-,
	 * category-, or channel-scoped and so affect any of the guild's channels' resolution, so all of
	 * them are re-resolved rather than guessing which changed — the cache only holds channels the user
	 * has actually visited, so this stays small. Keeps the optimistic render and toggle current
	 * without waiting for the server's MESSAGE_UPDATE.
	 */
	async refresh(guildId: string): Promise<void> {
		const channelIds = Array.from(this.guildByChannel)
			.filter(([, gid]) => gid === guildId)
			.map(([channelId]) => channelId);
		await Promise.all(
			channelIds.map(async (channelId) => {
				try {
					const primaryIds = await resolvePrimaryCharacterIds(guildId, channelId);
					runInAction(() => {
						this.primaryIdsByChannel.set(channelId, primaryIds);
					});
				} catch {
					// Swallowed on purpose: a failed refresh keeps the last-known eligibility for that
					// channel rather than dropping the toggle, matching ensureEligibility's fallback.
				}
			}),
		);
	}

	reset(): void {
		this.icByChannel.clear();
		this.primaryIdsByChannel.clear();
		this.guildByChannel.clear();
		this.inFlight.clear();
	}
}

const EMPTY_IDS: ReadonlyArray<string> = [];

/**
 * Mirrors the server's resolution (MessageIcResolutionService): map the current user to an owner
 * index, then collect the characters that owner owns that are primary in THIS channel's effective
 * cast (the server → category → channel walk, delivered as resolved_cast). Returns empty when the
 * user has no owner mapping or no primary here.
 */
async function resolvePrimaryCharacterIds(guildId: string, channelId: string): Promise<ReadonlyArray<string>> {
	const currentUserId = Authentication.currentUserId;
	if (!currentUserId) {
		return EMPTY_IDS;
	}
	const [ownerAccounts, cast] = await Promise.all([
		CastCommands.getOwnerAccounts(guildId),
		CastCommands.getGuildCast(guildId, channelId),
	]);
	const ownerAccount = ownerAccounts.find((account) => account.fluxer_user_id === currentUserId);
	if (!ownerAccount) {
		return EMPTY_IDS;
	}
	const ownedIds = new Set(
		cast.characters
			.filter((character) => character.owner === ownerAccount.owner_index)
			.map((character) => character.id),
	);
	return (cast.resolved_cast ?? [])
		.filter((row) => row.is_primary && ownedIds.has(row.character_id))
		.map((row) => row.character_id);
}

export default new ComposerInCharacter();
