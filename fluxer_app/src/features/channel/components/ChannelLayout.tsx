// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/channel/components/ChannelLayout.module.css';
import {useChannelThemeStyle} from '@app/features/channel/hooks/useChannelThemeStyle';
import Channels from '@app/features/channel/state/Channels';
import Guilds from '@app/features/guild/state/Guilds';
import {useParams} from '@app/features/platform/components/router/RouterReact';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {SmileySadIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useRef} from 'react';
import type {ReactNode} from 'react';

// TODO(channel-themes): Replace with per-channel CSS sourced from the channel-themes state store once built.
const CHANNEL_THEME_STUB_CSS = ':root { --background-secondary-lighter: oklch(22% 0.2 300); }';

const CHANNEL_DESCRIPTOR = msg({
	message: 'Channel',
	comment: 'Short label in the channel layout. Keep it concise.',
});
const CHANNEL_2_DESCRIPTOR = msg({
	message: '{channelName} channel',
	comment: 'Short label in the channel layout. Keep it concise. Preserve {channelName}; it is inserted by code.',
});

interface ChannelLayoutProps {
	children: ReactNode;
}

export const ChannelLayout = observer(({children}: ChannelLayoutProps) => {
	const {i18n} = useLingui();
	const {guildId: routeGuildId, channelId} = useParams() as {guildId?: string; channelId: string};
	const containerRef = useRef<HTMLElement>(null);
	useChannelThemeStyle(containerRef, CHANNEL_THEME_STUB_CSS);
	const channel = Channels.getChannel(channelId);
	const guildId = routeGuildId || channel?.guildId;
	const guild = guildId ? Guilds.getGuild(guildId) : null;
	if (guild && !channel) {
		return (
			<main
				className={styles.channelNotFoundContainer}
				aria-label={i18n._(CHANNEL_DESCRIPTOR)}
				data-flx="channel.channel-layout.channel-not-found-container"
			>
				<div className={styles.channelNotFoundContent} data-flx="channel.channel-layout.channel-not-found-content">
					<SmileySadIcon
						className={styles.channelNotFoundIcon}
						data-flx="channel.channel-layout.channel-not-found-icon"
					/>
					<h1 className={styles.channelNotFoundTitle} data-flx="channel.channel-layout.channel-not-found-title">
						<Trans>This is not the channel you're looking for.</Trans>
					</h1>
					<p
						className={styles.channelNotFoundDescription}
						data-flx="channel.channel-layout.channel-not-found-description"
					>
						<Trans>The channel you're looking for may have been deleted or you may not have access to it.</Trans>
					</p>
				</div>
			</main>
		);
	}
	return (
		<main
			ref={containerRef}
			className={styles.channelLayoutContainer}
			aria-label={channel ? i18n._(CHANNEL_2_DESCRIPTOR, {channelName: channel.name}) : i18n._(CHANNEL_DESCRIPTOR)}
			data-flx="channel.channel-layout.channel-layout-container"
		>
			{children}
		</main>
	);
});
