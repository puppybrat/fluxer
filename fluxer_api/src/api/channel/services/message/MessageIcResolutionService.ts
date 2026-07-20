// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {BadGatewayError} from '@fluxer/errors/src/domains/core/BadGatewayError';
import {BadRequestError} from '@fluxer/errors/src/domains/core/BadRequestError';
import {getCastClient} from '@pkgs/cast_client/src/CastClient';
import type {GuildID, UserID} from '../../../BrandedTypes';

/**
 * Resolves which cast characters a message is attributed to when it is marked in-character.
 *
 * The chain is: message sender's Fluxer user id -> owner index (owner_accounts) -> that owner's
 * characters that are primary in this guild. Resolution happens once, at toggle time; the stored
 * result is never recomputed, so changing a primary later does not rewrite old messages.
 */

interface ResolvedCast {
	characterIds: Array<string>;
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
 * Characters belonging to `ownerIndex` that are in this guild's cast, split by primary status.
 * Both lists come from one fetch so the two views cannot disagree.
 */
async function loadOwnedCharacters(
	guildId: GuildID,
	ownerIndex: number,
): Promise<{owned: Set<string>; primary: Array<string>}> {
	const cast = await getCastClient().fetchForServer(guildId.toString());
	if (!cast.ok) {
		throw new BadGatewayError();
	}
	const primaryIds = new Set(
		cast.data.primaries
			.filter((primary) => primary.is_primary === true || primary.is_primary === 1 || primary.is_primary === '1')
			.map((primary) => String(primary.character_id)),
	);
	const owned = new Set<string>();
	const primary: Array<string> = [];
	for (const character of cast.data.characters) {
		if (Number(character.owner) !== ownerIndex) {
			continue;
		}
		const id = String(character.id);
		owned.add(id);
		if (primaryIds.has(id)) {
			primary.push(id);
		}
	}
	return {owned, primary};
}

/**
 * Explicit ids are validated against the *sender's* characters, not the caller's: anyone may
 * toggle anyone's message, but a message can only ever be attributed to characters its own
 * author owns. Otherwise one user could put words in another's character's mouth.
 */
export async function resolveIcCharacterIds(params: {
	guildId: GuildID;
	senderId: UserID;
	characterIds?: Array<string>;
}): Promise<ResolvedCast> {
	const ownerIndex = await loadOwnerIndex(params.senderId);
	const {owned, primary} = await loadOwnedCharacters(params.guildId, ownerIndex);

	if (params.characterIds !== undefined) {
		const notOwned = params.characterIds.filter((id) => !owned.has(id));
		if (notOwned.length > 0) {
			throw new BadRequestError({
				code: APIErrorCodes.CAST_CHARACTER_NOT_OWNED,
				message: `Character(s) ${notOwned.join(', ')} do not belong to the author of this message in this community.`,
			});
		}
		return {characterIds: [...new Set(params.characterIds)]};
	}

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
