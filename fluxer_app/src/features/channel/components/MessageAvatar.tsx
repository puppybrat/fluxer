// SPDX-License-Identifier: AGPL-3.0-or-later

import {openCharacterImageViewer} from '@app/features/cast/utils/CharacterImageViewer';
import styles from '@app/features/channel/components/MessageAvatar.module.css';
import {useMaybeMessageViewContext} from '@app/features/channel/components/MessageViewContext';
import {PreloadableUserPopout} from '@app/features/channel/components/PreloadableUserPopout';
import type {Message} from '@app/features/messaging/models/MessagingMessage';
import {Avatar} from '@app/features/ui/components/Avatar';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import type {User} from '@app/features/user/models/User';
import {observer} from 'mobx-react-lite';
import {useCallback} from 'react';

export const MessageAvatar = observer(
	({
		user,
		message,
		guildId,
		size,
		className,
		isHovering,
		avatarUrl,
		characterImageUrl,
	}: {
		user: User;
		message: Message;
		guildId?: string;
		size: 16 | 24 | 32 | 40 | 48 | 80 | 120;
		className: string;
		isHovering: boolean;
		isPreview: boolean;
		/** Overrides the rendered image only. The popout still resolves the real user, so
		 *  clicking an in-character avatar shows who actually sent the message. */
		avatarUrl?: string | null;
		/** When set, this is an in-character avatar: tapping opens this image (the character's
		 *  reference image, or its pfp as fallback) in the media viewer instead of the user popout.
		 *  Undefined leaves the normal popout-on-tap behaviour untouched for non-IC avatars. */
		characterImageUrl?: string;
	}) => {
		const onPopoutToggle = useMaybeMessageViewContext()?.onPopoutToggle;
		const handlePopoutOpen = useCallback(() => onPopoutToggle?.(true), [onPopoutToggle]);
		const handlePopoutClose = useCallback(() => onPopoutToggle?.(false), [onPopoutToggle]);
		const handleCharacterImageOpen = useCallback(() => {
			if (characterImageUrl) {
				openCharacterImageViewer(characterImageUrl);
			}
		}, [characterImageUrl]);

		// In-character avatars open the character's image in the viewer rather than the user popout.
		// The grid-area class must sit on the direct grid child, so the button carries it and the
		// avatar inside is unclassed.
		if (characterImageUrl) {
			return (
				<FocusRing data-flx="channel.message-avatar.focus-ring--ic">
					<button
						type="button"
						className={`${className} ${styles.characterImageButton}`}
						onClick={handleCharacterImageOpen}
						data-flx="channel.message-avatar.character-image-button.open"
					>
						<Avatar
							user={user}
							avatarUrl={avatarUrl}
							hoverAvatarUrl={avatarUrl}
							size={size}
							forceAnimate={isHovering}
							guildId={guildId}
							data-user-id={user.id}
							data-guild-id={guildId}
							data-flx="channel.message-avatar.avatar--ic"
						/>
					</button>
				</FocusRing>
			);
		}
		return (
			<PreloadableUserPopout
				user={user}
				isWebhook={message.webhookId != null}
				webhookId={message.webhookId ?? undefined}
				guildId={guildId}
				channelId={message.channelId}
				message={message}
				enableLongPressActions={false}
				onPopoutOpen={handlePopoutOpen}
				onPopoutClose={handlePopoutClose}
				data-flx="channel.message-avatar.preloadable-user-popout"
			>
				<FocusRing data-flx="channel.message-avatar.focus-ring">
					<Avatar
						user={user}
						avatarUrl={avatarUrl}
						// When the image is overridden (in-character), pin the hover/animated variant to the
						// same override. Otherwise Avatar derives the hover avatar from the real user, so an
						// open user-card popout — or a row hover — would swap an in-character avatar to the
						// sender's real one and flash back on release. Undefined (no override) keeps the
						// normal real-user hover behaviour untouched.
						hoverAvatarUrl={avatarUrl}
						size={size}
						className={className}
						forceAnimate={isHovering}
						guildId={guildId}
						data-user-id={user.id}
						data-guild-id={guildId}
						data-flx="channel.message-avatar.avatar"
					/>
				</FocusRing>
			</PreloadableUserPopout>
		);
	},
);
