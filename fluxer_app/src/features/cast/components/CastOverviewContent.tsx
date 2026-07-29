// SPDX-License-Identifier: AGPL-3.0-or-later

import * as CastCommands from '@app/features/cast/commands/CastCommands';
import styles from '@app/features/cast/components/CastOverviewContent.module.css';
import {CastOverviewRow} from '@app/features/cast/components/CastOverviewRow';
import {CastAddCharacterModal} from '@app/features/cast/components/modals/CastAddCharacterModal';
import Cast from '@app/features/cast/state/Cast';
import {castWriteSignal} from '@app/features/cast/state/CastDisplayRefresh';
import ChannelCast from '@app/features/cast/state/ChannelCast';
import {
	buildCastOverviewTree,
	type CastOverviewChannelInfo,
	type CastOverviewGroup,
} from '@app/features/cast/utils/CastOverviewTree';
import Channels from '@app/features/channel/state/Channels';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {UserCirclePlusIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect, useMemo, useState} from 'react';

const ADD_CHARACTER_DESCRIPTOR = msg({
	message: 'Add character',
	comment:
		'Accessible name for the icon-only button that opens the cast character picker for one scope. Keep it concise.',
});

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
	/**
	 * This hook owns its copy of the cast rather than reading a store, so a write issued from a row —
	 * or from the edit/add modals, which go through the stores — would otherwise leave the tree stale.
	 * Every successful write bumps this counter, which re-runs the fetch below.
	 */
	const writeVersion = castWriteSignal.version;

	// Blanking is tied to the GUILD changing, never to a refetch: a write-triggered reload must not
	// drop the tree back to "Loading…" and collapse the section the user is working in.
	useEffect(() => {
		setCast(null);
	}, [guildId]);

	useEffect(() => {
		if (!guildId) {
			setError(null);
			return;
		}
		// `cancelled` rather than a token: the state is local, so a guild change re-runs the effect and
		// a late response from the previous guild must not land.
		let cancelled = false;
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
	}, [guildId, writeVersion]);

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
 * The Cast Overview tree itself — every scope's own cast rows, editable in place.
 *
 * Shell-free on purpose: the desktop side panel and the mobile channel-details sheet each wrap this
 * in their own container and scroller, so this renders no width, background or frame of its own. The
 * rows are shared verbatim between the two, so there is nothing platform-specific here either.
 *
 * Each group shows only what its scope decides LOCALLY. An inherited character has no row until it
 * is added here explicitly, which is what the per-scope Add picker is for.
 */
export const CastOverviewContent: React.FC<{guildId: string | null | undefined}> = observer(
	function CastOverviewContent({guildId}) {
		const {i18n} = useLingui();
		const {tree, error} = useCastOverviewTree(guildId);

		/**
		 * The picker reads and writes through whichever store matches the scope, and both are loaded
		 * per-scope rather than per-guild. Loading before the modal opens is what lets it be reused
		 * here unchanged: without it the scoped store is still pointed at the last scope some settings
		 * tab opened, and the add would land there instead.
		 */
		const openAddCharacter = async (scopeId: string | null) => {
			if (!guildId) return;
			if (scopeId == null) {
				await Cast.load(guildId);
			} else {
				await ChannelCast.load(guildId, scopeId);
			}
			ModalCommands.push(
				modal(() => (
					<CastAddCharacterModal
						guildId={guildId}
						channelId={scopeId}
						// This page shows each scope's LOCAL rows only, so an inherited character has no row
						// here and the picker is the only way to pull it local — which is what has to happen
						// before it can be excluded or overridden at this scope.
						offerInheritedCharacters
						data-flx="cast.cast-overview-content.add-character-modal"
					/>
				)),
			);
		};

		const renderGroup = (group: CastOverviewGroup, nested: boolean) => {
			const label = group.kind === 'server' ? 'Server-wide' : group.name;
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
						{/* Icon-only, and styled exactly as the app's Add friend affordance.
						    Icon: UserCirclePlusIcon weight="fill" — the component AddFriendView.tsx renders
						    under .heroIcon (AddFriendView.module.css). Only the glyph is reused; .heroIcon's
						    own 4rem sizing is a hero treatment, so the icon is sized for a button here.
						    Colour: variant="primary" (--brand-primary), which is what the Add friend submit
						    button in AddFriendForm.tsx resolves to — it passes no variant, and Button
						    defaults to primary. The previous "secondary" was the dark/unstyled look.
						    Square + aria-label rather than a text label, matching the icon-only Add friend
						    button in UserProfileModal.tsx (square, icon, aria-label). */}
						<Button
							type="button"
							variant="primary"
							small
							square
							icon={
								<UserCirclePlusIcon
									weight="fill"
									className={styles.buttonIcon}
									data-flx="cast.cast-overview-content.user-circle-plus-icon"
								/>
							}
							aria-label={i18n._(ADD_CHARACTER_DESCRIPTOR)}
							onClick={() => void openAddCharacter(group.scopeId)}
							data-flx="cast.cast-overview-content.button.add"
						/>
					</div>
					{/* An empty scope renders as just its header and Add button — that is how it gets its
					    first override, so there is no "nothing here" copy to add. */}
					{group.entries.length > 0 && (
						<div className={styles.entryList}>
							{group.entries.map((entry) => (
								<CastOverviewRow
									key={entry.characterId}
									guildId={guildId as string}
									scopeId={group.scopeId}
									scopeKind={group.kind}
									entry={entry}
									data-flx="cast.cast-overview-content.cast-overview-row"
								/>
							))}
						</div>
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
