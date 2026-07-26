// SPDX-License-Identifier: AGPL-3.0-or-later

import * as CastCommands from '@app/features/cast/commands/CastCommands';
import styles from '@app/features/cast/components/CastOverviewContent.module.css';
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
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect, useMemo, useState} from 'react';

interface CastData {
	characters: ReadonlyArray<CastCommands.CastCharacter>;
	primaries: ReadonlyArray<CastCommands.CastPrimary>;
	overrides: ReadonlyArray<CastCommands.CastOverrideRow>;
}

/**
 * Fetches a guild's cast fresh and exposes the built tree. Shared by every Cast Overview surface.
 *
 * Deliberately caches nothing and reads no cast store: every recurring bug in this feature has been a
 * write path forgetting to invalidate a cache, and the overview is read-only and opened occasionally,
 * so a fresh unscoped fetch per mount is the cheaper correctness trade. That single call already
 * carries every scope's raw rows, so the whole tree costs one request regardless of how many scopes
 * it ends up showing.
 */
export function useCastOverviewTree(guildId: string | null | undefined): {
	tree: Array<CastOverviewGroup> | null;
	error: unknown;
} {
	const [cast, setCast] = useState<CastData | null>(null);
	const [error, setError] = useState<unknown>(null);

	useEffect(() => {
		if (!guildId) {
			setCast(null);
			setError(null);
			return;
		}
		// `cancelled` rather than a token: the state is local, so a guild change re-runs the effect and
		// a late response from the previous guild must not land.
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

	// Channels come from the store, not the cast payload: the cast rows carry only ids, while names,
	// parents, category-ness and sidebar position live client-side. Reading them here keeps the tree
	// reactive to renames and reorders without refetching the cast.
	const guildChannels = Channels.getGuildChannels(guildId ?? '');
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

	return {tree, error};
}

/**
 * The Cast Overview tree itself — groups, entries and per-scope links into the real settings Cast
 * tab. Shell-free on purpose: the desktop side panel and the mobile channel-details sheet each wrap
 * this in their own container and scroller, so this renders no width, background or frame of its own.
 *
 * Read-only. Every group links out to the settings tab for its exact scope rather than editing here.
 */
export const CastOverviewContent: React.FC<{guildId: string | null | undefined}> = observer(
	function CastOverviewContent({guildId}) {
		const {tree, error} = useCastOverviewTree(guildId);

		const openGuildCastTab = () => {
			if (!guildId) return;
			// Matches RoleManagement's pattern: retarget an already-open settings modal rather than
			// stacking a second one on top of it.
			if (GuildSettingsModalState.navigateToTab(guildId, 'cast')) {
				return;
			}
			ModalCommands.push(
				modal(() => (
					<GuildSettingsModal
						guildId={guildId}
						initialTab="cast"
						data-flx="cast.cast-overview-content.guild-settings-modal"
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
						data-flx="cast.cast-overview-content.channel-settings-modal"
					/>
				)),
			);
		};

		const renderEntry = (entry: CastOverviewEntry) => (
			<div key={entry.characterId} className={styles.entry} data-flx="cast.cast-overview-content.entry">
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
					data-flx="cast.cast-overview-content.group"
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
						// A structural-only category has no delta of its own; it is listed purely so its
						// overridden channels nest under the right name.
						<span className={styles.muted}>
							{group.structuralOnly ? 'No changes at this category' : 'No changes here'}
						</span>
					)}
					{group.children.map((child) => renderGroup(child, true))}
				</div>
			);
		};

		if (error != null) {
			return <div className={styles.error}>Could not load the cast for this community.</div>;
		}
		if (tree == null) {
			return <span className={styles.muted}>Loading…</span>;
		}
		return (
			<div className={styles.groups} data-flx="cast.cast-overview-content.groups">
				{tree.map((group) => renderGroup(group, false))}
			</div>
		);
	},
);

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
