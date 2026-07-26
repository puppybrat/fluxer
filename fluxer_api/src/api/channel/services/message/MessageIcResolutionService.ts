// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {BadGatewayError} from '@fluxer/errors/src/domains/core/BadGatewayError';
import {BadRequestError} from '@fluxer/errors/src/domains/core/BadRequestError';
import {getCastClient} from '@pkgs/cast_client/src/CastClient';
import type {GuildID, UserID} from '../../../BrandedTypes';
import {resolveEffectiveCast, type ScopedOverrideRow, type ScopedPrimaryRow} from '../../../cast/CastResolution';

/**
 * Resolves which cast characters a message is attributed to when it is marked in-character.
 *
 * The chain is: message sender's Fluxer user id -> owner index (owner_accounts) -> that owner's
 * characters that are primary in THIS channel. Primary status is resolved through the
 * channel -> category -> server walk (CastResolution), so a channel/category primary override wins
 * over the server default. Resolution happens once, at toggle time; the stored result is never
 * recomputed, so changing a primary later does not rewrite old messages.
 */

interface ResolvedCast {
	characterIds: Array<string>;
}

function toBooleanFlag(value: boolean | number | string | null | undefined): boolean {
	return value === true || value === 1 || value === '1' || value === 'true';
}

function toScopedPrimaries(
	rows: ReadonlyArray<{character_id: string | number; channel_id?: string | number | null; is_primary?: unknown}>,
): Array<ScopedPrimaryRow> {
	return rows.map((row) => ({
		character_id: String(row.character_id),
		channel_id: row.channel_id != null ? String(row.channel_id) : null,
		is_primary: toBooleanFlag(row.is_primary as boolean | number | string | null | undefined),
	}));
}

function toScopedOverrides(
	rows: ReadonlyArray<{
		character_id: string | number;
		channel_id?: string | number | null;
		nickname?: string | null;
		pfp_url?: string | null;
		reference_image_url?: string | null;
		excluded?: unknown;
	}>,
): Array<ScopedOverrideRow> {
	return rows.map((row) => ({
		character_id: String(row.character_id),
		channel_id: row.channel_id != null ? String(row.channel_id) : null,
		nickname: row.nickname ?? null,
		pfp_url: row.pfp_url ?? null,
		reference_image_url: row.reference_image_url ?? null,
		excluded: toBooleanFlag(row.excluded as boolean | number | string | null | undefined),
	}));
}

async function loadOwnerIndex(senderId: UserID): Promise<number> {
	const accounts = await getCastClient().listOwnerAccounts();
	if (!accounts.ok) {
		throw new BadGatewayError();
	}
	const match = accounts.data.owner_accounts.find((account) => String(account.fluxer_user_id) === senderId.toString());
	if (!match) {
		// The sender has no personal-site owner at all, so no character could belong to them.
		// Distinct from "has an owner but no primary set" — the fixes are different.
		throw new BadRequestError({
			code: APIErrorCodes.CAST_OWNER_NOT_LINKED,
			message: 'This account is not linked to a cast owner.',
		});
	}
	return Number(match.owner_index);
}

/**
 * The sender's owned characters, plus the raw per-scope rows needed to resolve primary status for a
 * specific channel. Everything comes from one fetch so the views cannot disagree.
 */
async function loadCastForSender(
	guildId: GuildID,
	ownerIndex: number,
): Promise<{owned: Set<string>; primaries: Array<ScopedPrimaryRow>; overrides: Array<ScopedOverrideRow>}> {
	const cast = await getCastClient().fetchForServer(guildId.toString());
	if (!cast.ok) {
		throw new BadGatewayError();
	}
	const owned = new Set<string>();
	for (const character of cast.data.characters) {
		if (Number(character.owner) === ownerIndex) {
			owned.add(String(character.id));
		}
	}
	return {
		owned,
		primaries: toScopedPrimaries(cast.data.primaries),
		overrides: toScopedOverrides(cast.data.cast_overrides),
	};
}

/**
 * Explicit ids are validated against the *sender's* characters, not the caller's: anyone may
 * toggle anyone's message, but a message can only ever be attributed to characters its own
 * author owns. Otherwise one user could put words in another's character's mouth.
 *
 * `channelId`/`ancestorChain` scope the auto-resolution: primary status is taken from the most
 * specific scope (channel -> ancestors, nearest first -> server) that applies, via the resolution
 * walk. `ancestorChain` is the channel's category ancestors most specific first (empty for a
 * top-level channel); the caller builds it so this stays agnostic to how deep nesting can go.
 */
export async function resolveIcCharacterIds(params: {
	guildId: GuildID;
	senderId: UserID;
	channelId: string;
	ancestorChain: ReadonlyArray<string>;
	characterIds?: Array<string>;
}): Promise<ResolvedCast> {
	const ownerIndex = await loadOwnerIndex(params.senderId);
	const {owned, primaries, overrides} = await loadCastForSender(params.guildId, ownerIndex);

	// The channel's effective cast, resolved through the channel -> category -> server walk. Both
	// paths below consult it: a character absent (never added, or excluded) at this channel must not
	// be attributable here, whether it was auto-resolved or named explicitly.
	const effective = resolveEffectiveCast({
		primaries,
		overrides,
		channelId: params.channelId,
		ancestorChain: params.ancestorChain,
	});
	const presentIds = new Set(effective.map((row) => row.character_id));

	if (params.characterIds !== undefined) {
		const notOwned = params.characterIds.filter((id) => !owned.has(id));
		if (notOwned.length > 0) {
			throw new BadRequestError({
				code: APIErrorCodes.CAST_CHARACTER_NOT_OWNED,
				message: `Character(s) ${notOwned.join(', ')} do not belong to the author of this message in this community.`,
			});
		}
		// Owned but not present here — excluded at this channel/category, or never in this community's
		// cast at all. Attributing a message to such a character would make it unfilterable and
		// contradict the channel's own cast configuration.
		const notInChannel = params.characterIds.filter((id) => !presentIds.has(id));
		if (notInChannel.length > 0) {
			throw new BadRequestError({
				code: APIErrorCodes.CAST_CHARACTER_NOT_IN_CHANNEL,
				message: `Character(s) ${notInChannel.join(', ')} are not available in this channel.`,
			});
		}
		return {characterIds: [...new Set(params.characterIds)]};
	}

	// Auto-resolution: the sender's owned characters that are present AND primary in THIS channel,
	// resolved through the channel -> category -> server walk rather than the server scope alone.
	const primary = effective
		.filter((row) => row.is_primary && owned.has(row.character_id))
		.map((row) => row.character_id);

	if (primary.length === 0) {
		// Deliberately an error rather than a fallback: marking a message in-character with no
		// attribution would make it invisible to a character filter and permanently ambiguous,
		// and guessing a non-primary character would lock in an identity nobody chose.
		throw new BadRequestError({
			code: APIErrorCodes.CAST_NO_PRIMARY_CHARACTER,
			message:
				'No primary character is set for this author in this community. Set one, or assign characters explicitly.',
		});
	}

	return {characterIds: primary};
}
