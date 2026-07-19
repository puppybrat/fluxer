// SPDX-License-Identifier: AGPL-3.0-or-later

import {ConfirmModal} from '@app/features/app/components/dialogs/ConfirmModal';
import {StatusSlate} from '@app/features/app/components/dialogs/shared/StatusSlate';
import {CastAddCharacterModal} from '@app/features/cast/components/modals/CastAddCharacterModal';
import {CastEditOverrideModal} from '@app/features/cast/components/modals/CastEditOverrideModal';
import type {CastCharacter} from '@app/features/cast/commands/CastCommands';
import Cast from '@app/features/cast/state/Cast';
import styles from '@app/features/guild/components/modals/guild_tabs/GuildCastTab.module.css';
import {CANCEL_DESCRIPTOR, TRY_AGAIN_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import {Checkbox} from '@app/features/ui/checkbox/Checkbox';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {Spinner} from '@app/features/ui/components/Spinner';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {StarIcon, UsersThreeIcon, WarningCircleIcon} from '@phosphor-icons/react';
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
	comment: 'Button label to remove a character from the cast. Keep it concise.',
});
const REMOVE_CHARACTER_DESCRIPTOR = msg({
	message: 'Remove character',
	comment: 'Title of the confirmation modal for removing a character from the cast. Keep it concise.',
});
const PRIMARY_DESCRIPTOR = msg({
	message: 'Primary',
	comment: 'Label for the checkbox marking a cast character as primary. Keep it concise.',
});

/**
 * Nickname wins over the real name whenever one is set: a character with an override is
 * more commonly referred to by it, so showing the real name would be the surprising choice.
 * The API normalises an unset override to null, so a single nullish check is enough here.
 */
function castDisplayName(character: CastCharacter): string {
	return character.nickname ?? character.name ?? character.id;
}

/**
 * The list renders flat: nothing in the schema links a character to an AU or category, so
 * there is no honest way to group them. Grouping can come back if that link is ever added.
 */
