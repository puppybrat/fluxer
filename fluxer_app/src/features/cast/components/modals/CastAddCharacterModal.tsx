// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import {StatusSlate} from '@app/features/app/components/dialogs/shared/StatusSlate';
import styles from '@app/features/cast/components/modals/CastAddCharacterModal.module.css';
import Cast from '@app/features/cast/state/Cast';
import ChannelCast from '@app/features/cast/state/ChannelCast';
import {CANCEL_DESCRIPTOR, TRY_AGAIN_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {Spinner} from '@app/features/ui/components/Spinner';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {UsersThreeIcon, WarningCircleIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useCallback, useEffect, useMemo, useState} from 'react';

const ADD_CHARACTER_DESCRIPTOR = msg({
	message: 'Add character',
	comment: 'Title of the modal for adding a character to a community cast. Keep it concise.',
});
const SEARCH_PLACEHOLDER_DESCRIPTOR = msg({
	message: 'Search characters',
	comment: 'Placeholder for the search field in the cast add-character modal. Keep it concise.',
});
const ADD_DESCRIPTOR = msg({
	message: 'Add',
	comment: 'Button label to add one character to the cast. Keep it concise.',
});
/*
 * Placeholder-free on purpose: the character name is composed in JSX rather than interpolated by
 * ICU. A descriptor carrying {label} renders as raw source text if its id is ever missing from the
 * compiled catalog, so keeping the sentence standalone means a missing entry still degrades to
 * "Ada was added to the cast" instead of leaking "Added {label} to the cast".
 */
const ADDED_TO_CAST_DESCRIPTOR = msg({
	message: 'was added to the cast',
	comment: 'Success toast after adding a character, shown after the character name.',
});

/**
 * Serves both the guild (server-scope) tab and the channel/category (scoped) tabs. With a
 * `channelId` the picker reads from and writes through the scoped `ChannelCast` store — offering the
 * full roster so a character already in the server cast can still be added locally — otherwise it is
 * the unchanged server-scope picker backed by `Cast`.
 *
 * `offerInheritedCharacters` picks which scoped exclusion rule applies, and defaults to the settings
 * tab's: that tab lists inherited rows itself, so offering them here too would be a second way to do
 * what the row already does. A surface showing LOCAL rows only opts in, because for it the picker is
 * the one way an inherited character becomes local. It has no effect at server scope, where nothing
 * is inherited.
 */
export const CastAddCharacterModal: React.FC<{
	guildId: string;
	channelId?: string | null;
	offerInheritedCharacters?: boolean;
}> = observer(({guildId, channelId, offerInheritedCharacters = false}) => {
		const {i18n} = useLingui();
		const [query, setQuery] = useState('');
		const scoped = channelId != null;

		const loadAll = useCallback(() => {
			if (scoped) {
				void ChannelCast.loadAllCharacters(guildId);
			} else {
				void Cast.loadAllCharacters(guildId);
			}
		}, [scoped, guildId]);

		useEffect(() => {
			loadAll();
		}, [loadAll]);

		const rosterLoading = scoped ? ChannelCast.allCharactersLoading : Cast.allCharactersLoading;
		const rosterError = scoped ? ChannelCast.allCharactersError : Cast.allCharactersError;
		const writeError = scoped ? ChannelCast.writeError : Cast.writeError;
		const isPending = (characterId: string): boolean =>
			scoped ? ChannelCast.isPending(characterId) : Cast.isPending(characterId);

		const scopedAddable = offerInheritedCharacters
			? ChannelCast.locallyAddableCharacters
			: ChannelCast.addableCharacters;
		const addable = scoped ? scopedAddable : Cast.addableCharacters;
		const filtered = useMemo(() => {
			const needle = query.trim().toLowerCase();
			if (needle === '') {
				return addable;
			}
			return addable.filter((character) => {
				const name = (character.name ?? '').toLowerCase();
				const alias = (character.alias ?? '').toLowerCase();
				return name.includes(needle) || alias.includes(needle) || character.id.includes(needle);
			});
		}, [addable, query]);

		const handleAdd = useCallback(
			async (characterId: string, label: string) => {
				const ok = scoped ? await ChannelCast.addLocal(characterId) : await Cast.addCharacter(guildId, characterId);
				if (!ok) {
					return;
				}
				ToastCommands.createToast({
					type: 'success',
					children: (
						<>
							{label} {i18n._(ADDED_TO_CAST_DESCRIPTOR)}
						</>
					),
				});
			},
			[scoped, guildId, i18n],
		);

		return (
			<Modal.Root size="small" centered data-flx="cast.add-character-modal.modal-root">
				<Modal.Header title={i18n._(ADD_CHARACTER_DESCRIPTOR)} data-flx="cast.add-character-modal.modal-header" />
				<Modal.Content data-flx="cast.add-character-modal.modal-content">
					<Modal.ContentLayout data-flx="cast.add-character-modal.modal-content-layout">
						<input
							type="text"
							className={styles.searchInput}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={i18n._(SEARCH_PLACEHOLDER_DESCRIPTOR)}
							aria-label={i18n._(SEARCH_PLACEHOLDER_DESCRIPTOR)}
							data-flx="cast.add-character-modal.search-input"
						/>

						{rosterLoading && (
							<div className={styles.spinnerContainer} data-flx="cast.add-character-modal.spinner-container">
								<Spinner data-flx="cast.add-character-modal.spinner" />
							</div>
						)}

						{!rosterLoading && rosterError != null && (
							<StatusSlate
								Icon={WarningCircleIcon}
								title={<Trans>Failed to load characters</Trans>}
								description={<Trans>There was an error loading the character list. Try again.</Trans>}
								actions={[{text: i18n._(TRY_AGAIN_DESCRIPTOR), onClick: loadAll, variant: 'primary'}]}
								data-flx="cast.add-character-modal.status-slate"
							/>
						)}

						{!rosterLoading && rosterError == null && filtered.length === 0 && (
							<StatusSlate
								Icon={UsersThreeIcon}
								title={<Trans>No characters to add</Trans>}
								description={<Trans>Every available character is already in this community's cast.</Trans>}
								data-flx="cast.add-character-modal.status-slate--2"
							/>
						)}

						{!rosterLoading && rosterError == null && filtered.length > 0 && (
							<div className={styles.characterList} data-flx="cast.add-character-modal.character-list">
								{filtered.map((character) => {
									const label = character.name ?? character.id;
									return (
										<div
											key={character.id}
											className={styles.characterItem}
											data-flx="cast.add-character-modal.character-item"
										>
											<div className={styles.characterInfo} data-flx="cast.add-character-modal.character-info">
												<span className={styles.characterName} data-flx="cast.add-character-modal.character-name">
													{label}
												</span>
												{character.alias != null && character.alias !== '' && (
													<span className={styles.characterAlias} data-flx="cast.add-character-modal.character-alias">
														{character.alias}
													</span>
												)}
											</div>
											<Button
												type="button"
												variant="primary"
												small
												submitting={isPending(character.id)}
												onClick={() => void handleAdd(character.id, label)}
												data-flx="cast.add-character-modal.button.add"
											>
												{i18n._(ADD_DESCRIPTOR)}
											</Button>
										</div>
									);
								})}
							</div>
						)}

						{writeError != null && (
							<div className={styles.errorText} role="alert" data-flx="cast.add-character-modal.error-text">
								<Trans>Failed to add character. Try again.</Trans>
							</div>
						)}
					</Modal.ContentLayout>
				</Modal.Content>
				<Modal.Footer data-flx="cast.add-character-modal.modal-footer">
					<Button
						type="button"
						variant="secondary"
						onClick={() => ModalCommands.pop()}
						data-flx="cast.add-character-modal.button.close"
					>
						{i18n._(CANCEL_DESCRIPTOR)}
					</Button>
				</Modal.Footer>
			</Modal.Root>
		);
	},
);
