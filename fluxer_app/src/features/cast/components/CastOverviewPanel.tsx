// SPDX-License-Identifier: AGPL-3.0-or-later

import {OutlineFrame} from '@app/features/app/components/layout/OutlineFrame';
import {CastOverviewContent} from '@app/features/cast/components/CastOverviewContent';
import styles from '@app/features/cast/components/CastOverviewPanel.module.css';
import {Scroller} from '@app/features/ui/components/Scroller';
import {observer} from 'mobx-react-lite';
import type React from 'react';

interface CastOverviewPanelProps {
	guildId: string;
}

/**
 * Desktop shell for the Cast Overview, occupying the side panel slot the member list used to.
 *
 * This component is only the frame — fixed-width aside, background and scroller, mirroring
 * MemberListContainer so the panel sits in the layout identically. The tree itself lives in
 * CastOverviewContent, which is shell-free and shared with the mobile channel-details sheet.
 */
export const CastOverviewPanel: React.FC<CastOverviewPanelProps> = observer(function CastOverviewPanel({guildId}) {
	return (
		<OutlineFrame hideTopBorder>
			<aside className={styles.container} aria-label="Cast overview" data-flx="cast.cast-overview-panel.container">
				<Scroller
					className={styles.scrollerPadding}
					contentClassName={styles.scrollerContent}
					data-flx="cast.cast-overview-panel.scroller"
				>
					<span className={styles.title}>Cast Overview</span>
					<CastOverviewContent guildId={guildId} />
				</Scroller>
			</aside>
		</OutlineFrame>
	);
});
