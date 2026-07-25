// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/cast/components/MultiCharacterHeads.module.css';
import type {MultiCharacterHead} from '@app/features/cast/hooks/useMultiCharacterHeads';
import {openCharacterImageViewer} from '@app/features/cast/utils/CharacterImageViewer';
import * as AvatarUtils from '@app/features/user/utils/AvatarUtils';
import {observer} from 'mobx-react-lite';
import type React from 'react';

interface MultiCharacterHeadsProps {
	heads: ReadonlyArray<MultiCharacterHead>;
	authorId: string;
	timestampSlot?: React.ReactNode;
}

/**
 * Header for a message attributed to more than one cast character. Each character is a
 * self-contained avatar + name pair at full header weight; pairs sit side by side and wrap to
 * further lines as needed (there is no cap beyond the server's own limit). Single-character and
 * out-of-character messages never reach here — they keep their existing single-avatar header.
 *
 * A character with no pfp override falls back to the message author's default avatar via the exact
 * same getUserAvatarURL call the single-character path uses (Avatar's fallbackAvatarUrl), so the
 * no-pfp case looks identical whether one or many characters are attributed.
 */
export const MultiCharacterHeads: React.FC<MultiCharacterHeadsProps> = observer(({heads, authorId, timestampSlot}) => (
	<div className={styles.container} data-flx="cast.multi-character-heads.container">
		{heads.map((head) => {
			const displayedAvatarUrl = head.avatarUrl ?? AvatarUtils.getUserAvatarURL({id: authorId, avatar: null});
			// Tapping opens the character's reference image, falling back to the pfp already shown as
			// the avatar — the same behaviour as the single-character path.
			const viewerImageUrl = head.referenceImageUrl ?? displayedAvatarUrl;
			return (
				<span key={head.id} className={styles.pair} data-flx="cast.multi-character-heads.pair">
					<button
						type="button"
						className={styles.avatarButton}
						onClick={() => openCharacterImageViewer(viewerImageUrl)}
						data-flx="cast.multi-character-heads.avatar-button.open"
					>
						<img
							src={displayedAvatarUrl}
							alt=""
							width={40}
							height={40}
							className={styles.avatar}
							data-flx="cast.multi-character-heads.avatar"
						/>
					</button>
					<span className={styles.name} data-flx="cast.multi-character-heads.name">
						{head.displayName}
					</span>
				</span>
			);
		})}
		{timestampSlot != null && (
			<span className={styles.timestamp} data-flx="cast.multi-character-heads.timestamp">
				{timestampSlot}
			</span>
		)}
	</div>
));
