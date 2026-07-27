// SPDX-License-Identifier: AGPL-3.0-or-later

import {ConfirmModal} from '@app/features/app/components/dialogs/ConfirmModal';
import styles from '@app/features/cast/components/CastOverviewRow.module.css';
import {CastEditOverrideModal} from '@app/features/cast/components/modals/CastEditOverrideModal';
import {refreshCastDisplayCaches} from '@app/features/cast/state/CastDisplayRefresh';
import ChannelCast from '@app/features/cast/state/ChannelCast';
import type {CastOverviewEntry, CastOverviewScopeKind} from '@app/features/cast/utils/CastOverviewTree';
import {
	castOverviewRowControls,
	excludeWrite,
	primaryWrite,
	removeWrite,
	runCastRowWrite,
} from '@app/features/cast/utils/CastOverviewRowModel';
import {CANCEL_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {DataMenuRenderer} from '@app/features/ui/action_menu/DataMenuRenderer';
import {Checkbox} from '@app/features/ui/checkbox/Checkbox';
import * as ContextMenuCommands from '@app/features/ui/commands/ContextMenuCommands';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {useContextMenuTrigger} from '@app/features/ui/hooks/useContextMenuTrigger';
import {MenuBottomSheet, type MenuGroupType} from '@app/features/ui/menu_bottom_sheet/MenuBottomSheet';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import {openExternalUrl} from '@app/features/ui/utils/NativeUtils';
import {BaseAvatar} from '@app/features/ui/components/BaseAvatar';
import {clsx} from 'clsx';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {DotsThreeVerticalIcon, EyeSlashIcon, XIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useCallback, useState} from 'react';

const PRIMARY_DESCRIPTOR = msg({
	message: 'Primary',
	comment: 'Label for the checkbox marking a cast character as primary. Keep it concise.',
});
const EXCLUDE_DESCRIPTOR = msg({
	message: 'Exclude',
	comment: 'Label for the checkbox hiding a cast character in this category or channel. Keep it concise.',
});
const REMOVE_DESCRIPTOR = msg({
	message: 'Remove',
	comment: 'Button label removing a character row from this scope. Keep it concise.',
});
const REMOVE_CHARACTER_DESCRIPTOR = msg({
	message: 'Remove character',
	comment: 'Title of the confirmation modal for removing a character row. Keep it concise.',
});
const MORE_ACTIONS_DESCRIPTOR = msg({
	message: 'More actions',
	comment: 'Accessible label for the three-dot menu button on a cast character row. Keep it concise.',
});
const EDIT_DESCRIPTOR = msg({
	message: 'Edit',
	comment: 'Menu entry opening the cast character display editor. Keep it concise.',
});
const VIEW_PROFILE_DESCRIPTOR = msg({
	message: 'View profile',
	comment: "Menu entry opening a character's public profile page on the website. Keep it concise.",
});
const WRITE_FAILED_DESCRIPTOR = msg({
	message: "That change didn't apply. Try again.",
	comment: 'Toast shown when a cast edit on the overview page fails.',
});

/**
 * One character inside one scope of the Cast Overview.
 *
 * Shared verbatim by desktop and mobile — the layout is a single flex row that wraps, so there is no
 * second variant to keep in sync. Only the three-dot menu differs in PRESENTATION (a context menu
 * against the button on desktop, a bottom sheet on mobile), which is the same split every other menu
 * in the app makes, driven from one list of menu items.
 *
 * Every row here is LOCAL to its scope by construction — CastOverviewTree only ever emits a scope's
 * own added/edited/excluded rows, never anything inherited — so the destructive action is always
 * available and always means the same thing.
 */
export const CastOverviewRow: React.FC<{
	guildId: string;
	/** The category/channel this row's scope is, or null for the server-wide group. */
	scopeId: string | null;
	scopeKind: CastOverviewScopeKind;
	entry: CastOverviewEntry;
}> = observer(function CastOverviewRow({guildId, scopeId, scopeKind, entry}) {
	const {i18n} = useLingui();
	const [pending, setPending] = useState(false);
	const [sheetOpen, setSheetOpen] = useState(false);
	const {isOpen: isContextMenuOpen, withTracking} = useContextMenuTrigger();
	const isMobile = MobileLayout.enabled;
	// Lights the trigger and the row while this row's own menu is showing, either presentation.
	const menuActive = isContextMenuOpen || sheetOpen;
	// Every visibility rule lives in the model, so this component is a transcription of it rather than
	// a second place the rules could drift.
	const {isExcluded, isPrimary, canExclude, canRemove, profileUrl} = castOverviewRowControls(scopeKind, entry);

	/**
	 * Writes go straight through CastCommands with an explicit scope rather than through the
	 * ChannelCast store, which binds itself to ONE scope at a time — this page shows many at once, so
	 * routing a row's write through it would target whichever scope happened to be loaded last.
	 *
	 * refreshCastDisplayCaches is therefore called here explicitly: it is what the stores run after
	 * their own writes, and skipping it would leave an open message list rendering the old identity.
	 */
	const runWrite = useCallback(
		async (action: () => Promise<unknown>) => {
			setPending(true);
			try {
				await action();
				refreshCastDisplayCaches(guildId);
			} catch {
				ToastCommands.createToast({type: 'error', children: i18n._(WRITE_FAILED_DESCRIPTOR)});
			} finally {
				setPending(false);
			}
		},
		[guildId, i18n],
	);

	const handlePrimaryChange = useCallback(
		(checked: boolean) => {
			void runWrite(() => runCastRowWrite(primaryWrite(guildId, scopeId, entry, checked)));
		},
		[runWrite, guildId, scopeId, entry],
	);

	const handleExcludeChange = useCallback(
		(checked: boolean) => {
			void runWrite(() => runCastRowWrite(excludeWrite(guildId, scopeId, entry, checked)));
		},
		[runWrite, guildId, scopeId, entry],
	);

	const handleRemove = useCallback(() => {
		const label = entry.name;
		ModalCommands.push(
			ModalCommands.modal(() => (
				<ConfirmModal
					title={i18n._(REMOVE_CHARACTER_DESCRIPTOR)}
					description={
						<Trans>
							Remove <strong>{label}</strong> from this scope? Its nickname, avatar and reference image set here go too.
							If a parent category or the community still lists it, it goes back to inheriting from there.
						</Trans>
					}
					primaryText={i18n._(REMOVE_DESCRIPTOR)}
					primaryVariant="danger"
					secondaryText={i18n._(CANCEL_DESCRIPTOR)}
					onPrimary={async () => {
						await runWrite(() => runCastRowWrite(removeWrite(guildId, scopeId, entry)));
					}}
					data-flx="cast.cast-overview-row.confirm-modal.remove"
				/>
			)),
		);
	}, [entry, guildId, i18n, runWrite, scopeId]);

	/**
	 * The edit modal writes through ChannelCast when it is given a channelId, so the store has to be
	 * pointed at THIS row's scope before it opens or the save lands on whichever scope was loaded
	 * last. Loading first is what makes reusing the modal unchanged safe from this page.
	 */
	const handleEdit = useCallback(async () => {
		if (scopeId != null) {
			await ChannelCast.load(guildId, scopeId);
		}
		ModalCommands.push(
			ModalCommands.modal(() => (
				<CastEditOverrideModal
					guildId={guildId}
					channelId={scopeId}
					character={entry.character}
					// Strictly this scope's own override row, never an inherited value: saving an inherited
					// value unchanged would silently promote it into a real local override here.
					currentNickname={entry.localOverride?.nickname ?? null}
					currentPfpUrl={entry.localOverride?.pfpUrl ?? null}
					currentReferenceImageUrl={entry.localOverride?.referenceImageUrl ?? null}
				/>
			)),
		);
	}, [entry.character, entry.localOverride, guildId, scopeId]);

	const handleViewProfile = useCallback(() => {
		if (profileUrl == null) {
			return;
		}
		void openExternalUrl(profileUrl);
	}, [profileUrl]);

	/**
	 * One list of menu entries, rendered two ways. `close` is threaded in rather than captured so the
	 * same builder serves the desktop context menu (which hands its own onClose to the render fn) and
	 * the mobile sheet (which is closed by local state).
	 */
	const buildMenuGroups = useCallback(
		(close: () => void): Array<MenuGroupType> => [
			{
				items: [
					{
						id: 'edit',
						label: i18n._(EDIT_DESCRIPTOR),
						onClick: () => {
							close();
							void handleEdit();
						},
					},
					// Omitted entirely when the roster carries no usable name: the slug would be built from
					// the character id and link confidently to a page that cannot exist.
					...(profileUrl != null
						? [
								{
									id: 'view-profile',
									label: i18n._(VIEW_PROFILE_DESCRIPTOR),
									onClick: () => {
										close();
										handleViewProfile();
									},
								},
							]
						: []),
				],
			},
		],
		[handleEdit, handleViewProfile, i18n, profileUrl],
	);

	const handleMenuClick = useCallback(
		(event: React.MouseEvent<HTMLElement>) => {
			if (isMobile) {
				setSheetOpen(true);
				return;
			}
			// withTracking is what keeps the trigger lit while its menu is open and clears it on any
			// dismissal, not only on selecting an item — the same hook the bans list uses.
			ContextMenuCommands.openFromEvent(
				event,
				({onClose}) => (
					<DataMenuRenderer groups={buildMenuGroups(onClose)} data-flx="cast.cast-overview-row.data-menu-renderer" />
				),
				withTracking(),
			);
		},
		[isMobile, buildMenuGroups, withTracking],
	);

	return (
		<div
			className={clsx(styles.row, isExcluded && styles.rowExcluded)}
			data-menu-active={menuActive ? '' : undefined}
			data-flx="cast.cast-overview-row.row"
		>
			<div className={styles.identity} data-flx="cast.cast-overview-row.identity">
				{/* The same avatar component and size the Members table uses, rather than a bare <img>:
				    it already handles the skeleton, sizing and fallback tag. */}
				<BaseAvatar
					size={32}
					avatarUrl={entry.pfpUrl ?? ''}
					userTag={entry.name}
					data-flx="cast.cast-overview-row.base-avatar"
				/>
				<div className={styles.nameInfo} data-flx="cast.cast-overview-row.name-info">
					<span className={styles.name} title={entry.name} data-flx="cast.cast-overview-row.name">
						{entry.name}
					</span>
					{entry.nickname != null && entry.nickname !== '' && (
						<span className={styles.nickname} title={entry.nickname} data-flx="cast.cast-overview-row.nickname">
							{entry.nickname}
						</span>
					)}
				</div>
				{isExcluded && (
					<span className={styles.excludedBadge} data-flx="cast.cast-overview-row.excluded-badge">
						<EyeSlashIcon size={12} data-flx="cast.cast-overview-row.excluded-icon" />
						<Trans>Excluded</Trans>
					</span>
				)}
			</div>

			<div className={styles.actions} data-flx="cast.cast-overview-row.actions">
				<Checkbox
					checked={isPrimary}
					disabled={pending}
					onChange={handlePrimaryChange}
					size="small"
					className={styles.toggle}
					data-flx="cast.cast-overview-row.checkbox.primary"
				>
					{i18n._(PRIMARY_DESCRIPTOR)}
				</Checkbox>

				{canExclude && (
					<Checkbox
						checked={isExcluded}
						disabled={pending}
						onChange={handleExcludeChange}
						size="small"
						className={styles.toggle}
						data-flx="cast.cast-overview-row.checkbox.exclude"
					>
						{i18n._(EXCLUDE_DESCRIPTOR)}
					</Checkbox>
				)}

				{canRemove && (
					<button
						type="button"
						className={clsx(styles.actionsButton, styles.actionsButtonDanger)}
						onClick={handleRemove}
						disabled={pending}
						aria-label={i18n._(REMOVE_DESCRIPTOR)}
						title={i18n._(REMOVE_DESCRIPTOR)}
						data-flx="cast.cast-overview-row.button.remove"
					>
						<XIcon weight="bold" size={18} data-flx="cast.cast-overview-row.remove-icon" />
					</button>
				)}

				{/* Same trigger the Members table uses: .actionsButton, data-menu-active, and a bold
				    18px DotsThreeVertical — see guild_members_page/MemberTableRow.tsx. */}
				<button
					type="button"
					className={styles.actionsButton}
					data-menu-active={menuActive ? '' : undefined}
					onClick={handleMenuClick}
					disabled={pending}
					aria-label={i18n._(MORE_ACTIONS_DESCRIPTOR)}
					aria-haspopup="menu"
					data-flx="cast.cast-overview-row.button.menu"
				>
					<DotsThreeVerticalIcon weight="bold" size={18} data-flx="cast.cast-overview-row.menu-icon" />
				</button>
			</div>

			{isMobile && (
				<MenuBottomSheet
					isOpen={sheetOpen}
					onClose={() => setSheetOpen(false)}
					title={entry.name}
					groups={buildMenuGroups(() => setSheetOpen(false))}
					data-flx="cast.cast-overview-row.menu-bottom-sheet"
				/>
			)}
		</div>
	);
});
