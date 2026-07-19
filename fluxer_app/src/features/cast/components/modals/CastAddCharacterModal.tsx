// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import {StatusSlate} from '@app/features/app/components/dialogs/shared/StatusSlate';
import styles from '@app/features/cast/components/modals/CastAddCharacterModal.module.css';
import Cast from '@app/features/cast/state/Cast';
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

/**
 * Offers the whole roster rather than anything guild-scoped, minus what is already in the
 * cast — the picker exists precisely to surface characters the tab cannot already show.
 * Primary state is deliberately absent here: it only applies once a character is a member.
 */
export const CastAddCharacterModal: React.FC<{guildId: string}> = observer(({guildId}) => {
	const {i18n} = useLingui();
	const [query, setQuery] = useState('');

	const loadAll = useCallback(() => {
		void Cast.loadAllCharacters(guildId);
	}, [guildId]);

	useEffect(() => {
		loadAll();
	}, [loadAll]);

	const addable = Cast.addableCharacters;
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
			const ok = await Cast.addCharacter(guildId, characterId);
			if (!ok) {
				return;
			}
			ToastCommands.createToast({
				type: 'success',
				children: <Trans>Added {label} to the cast</Trans>,
			});
		},
		[guildId],
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

					{Cast.allCharactersLoading && (
						<div className={styles.spinnerContainer} data-flx="cast.add-character-modal.spinner-container">
							<Spinner data-flx="cast.add-character-modal.spinner" />
						</div>
					)}

					{!Cast.allCharactersLoading && Cast.allCharactersError != null && (
						<StatusSlate
							Icon={WarningCircleIcon}
							title={<Trans>Failed to load characters</Trans>}
							description={<Trans>There was an error loading the character list. Try again.</Trans>}
							actions={[{text: i18n._(TRY_AGAIN_DESCRIPTOR), onClick: loadAll, variant: 'primary'}]}
							data-flx="cast.add-character-modal.status-slate"
						/>
					)}

					{!Cast.allCharactersLoading && Cast.allCharactersError == null && filtered.length === 0 && (
						<StatusSlate
							Icon={UsersThreeIcon}
							title={<Trans>No characters to add</Trans>}
							description={<Trans>Every available character is already in this community's cast.</Trans>}
							data-flx="cast.add-character-modal.status-slate--2"
						/>
					)}

					{!Cast.allCharactersLoading && Cast.allCharactersError == null && filtered.length > 0 && (
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
												<span
													className={styles.characterAlias}
													data-flx="cast.add-character-modal.character-alias"
												>
													{character.alias}
												</span>
											)}
										</div>
										<Button
											type="button"
											variant="primary"
											small
											submitting={Cast.isPending(character.id)}
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

					{Cast.writeError != null && (
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
});
