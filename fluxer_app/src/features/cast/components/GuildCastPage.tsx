// SPDX-License-Identifier: AGPL-3.0-or-later

import {CastOverviewContent} from '@app/features/cast/components/CastOverviewContent';
import styles from '@app/features/cast/components/GuildCastPage.module.css';
import {ChannelHeader} from '@app/features/channel/components/ChannelHeader';
import {ChannelViewScaffold} from '@app/features/channel/components/channel_view/ChannelViewScaffold';
import Guilds from '@app/features/guild/state/Guilds';
import {Scroller} from '@app/features/ui/components/Scroller';
import {useFluxerDocumentTitle} from '@app/features/window/hooks/useFluxerDocumentTitle';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {UsersThreeIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useMemo} from 'react';

const CAST_PAGE_DESCRIPTOR = msg({
	message: 'Cast',
	context: 'guild-cast-page',
	comment: 'Title of the full-page community cast overview, reached from the channel sidebar.',
});

interface GuildCastPageProps {
	guildId: string;
}

/**
 * Full-page Cast Overview for a community.
 *
 * Structure mirrors GuildMembersPage exactly: a ChannelViewScaffold whose content occupies the
 * chatArea slot with no sidePanel, so it replaces the channel view while the guild sidebar stays
 * put. The header hides the members toggle and pins for the same reason that page does — this is a
 * utility view, not a chat.
 *
 * The tree itself is CastOverviewContent, which is shell-free and therefore reusable here; the
 * fixed-width CastOverviewPanel shell belongs to a side panel and deliberately is not used.
 */
export const GuildCastPage: React.FC<GuildCastPageProps> = observer(({guildId}) => {
	const {i18n} = useLingui();
	const guild = Guilds.getGuild(guildId);
	useFluxerDocumentTitle(useMemo(() => [i18n._(CAST_PAGE_DESCRIPTOR), guild?.name], [guild?.name, i18n.locale]));
	const headerLeftContent = useMemo(
		() => (
			<div className={styles.headerLeftContent} data-flx="cast.guild-cast-page.header-left-content">
				<UsersThreeIcon className={styles.headerIcon} size={20} data-flx="cast.guild-cast-page.header-icon" />
				<span className={styles.headerLabel} data-flx="cast.guild-cast-page.header-label">
					{i18n._(CAST_PAGE_DESCRIPTOR)}
				</span>
			</div>
		),
		[i18n.locale],
	);
	return (
		<ChannelViewScaffold
			header={
				<ChannelHeader
					leftContent={headerLeftContent}
					showMembersToggle={false}
					showPins={false}
					data-flx="cast.guild-cast-page.channel-header"
				/>
			}
			chatArea={
				<div className={styles.pageContainer} data-flx="cast.guild-cast-page.page-container">
					<Scroller className={styles.scroller} data-flx="cast.guild-cast-page.scroller">
						<div className={styles.content} data-flx="cast.guild-cast-page.content">
							<CastOverviewContent guildId={guildId} />
						</div>
					</Scroller>
				</div>
			}
			data-flx="cast.guild-cast-page.channel-view-scaffold"
		/>
	);
});
