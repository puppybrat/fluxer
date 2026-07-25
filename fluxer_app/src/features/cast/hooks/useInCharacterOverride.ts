// SPDX-License-Identifier: AGPL-3.0-or-later

import GuildCastDisplay from '@app/features/cast/state/GuildCastDisplay';
import type {Message} from '@app/features/messaging/models/MessagingMessage';
import {useMemo} from 'react';

export interface InCharacterOverride {
	displayName: string;
	avatarUrl: string | null;
	usernameColor: string;
	/** The character's reference image, or null when unset. Shown when the avatar is tapped. */
	referenceImageUrl: string | null;
}

/**
 * A character name always renders in the default text colour, never the real sender's role colour.
 * MessageUsername resolves colour as `previewColor || member.getColorString()`, so without an explicit
 * colour here the character name would inherit the sender's highest-role colour. Forcing the default
 * text token (the same colour the multi-character header uses) suppresses that in every head path
 * (cozy and compact both read this through headOverrides.usernameColor).
 */
const CHARACTER_NAME_COLOR = 'var(--text-primary)';

/**
 * Resolves the character identity to render in place of the real sender for an in-character
 * message, or undefined when the message should render as its sender.
 *
 * Only single-character messages substitute: multi-character attribution needs a combined name
 * and stacked avatars that do not exist yet, and a character that no longer resolves in the
 * guild's cast falls back rather than asserting a stale identity.
 *
 * `guildId` is the channel's guild — messages do not carry guild_id over the wire, so callers
 * pass the resolved guild id, which is the same key ChannelChatLayout loads the cast under.
 *
 * The GuildCastDisplay lookup is read during render (not gated behind useMemo deps) so an
 * observer component re-renders and picks up the identity when the guild's cast finishes loading
 * after mount; a deps-gated memo would cache the pre-load miss and never recover. useMemo only
 * stabilises the returned object reference against its own contents.
 */
export function useInCharacterOverride(message: Message, guildId: string | undefined): InCharacterOverride | undefined {
	const identity =
		message.ic && message.castCharacterIds.length === 1
			? GuildCastDisplay.getIdentity(message.guildId ?? guildId, message.castCharacterIds[0])
			: null;
	return useMemo(
		() =>
			identity
				? {
						displayName: identity.name,
						avatarUrl: identity.avatarUrl,
						usernameColor: CHARACTER_NAME_COLOR,
						referenceImageUrl: identity.referenceImageUrl,
					}
				: undefined,
		[identity?.name, identity?.avatarUrl, identity?.referenceImageUrl],
	);
}
