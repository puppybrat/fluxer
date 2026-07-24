// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CastDisplayCharacter} from '@app/features/cast/state/GuildCastDisplay';
import {AutocompleteOption} from '@app/features/channel/components/message_search_bar/AutocompleteOption';
import styles from '@app/features/channel/components/message_search_bar/MessageSearchBar.module.css';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {UserSwitchIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';

const CHARACTERS_DESCRIPTOR = msg({
	message: 'Characters',
	comment:
		'Section header in the message search popout listing matching cast characters for the from-character: filter. Title Case.',
});

interface CharactersSectionProps {
	options: Array<CastDisplayCharacter>;
	selectedIndex: number;
	hoverIndex: number;
	onSelect: (character: CastDisplayCharacter) => void;
	onMouseEnter: (index: number) => void;
	onMouseLeave?: () => void;
	listboxId: string;
}

export const CharactersSection: React.FC<CharactersSectionProps> = observer(
	({options, selectedIndex, hoverIndex, onSelect, onMouseEnter, onMouseLeave, listboxId}) => {
		const {i18n} = useLingui();
		if (options.length === 0) return null;
		return (
			<div className={styles.popoutSection} data-flx="channel.message-search-bar.characters-section.popout-section">
				<div
					className={styles.popoutSectionHeader}
					data-flx="channel.message-search-bar.characters-section.popout-section-header"
				>
					<span
						className={`${styles.flex} ${styles.itemsCenter} ${styles.gap2}`}
						data-flx="channel.message-search-bar.characters-section.flex"
					>
						<UserSwitchIcon
							weight="regular"
							size={14}
							data-flx="channel.message-search-bar.characters-section.user-switch-icon"
						/>
						{i18n._(CHARACTERS_DESCRIPTOR)}
					</span>
				</div>
				{options.map((character, index) => (
					<AutocompleteOption
						key={character.id}
						index={index}
						isSelected={index === selectedIndex}
						isHovered={index === hoverIndex}
						onSelect={() => onSelect(character)}
						onMouseEnter={() => onMouseEnter(index)}
						onMouseLeave={onMouseLeave}
						listboxId={listboxId}
						data-flx="channel.message-search-bar.characters-section.autocomplete-option.select"
					>
						<div className={styles.optionLabel} data-flx="channel.message-search-bar.characters-section.option-label">
							<div
								className={styles.optionContent}
								data-flx="channel.message-search-bar.characters-section.option-content"
							>
								<div className={styles.optionText} data-flx="channel.message-search-bar.characters-section.option-text">
									<div
										className={styles.optionTitle}
										data-flx="channel.message-search-bar.characters-section.option-title"
									>
										<span
											className={`${styles.userRow} ${styles.gap2}`}
											data-flx="channel.message-search-bar.characters-section.user-row"
										>
											{character.avatarUrl ? (
												<img
													src={character.avatarUrl}
													alt=""
													width={16}
													height={16}
													style={{borderRadius: '50%', objectFit: 'cover', flexShrink: 0}}
													data-flx="channel.message-search-bar.characters-section.avatar"
												/>
											) : (
												<UserSwitchIcon
													weight="fill"
													size={16}
													data-flx="channel.message-search-bar.characters-section.avatar-fallback"
												/>
											)}
											<span
												className={`${styles.minW0} ${styles.overflowHidden}`}
												data-flx="channel.message-search-bar.characters-section.min-w0"
											>
												{character.name}
											</span>
										</span>
									</div>
								</div>
							</div>
						</div>
					</AutocompleteOption>
				))}
			</div>
		);
	},
);
