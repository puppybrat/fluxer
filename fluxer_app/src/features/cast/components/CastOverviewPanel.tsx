// SPDX-License-Identifier: AGPL-3.0-or-later

import {OutlineFrame} from '@app/features/app/components/layout/OutlineFrame';
import * as CastCommands from '@app/features/cast/commands/CastCommands';
import styles from '@app/features/cast/components/CastOverviewPanel.module.css';
import {
	buildCastOverviewTree,
	type CastOverviewChannelInfo,
	type CastOverviewEntry,
	type CastOverviewGroup,
} from '@app/features/cast/utils/CastOverviewTree';
import {ChannelSettingsModal} from '@app/features/channel/components/modals/ChannelSettingsModal';
import Channels from '@app/features/channel/state/Channels';
import {GuildSettingsModal} from '@app/features/guild/components/modals/GuildSettingsModal';
import GuildSettingsModalState from '@app/features/guild/state/GuildSettingsModal';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {Scroller} from '@app/features/ui/components/Scroller';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect, useMemo, useState} from 'react';

interface CastOverviewPanelProps {
	guildId: string;
}

interface CastData {
	characters: ReadonlyArray<CastCommands.CastCharacter>;
	primaries: ReadonlyArray<CastCommands.CastPrimary>;
	overrides: ReadonlyArray<CastCommands.CastOverrideRow>;
}

/**
 * Read-only overview of a guild's cast across every scope, occupying the side panel slot the member
 * list used to.
 *
 * Deliberately does NOT read GuildCastDisplay, ComposerInCharacter or any other cast store, and adds
 * no cache of its own: every one of this feature's recurring bugs has been a write path forgetting to
 * invalidate some cache, and a read-only panel opened occasionally is not worth another one. It does
 * a fresh unscoped fetch each time it mounts instead — that single call already carries every scope's
 * raw rows, so the whole tree costs exactly one request.
 */
export const CastOverviewPanel: React.FC<CastOverviewPanelProps> = observer(function CastOverviewPanel({guildId}) {
	const [cast, setCast] = useState<CastData | null>(null);
	const [error, setError] = useState<unknown>(null);

	useEffect(() => {
		// `cancelled` rather than a token field: the state lives in this component, so switching guilds
		// unmounts/re-runs the effect and a late response from the previous guild must not land.
		let cancelled = false;
		setCast(null);
		setError(null);
		CastCommands.getGuildCast(guildId)
			.then((data) => {
				if (cancelled) return;
				setCast({characters: data.characters, primaries: data.primaries, overrides: data.overrides});
			})
			.catch((fetchError: unknown) => {
				if (cancelled) return;
				setError(fetchError);
			});
		return () => {
			cancelled = true;
		};
	}, [guildId]);

	// Channels are read through the store rather than the cast payload: the cast rows carry only ids,
	// and names/parents/category-ness live client-side. Reading them inside the memo keeps the tree
	// reactive to channel renames and moves without refetching the cast.
	const guildChannels = Channels.getGuildChannels(guildId);
	const tree = useMemo(() => {
		if (!cast) return null;
		const channelsById = new Map<string, CastOverviewChannelInfo>(
			guildChannels.map((channel) => [
				channel.id,
				{
					id: channel.id,
					name: channel.name ?? null,
					parentId: channel.parentId,
					isCategory: channel.isGuildCategory(),
					// Ordering comes from the same field the real sidebar sorts on, so the overview's
					// order tracks the channel list rather than drifting into its own alphabetical one.
					position: channel.position ?? null,
				},
			]),
		);
		return buildCastOverviewTree({
			characters: cast.characters,
			primaries: cast.primaries,
			overrides: cast.overrides,
			channelsById,
		});
	}, [cast, guildChannels]);

	const openGuildCastTab = () => {
		// Matches RoleManagement's pattern: retarget an already-open settings modal rather than
		// stacking a second one.
		if (GuildSettingsModalState.navigateToTab(guildId, 'cast')) {
			return;
		}
		ModalCommands.push(
			modal(() => (
				<GuildSettingsModal
					guildId={guildId}
					initialTab="cast"
					data-flx="cast.cast-overview-panel.guild-settings-modal"
				/>
			)),
		);
	};

	const openChannelCastTab = (channelId: string) => {
		ModalCommands.push(
			modal(() => (
				<ChannelSettingsModal
					channelId={channelId}
					initialTab="cast"
					data-flx="cast.cast-overview-panel.channel-settings-modal"
				/>
			)),
		);
	};

	const renderEntry = (entry: CastOverviewEntry) => (
		<div key={entry.characterId} className={styles.entry} data-flx="cast.cast-overview-panel.entry">
			<span className={badgeClassName(entry.status)}>{BADGE_LABEL[entry.status]}</span>
			<span className={styles.entryName}>{entry.name}</span>
			{entry.nickname != null && <span className={styles.entryNickname}>{entry.nickname}</span>}
		</div>
	);

	const renderGroup = (group: CastOverviewGroup, nested: boolean) => {
		const label = group.kind === 'server' ? 'Server-wide' : group.name;
		const onOpen = group.scopeId == null ? openGuildCastTab : () => openChannelCastTab(group.scopeId as string);
		return (
			<div
				key={group.scopeId ?? 'server'}
				className={nested ? `${styles.group} ${styles.nested}` : styles.group}
				data-flx="cast.cast-overview-panel.group"
			>
				<div className={styles.groupHeader}>
					<span className={styles.groupName} title={label}>
						{label}
					</span>
					<button type="button" className={styles.openLink} onClick={onOpen}>
						Open
					</button>
				</div>
				{group.entries.length > 0 ? (
					<div className={styles.entryList}>{group.entries.map(renderEntry)}</div>
				) : (
					// A structural-only category has no delta of its own; it is present purely so its
					// overridden channels nest under the right name.
					<span className={styles.muted}>
						{group.structuralOnly ? 'No changes at this category' : 'No changes here'}
					</span>
				)}
				{group.children.map((child) => renderGroup(child, true))}
			</div>
		);
	};

	return (
		<OutlineFrame hideTopBorder>
			<aside className={styles.container} aria-label="Cast overview" data-flx="cast.cast-overview-panel.container">
				<Scroller
					className={styles.scrollerPadding}
					contentClassName={styles.scrollerContent}
					data-flx="cast.cast-overview-panel.scroller"
				>
					<span className={styles.title}>Cast Overview</span>
					{error != null ? (
						<div className={styles.error}>Could not load the cast for this community.</div>
					) : tree == null ? (
						<span className={styles.muted}>Loading…</span>
					) : (
						tree.map((group) => renderGroup(group, false))
					)}
				</Scroller>
			</aside>
		</OutlineFrame>
	);
});

const BADGE_LABEL: Record<CastOverviewEntry['status'], string> = {
	added: 'Add',
	edited: 'Edit',
	excluded: 'Excl',
};

function badgeClassName(status: CastOverviewEntry['status']): string {
	const variant =
		status === 'added' ? styles.badgeAdded : status === 'edited' ? styles.badgeEdited : styles.badgeExcluded;
	return `${styles.badge} ${variant}`;
}
