// SPDX-License-Identifier: AGPL-3.0-or-later

import {ConfirmModal} from '@app/features/app/components/dialogs/ConfirmModal';
import {StatusSlate} from '@app/features/app/components/dialogs/shared/StatusSlate';
import {CastAddCharacterModal} from '@app/features/cast/components/modals/CastAddCharacterModal';
import {CastEditOverrideModal} from '@app/features/cast/components/modals/CastEditOverrideModal';
import type {CastScopedRow} from '@app/features/cast/state/ChannelCast';
import ChannelCast from '@app/features/cast/state/ChannelCast';
import styles from '@app/features/channel/components/modals/channel_tabs/ChannelCastTab.module.css';
import Channels from '@app/features/channel/state/Channels';
import {CANCEL_DESCRIPTOR, TRY_AGAIN_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import {Checkbox} from '@app/features/ui/checkbox/Checkbox';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {Spinner} from '@app/features/ui/components/Spinner';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {EyeSlashIcon, StarIcon, UsersThreeIcon, WarningCircleIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useCallback, useEffect} from 'react';

const ADD_CHARACTER_DESCRIPTOR = msg({
	message: 'Add character',
	comment: 'Button label to open the cast character picker. Keep it concise.',
});
const EDIT_DESCRIPTOR = msg({
	message: 'Edit',
	comment: 'Button label to edit a cast character display override. Keep it concise.',
});
const REMOVE_DESCRIPTOR = msg({
	message: 'Remove',
	comment: 'Button label to remove a character from this scope. Keep it concise.',
});
const REMOVE_CHARACTER_DESCRIPTOR = msg({
	message: 'Remove character',
	comment: 'Title of the confirmation modal for removing a character from a channel scope. Keep it concise.',
});
const EXCLUDE_DESCRIPTOR = msg({
	message: 'Exclude',
	comment: 'Button label to hide an inherited cast character in this channel or category. Keep it concise.',
});
const UNEXCLUDE_DESCRIPTOR = msg({
	message: 'Un-exclude',
	comment: 'Button label to stop hiding a cast character in this channel or category. Keep it concise.',
});
const PRIMARY_DESCRIPTOR = msg({
	message: 'Primary',
	comment: 'Label for the checkbox marking a cast character as primary. Keep it concise.',
});

function castPrimaryName(row: CastScopedRow): string {
	return row.character.name ?? row.character.id;
}

/**
 * Secondary line: the effective nickname when the character is present, otherwise the alias. Null
 * when neither exists, which the caller uses to omit the element.
 */
function castSecondaryLabel(row: CastScopedRow): string | null {
	if (row.resolvedNickname != null && row.resolvedNickname !== '') {
		return row.resolvedNickname;
	}
	if (row.character.alias != null && row.character.alias !== '') {
		return row.character.alias;
	}
	return null;
}

/**
 * The Cast tab shared by category settings and channel settings. The "scope" is simply the id of the
 * thing being edited — a category's own channel id, or a channel's own id — passed straight through
 * to the scoped `ChannelCast` store. Every character present or explicitly hidden here shows in one
 * list, tagged local / inherited / excluded, with the one action that applies to its state.
 */
const ChannelCastTab: React.FC<{channelId: string}> = observer(({channelId}) => {
	const {i18n} = useLingui();
	const channel = Channels.getChannel(channelId);
	const guildId = channel?.guildId;
	const isCategory = channel?.type === ChannelTypes.GUILD_CATEGORY;

	const loadCast = useCallback(() => {
		if (guildId != null) {
			void ChannelCast.load(guildId, channelId);
		}
	}, [guildId, channelId]);

	useEffect(() => {
		loadCast();
		return () => {
			ChannelCast.reset();
		};
	}, [loadCast]);

	const handleAddClick = useCallback(() => {
		if (guildId == null) {
			return;
		}
		ModalCommands.push(ModalCommands.modal(() => <CastAddCharacterModal guildId={guildId} channelId={channelId} />));
	}, [guildId, channelId]);

	const handleEditClick = useCallback(
		async (row: CastScopedRow) => {
			if (guildId == null) {
				return;
			}
			// Editing an inherited character takes local control of it first: an override needs a local
			// membership row at this scope (the backend rejects one otherwise), so silently add it, then
			// edit. A local row already has membership and skips straight to the modal.
			if (row.status === 'inherited') {
				const ok = await ChannelCast.addLocal(row.character.id);
				if (!ok) {
					return;
				}
			}
			// Pre-fill strictly from the LOCAL override row at this scope (empty when none exists), never
			// from the resolved/inherited values — saving unchanged would otherwise promote an inherited
			// value into a real local override here. A just-promoted character has no override yet, so it
			// opens blank, which is correct.
			ModalCommands.push(
				ModalCommands.modal(() => (
					<CastEditOverrideModal
						guildId={guildId}
						channelId={channelId}
						character={row.character}
						currentNickname={row.localOverride?.nickname ?? null}
						currentPfpUrl={row.localOverride?.pfpUrl ?? null}
						currentReferenceImageUrl={row.localOverride?.referenceImageUrl ?? null}
					/>
				)),
			);
		},
		[guildId, channelId],
	);

	const handleRemoveClick = useCallback(
		(row: CastScopedRow) => {
			const label = castPrimaryName(row);
			ModalCommands.push(
				ModalCommands.modal(() => (
					<ConfirmModal
						title={i18n._(REMOVE_CHARACTER_DESCRIPTOR)}
						description={
							<Trans>
								Remove <strong>{label}</strong> from this scope? Its local nickname or avatar override here is removed
								too. If a parent category or the community still lists it, it goes back to inheriting from there.
							</Trans>
						}
						primaryText={i18n._(REMOVE_DESCRIPTOR)}
						primaryVariant="danger"
						secondaryText={i18n._(CANCEL_DESCRIPTOR)}
						onPrimary={async () => {
							const ok = await ChannelCast.removeLocal(row.character.id);
							if (!ok) {
								return;
							}
							ToastCommands.createToast({type: 'success', children: <Trans>Removed {label}</Trans>});
						}}
						data-flx="channel.channel-tabs.channel-cast-tab.confirm-modal.remove"
					/>
				)),
			);
		},
		[i18n],
	);

	const handleExcludeClick = useCallback((row: CastScopedRow) => {
		void ChannelCast.exclude(row.character.id);
	}, []);

	const handleUnexcludeClick = useCallback((row: CastScopedRow) => {
		void ChannelCast.unexclude(row.character.id);
	}, []);

	const handlePrimaryChange = useCallback(async (row: CastScopedRow, isPrimary: boolean) => {
		// Same as Edit: setting primary on an inherited character needs a local membership row first,
		// so silently take local control, then toggle. The character becomes "local" afterward.
		if (row.status === 'inherited') {
			const ok = await ChannelCast.addLocal(row.character.id);
			if (!ok) {
				return;
			}
		}
		void ChannelCast.setPrimary(row.character.id, isPrimary);
	}, []);

	if (channel == null || guildId == null) {
		return null;
	}

	const rows = ChannelCast.rows;

	return (
		<div className={styles.container} data-flx="channel.channel-tabs.channel-cast-tab.container">
			<div className={styles.header} data-flx="channel.channel-tabs.channel-cast-tab.header">
				<div className={styles.headerText} data-flx="channel.channel-tabs.channel-cast-tab.header-text">
					<h2 className={styles.title} data-flx="channel.channel-tabs.channel-cast-tab.title">
						<Trans>Cast</Trans>
					</h2>
					<p className={styles.subtitle} data-flx="channel.channel-tabs.channel-cast-tab.subtitle">
						{isCategory ? (
							<Trans>
								Characters for this category. Inherited ones come from the community; add, hide, or override them here
								for every channel inside it.
							</Trans>
						) : (
							<Trans>
								Characters for this channel. Inherited ones come from its category or the community; add, hide, or
								override them just here.
							</Trans>
						)}
					</p>
				</div>
				<Button
					type="button"
					variant="primary"
					onClick={handleAddClick}
					disabled={ChannelCast.loading || ChannelCast.error != null}
					data-flx="channel.channel-tabs.channel-cast-tab.button.add"
				>
					{i18n._(ADD_CHARACTER_DESCRIPTOR)}
				</Button>
			</div>

			{ChannelCast.loading && (
				<div className={styles.spinnerContainer} data-flx="channel.channel-tabs.channel-cast-tab.spinner-container">
					<Spinner data-flx="channel.channel-tabs.channel-cast-tab.spinner" />
				</div>
			)}

			{!ChannelCast.loading && ChannelCast.error != null && (
				<StatusSlate
					Icon={WarningCircleIcon}
					title={<Trans>Failed to load cast</Trans>}
					description={<Trans>There was an error loading the cast for this scope. Try again.</Trans>}
					actions={[{text: i18n._(TRY_AGAIN_DESCRIPTOR), onClick: loadCast, variant: 'primary'}]}
					fullHeight={true}
					data-flx="channel.channel-tabs.channel-cast-tab.status-slate"
				/>
			)}

			{!ChannelCast.loading && ChannelCast.error == null && ChannelCast.writeError != null && (
				<div className={styles.writeError} role="alert" data-flx="channel.channel-tabs.channel-cast-tab.write-error">
					<Trans>That change didn't apply. Try again.</Trans>
				</div>
			)}

			{!ChannelCast.loading && ChannelCast.error == null && rows.length === 0 && (
				<StatusSlate
					Icon={UsersThreeIcon}
					title={<Trans>No cast here</Trans>}
					description={<Trans>No characters are available or hidden in this scope yet.</Trans>}
					fullHeight={true}
					data-flx="channel.channel-tabs.channel-cast-tab.status-slate--2"
				/>
			)}

			{!ChannelCast.loading && ChannelCast.error == null && rows.length > 0 && (
				<div className={styles.characterList} data-flx="channel.channel-tabs.channel-cast-tab.character-list">
					{rows.map((row) => {
						const pending = ChannelCast.isPending(row.character.id);
						const secondary = castSecondaryLabel(row);
						return (
							<div
								key={row.character.id}
								className={`${styles.characterItem} ${row.status === 'excluded' ? styles.excludedItem : ''}`}
								data-flx="channel.channel-tabs.channel-cast-tab.character-item"
							>
								<span className={styles.characterName} data-flx="channel.channel-tabs.channel-cast-tab.character-name">
									{castPrimaryName(row)}
								</span>
								{secondary != null && (
									<span
										className={styles.characterAlias}
										data-flx="channel.channel-tabs.channel-cast-tab.character-alias"
									>
										{secondary}
									</span>
								)}

								{row.status === 'local' && (
									<span
										className={`${styles.statusBadge} ${styles.statusLocal}`}
										data-flx="channel.channel-tabs.channel-cast-tab.status-badge.local"
									>
										<Trans>Local</Trans>
									</span>
								)}
								{row.status === 'inherited' && (
									<span
										className={`${styles.statusBadge} ${styles.statusInherited}`}
										data-flx="channel.channel-tabs.channel-cast-tab.status-badge.inherited"
									>
										<Trans>Inherited</Trans>
									</span>
								)}
								{row.status === 'excluded' && (
									<span
										className={`${styles.statusBadge} ${styles.statusExcluded}`}
										data-flx="channel.channel-tabs.channel-cast-tab.status-badge.excluded"
									>
										<EyeSlashIcon size={12} data-flx="channel.channel-tabs.channel-cast-tab.excluded-icon" />
										<Trans>Excluded</Trans>
									</span>
								)}
								{row.isPrimary && row.status !== 'excluded' && (
									<span className={styles.primaryBadge} data-flx="channel.channel-tabs.channel-cast-tab.primary-badge">
										<StarIcon size={12} weight="fill" data-flx="channel.channel-tabs.channel-cast-tab.primary-icon" />
										<Trans>Primary</Trans>
									</span>
								)}

								<div
									className={styles.characterActions}
									data-flx="channel.channel-tabs.channel-cast-tab.character-actions"
								>
									{/* Every present character — local OR inherited — gets Primary + Edit. Acting on an
									    inherited one silently takes local control first (see the handlers). They differ
									    only in the destructive action: Remove drops a local character's own rows, while
									    Exclude hides an inherited one that a broader scope still provides. */}
									{(row.status === 'local' || row.status === 'inherited') && (
										<>
											<Checkbox
												checked={row.isPrimary}
												disabled={pending}
												onChange={(checked: boolean) => handlePrimaryChange(row, checked)}
												aria-label={i18n._(PRIMARY_DESCRIPTOR)}
												data-flx="channel.channel-tabs.channel-cast-tab.checkbox.primary"
											/>
											<Button
												type="button"
												variant="secondary"
												small
												disabled={pending}
												onClick={() => handleEditClick(row)}
												data-flx="channel.channel-tabs.channel-cast-tab.button.edit"
											>
												{i18n._(EDIT_DESCRIPTOR)}
											</Button>
											{row.status === 'local' ? (
												<Button
													type="button"
													variant="danger"
													small
													disabled={pending}
													onClick={() => handleRemoveClick(row)}
													data-flx="channel.channel-tabs.channel-cast-tab.button.remove"
												>
													{i18n._(REMOVE_DESCRIPTOR)}
												</Button>
											) : (
												<Button
													type="button"
													variant="secondary"
													small
													disabled={pending}
													onClick={() => handleExcludeClick(row)}
													data-flx="channel.channel-tabs.channel-cast-tab.button.exclude"
												>
													{i18n._(EXCLUDE_DESCRIPTOR)}
												</Button>
											)}
										</>
									)}
									{row.status === 'excluded' && (
										<Button
											type="button"
											variant="secondary"
											small
											disabled={pending}
											onClick={() => handleUnexcludeClick(row)}
											data-flx="channel.channel-tabs.channel-cast-tab.button.unexclude"
										>
											{i18n._(UNEXCLUDE_DESCRIPTOR)}
										</Button>
									)}
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
});

export default ChannelCastTab;
