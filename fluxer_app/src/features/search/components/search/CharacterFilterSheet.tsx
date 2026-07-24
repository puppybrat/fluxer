// SPDX-License-Identifier: AGPL-3.0-or-later

import GuildCastDisplay, {type CastDisplayCharacter} from '@app/features/cast/state/GuildCastDisplay';
import type {Channel} from '@app/features/channel/models/Channel';
import {PASSWORD_MANAGER_IGNORE_ATTRIBUTES} from '@app/features/platform/utils/PasswordManagerAutocomplete';
// Reuses the user filter sheet styling so the character picker is visually identical to "From".
import styles from '@app/features/search/components/search/UserFilterSheet.module.css';
import {BottomSheet} from '@app/features/ui/bottom_sheet/BottomSheet';
import {Button} from '@app/features/ui/button/Button';
import {Scroller} from '@app/features/ui/components/Scroller';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {CheckIcon, MagnifyingGlassIcon, UserSwitchIcon, XIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {matchSorter} from 'match-sorter';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect, useMemo, useState} from 'react';

const FILTER_BY_CHARACTER_DESCRIPTOR = msg({
	message: 'Filter by character',
	comment: 'Short label in the search character filter sheet. Keep it concise.',
});
const SEARCH_CHARACTERS_DESCRIPTOR = msg({
	message: 'Search characters',
	comment: 'Button or menu action label in the search character filter sheet. Keep it concise.',
});

interface CharacterFilterSheetProps {
	isOpen: boolean;
	onClose: () => void;
	channel: Channel;
	selectedCharacterIds: Array<string>;
	onCharactersChange: (characterIds: Array<string>) => void;
	title?: string;
}

export const CharacterFilterSheet: React.FC<CharacterFilterSheetProps> = observer(
	({isOpen, onClose, channel, selectedCharacterIds, onCharactersChange, title}) => {
		const {i18n} = useLingui();
		const [searchTerm, setSearchTerm] = useState('');
		useEffect(() => {
			if (isOpen) {
				setSearchTerm('');
				if (channel.guildId) {
					void GuildCastDisplay.ensureLoaded(channel.guildId);
				}
			}
		}, [isOpen, channel.guildId]);
		const availableCharacters = useMemo(
			(): Array<CastDisplayCharacter> => GuildCastDisplay.listCharacters(channel.guildId),
			[channel.guildId],
		);
		const filteredCharacters = useMemo(() => {
			if (!searchTerm.trim()) {
				return availableCharacters.slice(0, 50);
			}
			return matchSorter(availableCharacters, searchTerm, {keys: ['name']}).slice(0, 50);
		}, [availableCharacters, searchTerm]);
		const toggleCharacter = (characterId: string) => {
			if (selectedCharacterIds.includes(characterId)) {
				onCharactersChange(selectedCharacterIds.filter((id) => id !== characterId));
			} else {
				onCharactersChange([...selectedCharacterIds, characterId]);
			}
		};
		return (
			<BottomSheet
				isOpen={isOpen}
				onClose={onClose}
				snapPoints={[0, 1]}
				initialSnap={1}
				title={title ?? i18n._(FILTER_BY_CHARACTER_DESCRIPTOR)}
				disablePadding
				data-flx="search.search.character-filter-sheet.bottom-sheet"
			>
				<div className={styles.container} data-flx="search.search.character-filter-sheet.container">
					<div className={styles.searchContainer} data-flx="search.search.character-filter-sheet.search-container">
						<div
							className={styles.searchInputWrapper}
							data-flx="search.search.character-filter-sheet.search-input-wrapper"
						>
							<MagnifyingGlassIcon
								size={20}
								className={styles.searchIcon}
								weight="regular"
								data-flx="search.search.character-filter-sheet.search-icon"
							/>
							<input
								type="text"
								className={styles.searchInput}
								placeholder={i18n._(SEARCH_CHARACTERS_DESCRIPTOR)}
								value={searchTerm}
								onChange={(e) => setSearchTerm(e.target.value)}
								data-flx="search.search.character-filter-sheet.search-input.set-search-term.text"
								{...PASSWORD_MANAGER_IGNORE_ATTRIBUTES}
								autoComplete="off"
								autoCorrect="off"
								autoCapitalize="off"
							/>
							{searchTerm.length > 0 && (
								<button
									type="button"
									className={styles.clearButton}
									onClick={() => setSearchTerm('')}
									data-flx="search.search.character-filter-sheet.clear-button.set-search-term"
								>
									<XIcon size={18} weight="bold" data-flx="search.search.character-filter-sheet.x-icon" />
								</button>
							)}
						</div>
					</div>
					<Scroller
						key="character-filter-scroller"
						className={styles.scroller}
						fade={false}
						data-flx="search.search.character-filter-sheet.scroller"
					>
						<div className={styles.listContent} data-flx="search.search.character-filter-sheet.list-content">
							{filteredCharacters.length === 0 ? (
								<div className={styles.emptyState} data-flx="search.search.character-filter-sheet.empty-state">
									{searchTerm ? <Trans>No characters found</Trans> : <Trans>No characters available</Trans>}
								</div>
							) : (
								filteredCharacters.map((character) => {
									const isSelected = selectedCharacterIds.includes(character.id);
									return (
										<button
											key={character.id}
											type="button"
											aria-pressed={isSelected}
											className={clsx(styles.userItem, isSelected && styles.userItemSelected)}
											onClick={() => toggleCharacter(character.id)}
											data-flx="search.search.character-filter-sheet.character-item.toggle-character.button"
										>
											{character.avatarUrl ? (
												<img
													src={character.avatarUrl}
													alt=""
													width={36}
													height={36}
													className={styles.avatar}
													style={{borderRadius: '50%', objectFit: 'cover'}}
													data-flx="search.search.character-filter-sheet.avatar"
												/>
											) : (
												<UserSwitchIcon
													size={36}
													weight="fill"
													className={styles.avatar}
													data-flx="search.search.character-filter-sheet.avatar-fallback"
												/>
											)}
											<div className={styles.userInfo} data-flx="search.search.character-filter-sheet.character-info">
												<span
													className={styles.displayName}
													data-flx="search.search.character-filter-sheet.display-name"
												>
													{character.name}
												</span>
											</div>
											{isSelected && (
												<CheckIcon
													size={20}
													className={styles.checkIcon}
													weight="bold"
													data-flx="search.search.character-filter-sheet.check-icon"
												/>
											)}
										</button>
									);
								})
							)}
						</div>
					</Scroller>
					<div className={styles.footer} data-flx="search.search.character-filter-sheet.footer">
						<Button variant="primary" onClick={onClose} data-flx="search.search.character-filter-sheet.button.close">
							<Trans>Done</Trans>
						</Button>
					</div>
				</div>
			</BottomSheet>
		);
	},
);
