// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/cast/components/MultiCharacterHeads.module.css';
import type {MultiCharacterHead} from '@app/features/cast/hooks/useMultiCharacterHeads';
import {UserSwitchIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';

interface MultiCharacterHeadsProps {
	heads: ReadonlyArray<MultiCharacterHead>;
	timestampSlot?: React.ReactNode;
}

/**
 * Header for a message attributed to more than one cast character. Each character is a
 * self-contained avatar + name pair at full header weight; pairs sit side by side and wrap to
 * further lines as needed (there is no cap beyond the server's own limit). Single-character and
 * out-of-character messages never reach here — they keep their existing single-avatar header.
 */
export const MultiCharacterHeads: React.FC<MultiCharacterHeadsProps> = observer(({heads, timestampSlot}) => (
	<div className={styles.container} data-flx="cast.multi-character-heads.container">
		{heads.map((head) => (
			<span key={head.id} className={styles.pair} data-flx="cast.multi-character-heads.pair">
				{head.avatarUrl ? (
					<img
						src={head.avatarUrl}
						alt=""
						width={40}
						height={40}
						className={styles.avatar}
						data-flx="cast.multi-character-heads.avatar"
					/>
				) : (
					<UserSwitchIcon
						size={40}
						weight="fill"
						className={styles.avatar}
						data-flx="cast.multi-character-heads.avatar-fallback"
					/>
				)}
				<span className={styles.name} data-flx="cast.multi-character-heads.name">
					{head.displayName}
				</span>
			</span>
		))}
		{timestampSlot != null && (
			<span className={styles.timestamp} data-flx="cast.multi-character-heads.timestamp">
				{timestampSlot}
			</span>
		)}
	</div>
));