const GuildCastTab: React.FC<{guildId: string}> = observer(({guildId}) => {
	const {i18n} = useLingui();
	const loadCast = useCallback(() => {
		void Cast.load(guildId);
	}, [guildId]);

	useEffect(() => {
		loadCast();
		return () => {
			Cast.reset();
		};
	}, [loadCast]);

	const characters = Cast.characters;

	const handleAddClick = useCallback(() => {
		ModalCommands.push(ModalCommands.modal(() => <CastAddCharacterModal guildId={guildId} />));
	}, [guildId]);

	const handleEditClick = useCallback(
		(character: CastCharacter) => {
			// Prefilled from the read, which now carries the override. Editing one field no longer
			// silently clears the other, which is what happened while both opened blank.
			ModalCommands.push(
				ModalCommands.modal(() => (
					<CastEditOverrideModal
						guildId={guildId}
						character={character}
						currentNickname={character.nickname}
						currentPfpUrl={character.pfp_url}
					/>
				)),
			);
		},
		[guildId],
	);

	const handleRemoveClick = useCallback(
		(character: CastCharacter) => {
			const label = castDisplayName(character);
			ModalCommands.push(
				ModalCommands.modal(() => (
					<ConfirmModal
						title={i18n._(REMOVE_CHARACTER_DESCRIPTOR)}
						description={
							<Trans>
								Are you sure you want to remove <strong>{label}</strong> from this community's cast? Any nickname or
								avatar override for this character is removed too.
							</Trans>
						}
						primaryText={i18n._(REMOVE_DESCRIPTOR)}
						primaryVariant="danger"
						secondaryText={i18n._(CANCEL_DESCRIPTOR)}
						onPrimary={async () => {
							const ok = await Cast.removeCharacter(guildId, character.id);
							if (!ok) {
								return;
							}
							ToastCommands.createToast({
								type: 'success',
								children: <Trans>Removed {label} from the cast</Trans>,
							});
						}}
						data-flx="guild.guild-tabs.guild-cast-tab.confirm-modal.remove"
					/>
				)),
			);
		},
		[guildId, i18n],
	);

	const handlePrimaryChange = useCallback(
		(character: CastCharacter, isPrimary: boolean) => {
			void Cast.setPrimary(guildId, character.id, isPrimary);
		},
		[guildId],
	);

	return (
		<div className={styles.container} data-flx="guild.guild-tabs.guild-cast-tab.container">
			<div className={styles.header} data-flx="guild.guild-tabs.guild-cast-tab.header">
				<div className={styles.headerText} data-flx="guild.guild-tabs.guild-cast-tab.header-text">
					<h2 className={styles.title} data-flx="guild.guild-tabs.guild-cast-tab.title">
						<Trans>Cast</Trans>
					</h2>
					<p className={styles.subtitle} data-flx="guild.guild-tabs.guild-cast-tab.subtitle">
						<Trans>Characters available in this community, and which are currently primary.</Trans>
					</p>
				</div>
				<Button
					type="button"
					variant="primary"
					onClick={handleAddClick}
					disabled={Cast.loading || Cast.error != null}
					data-flx="guild.guild-tabs.guild-cast-tab.button.add"
				>
					{i18n._(ADD_CHARACTER_DESCRIPTOR)}
				</Button>
			</div>

			{Cast.loading && (
				<div className={styles.spinnerContainer} data-flx="guild.guild-tabs.guild-cast-tab.spinner-container">
					<Spinner data-flx="guild.guild-tabs.guild-cast-tab.spinner" />
				</div>
			)}

			{!Cast.loading && Cast.error != null && (
				<StatusSlate
					Icon={WarningCircleIcon}
					title={<Trans>Failed to load cast</Trans>}
					description={<Trans>There was an error loading the cast for this community. Try again.</Trans>}
					actions={[
						{
							text: i18n._(TRY_AGAIN_DESCRIPTOR),
							onClick: loadCast,
							variant: 'primary',
						},
					]}
					fullHeight={true}
					data-flx="guild.guild-tabs.guild-cast-tab.status-slate"
				/>
			)}

			{/* Write failures surface here rather than silently no-oping. Read errors take the
			    slate above; this is the narrower "your edit did not apply" case. */}
			{!Cast.loading && Cast.error == null && Cast.writeError != null && (
				<div className={styles.writeError} role="alert" data-flx="guild.guild-tabs.guild-cast-tab.write-error">
					<Trans>That change didn't apply. Try again.</Trans>
				</div>
			)}

			{!Cast.loading && Cast.error == null && characters.length === 0 && (
				<StatusSlate
					Icon={UsersThreeIcon}
					title={<Trans>No cast configured</Trans>}
					description={<Trans>This community doesn't have any cast characters mapped to it yet.</Trans>}
					fullHeight={true}
					data-flx="guild.guild-tabs.guild-cast-tab.status-slate--2"
				/>
			)}

			{!Cast.loading && Cast.error == null && characters.length > 0 && (
				<div className={styles.characterList} data-flx="guild.guild-tabs.guild-cast-tab.character-list">
					{characters.map((character) => {
						const pending = Cast.isPending(character.id);
						return (
							<div
								key={character.id}
								className={styles.characterItem}
								data-flx="guild.guild-tabs.guild-cast-tab.character-item"
							>
								<span className={styles.characterName} data-flx="guild.guild-tabs.guild-cast-tab.character-name">
									{castDisplayName(character)}
								</span>
								{character.alias != null && character.alias !== '' && (
									<span className={styles.characterAlias} data-flx="guild.guild-tabs.guild-cast-tab.character-alias">
										{character.alias}
									</span>
								)}
								{Cast.isPrimary(character.id) && (
									<span className={styles.primaryBadge} data-flx="guild.guild-tabs.guild-cast-tab.primary-badge">
										<StarIcon size={12} weight="fill" data-flx="guild.guild-tabs.guild-cast-tab.primary-icon" />
										<Trans>Primary</Trans>
									</span>
								)}

								<div className={styles.characterActions} data-flx="guild.guild-tabs.guild-cast-tab.character-actions">
									<Checkbox
										checked={Cast.isPrimary(character.id)}
										disabled={pending}
										onChange={(checked: boolean) => handlePrimaryChange(character, checked)}
										aria-label={i18n._(PRIMARY_DESCRIPTOR)}
										data-flx="guild.guild-tabs.guild-cast-tab.checkbox.primary"
									/>
									<Button
										type="button"
										variant="secondary"
										small
										disabled={pending}
										onClick={() => handleEditClick(character)}
										data-flx="guild.guild-tabs.guild-cast-tab.button.edit"
									>
										{i18n._(EDIT_DESCRIPTOR)}
									</Button>
									<Button
										type="button"
										variant="danger"
										small
										disabled={pending}
										onClick={() => handleRemoveClick(character)}
										data-flx="guild.guild-tabs.guild-cast-tab.button.remove"
									>
										{i18n._(REMOVE_DESCRIPTOR)}
									</Button>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
});

export default GuildCastTab;
