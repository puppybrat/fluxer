// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import * as CastCommands from '@app/features/cast/commands/CastCommands';
import styles from '@app/features/cast/components/ManageCastCharactersModal.module.css';
import Channels from '@app/features/channel/state/Channels';
import {CANCEL_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import * as MessageCommands from '@app/features/messaging/commands/MessageCommands';
import type {Message} from '@app/features/messaging/models/MessagingMessage';
import {PASSWORD_MANAGER_IGNORE_ATTRIBUTES} from '@app/features/platform/utils/PasswordManagerAutocomplete';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {Scroller} from '@app/features/ui/components/Scroller';
import * as AvatarUtils from '@app/features/user/utils/AvatarUtils';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {CheckIcon, MagnifyingGlassIcon, XIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {matchSorter} from 'match-sorter';
import {observer} from 'mobx-react-lite';
import {useEffect, useMemo, useRef, useState} from 'react';

interface OwnedCharacter {
	id: string;
	name: string;
	avatarUrl: string | null;
}

const MANAGE_CHARACTERS_DESCRIPTOR = msg({
	message: 'Manage characters',
	comment: 'Title of the modal that assigns which cast characters an in-character message speaks as.',
});
const SEARCH_CHARACTERS_DESCRIPTOR = msg({
	message: 'Search characters',
	comment: 'Placeholder in the manage-characters search box. Keep it concise.',
});

interface ManageCastCharactersModalProps {
	message: Message;
}

/**
 * Multi-select picker for a message's in-character attribution. Shows only the characters owned by
 * the message's author AND present in the message's channel (mirroring the server's attribution
 * rules — an excluded/absent character would be rejected on save, so it is not offered) and
 * pre-selects the ones the message currently speaks as that still qualify. Saving with one or more
 * selected marks the message in-character as exactly those; saving with none clears it back to
 * out-of-character. The server is the source of truth — this only issues the PATCH and closes; the
 * live MESSAGE_UPDATE applies the result.
 */
export const ManageCastCharactersModal = observer(({message}: ManageCastCharactersModalProps) => {
	const {i18n} = useLingui();
	// Source the guild from the channel, not message.guildId: REST-hydrated history messages carry no
	// guild_id over the wire, so an older message would resolve to undefined and the picker would show
	// nothing. The channel always knows its guild. (Same fix the IC toggle gating already uses.)
	const guildId = Channels.getChannel(message.channelId)?.guildId;
	const [characters, setCharacters] = useState<Array<OwnedCharacter>>([]);
	const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
	const [loading, setLoading] = useState(true);
	const [searchTerm, setSearchTerm] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const cancelRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		if (!guildId) {
			setLoading(false);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const owned = await CastCommands.getOwnedCharacters(guildId, message.author.id, message.channelId);
				if (cancelled) {
					return;
				}
				setCharacters(owned);
				// Pre-select the message's current attribution, but only ids the author still owns —
				// the server rejects a PATCH that names a character the author cannot speak as.
				const ownedIds = new Set(owned.map((character) => character.id));
				setSelectedIds(new Set(message.castCharacterIds.filter((id) => ownedIds.has(id))));
			} finally {
				if (!cancelled) {
					setLoading(false);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [guildId, message.channelId, message.author.id, message.castCharacterIds]);

	const filteredCharacters = useMemo(() => {
		if (!searchTerm.trim()) {
			return characters;
		}
		return matchSorter(characters, searchTerm, {keys: ['name']});
	}, [characters, searchTerm]);

	const toggleCharacter = (characterId: string) => {
		setSelectedIds((previous) => {
			const next = new Set(previous);
			if (next.has(characterId)) {
				next.delete(characterId);
			} else {
				next.add(characterId);
			}
			return next;
		});
	};

	const handleSave = async () => {
		const selected = Array.from(selectedIds);
		const selfKey = ModalCommands.getTopModalKey();
		setSubmitting(true);
		try {
			// With nothing selected the message goes out-of-character: send exactly what the quick OOC
			// toggle sends ({ic: false}, no character_ids) rather than an empty explicit list.
			if (selected.length > 0) {
				await MessageCommands.setMessageIc(message.channelId, message.id, true, selected);
			} else {
				await MessageCommands.setMessageIc(message.channelId, message.id, false);
			}
			if (selfKey != null) {
				ModalCommands.popWithKey(selfKey);
			} else {
				ModalCommands.pop();
			}
		} finally {
			setSubmitting(false);
		}
	};

	const handleCancel = () => {
		const selfKey = ModalCommands.getTopModalKey();
		if (selfKey != null) {
			ModalCommands.popWithKey(selfKey);
		} else {
			ModalCommands.pop();
		}
	};

	return (
		<Modal.Root
			size="small"
			initialFocusRef={cancelRef}
			centered
			data-flx="cast.manage-cast-characters-modal.modal-root"
		>
			<Modal.Header
				title={i18n._(MANAGE_CHARACTERS_DESCRIPTOR)}
				data-flx="cast.manage-cast-characters-modal.modal-header"
			/>
			<Modal.Content data-flx="cast.manage-cast-characters-modal.modal-content">
				<div className={styles.searchContainer} data-flx="cast.manage-cast-characters-modal.search-container">
					<div className={styles.searchInputWrapper} data-flx="cast.manage-cast-characters-modal.search-input-wrapper">
						<MagnifyingGlassIcon
							size={20}
							className={styles.searchIcon}
							weight="regular"
							data-flx="cast.manage-cast-characters-modal.search-icon"
						/>
						<input
							type="text"
							className={styles.searchInput}
							placeholder={i18n._(SEARCH_CHARACTERS_DESCRIPTOR)}
							value={searchTerm}
							onChange={(event) => setSearchTerm(event.target.value)}
							data-flx="cast.manage-cast-characters-modal.search-input.set-search-term.text"
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
								data-flx="cast.manage-cast-characters-modal.clear-button.set-search-term"
							>
								<XIcon size={18} weight="bold" data-flx="cast.manage-cast-characters-modal.x-icon" />
							</button>
						)}
					</div>
				</div>
				<Scroller className={styles.scroller} fade={false} data-flx="cast.manage-cast-characters-modal.scroller">
					<div className={styles.listContent} data-flx="cast.manage-cast-characters-modal.list-content">
						{loading ? (
							<div className={styles.emptyState} data-flx="cast.manage-cast-characters-modal.loading">
								<Trans>Loading characters…</Trans>
							</div>
						) : filteredCharacters.length === 0 ? (
							<div className={styles.emptyState} data-flx="cast.manage-cast-characters-modal.empty-state">
								{searchTerm ? <Trans>No characters found</Trans> : <Trans>No characters available</Trans>}
							</div>
						) : (
							filteredCharacters.map((character) => {
								const isSelected = selectedIds.has(character.id);
								return (
									<button
										key={character.id}
										type="button"
										aria-pressed={isSelected}
										className={clsx(styles.characterItem, isSelected && styles.characterItemSelected)}
										onClick={() => toggleCharacter(character.id)}
										data-flx="cast.manage-cast-characters-modal.character-item.toggle-character.button"
									>
										<img
											src={character.avatarUrl ?? AvatarUtils.getUserAvatarURL({id: character.id, avatar: null})}
											alt=""
											width={36}
											height={36}
											className={styles.avatar}
											data-flx="cast.manage-cast-characters-modal.avatar"
										/>
										<span className={styles.characterName} data-flx="cast.manage-cast-characters-modal.character-name">
											{character.name}
										</span>
										{isSelected && (
											<CheckIcon
												size={20}
												className={styles.checkIcon}
												weight="bold"
												data-flx="cast.manage-cast-characters-modal.check-icon"
											/>
										)}
									</button>
								);
							})
						)}
					</div>
				</Scroller>
			</Modal.Content>
			<Modal.Footer data-flx="cast.manage-cast-characters-modal.footer">
				<Button
					variant="secondary"
					onClick={handleCancel}
					ref={cancelRef}
					data-flx="cast.manage-cast-characters-modal.button.cancel"
				>
					{i18n._(CANCEL_DESCRIPTOR)}
				</Button>
				<Button
					variant="primary"
					onClick={handleSave}
					submitting={submitting}
					disabled={loading}
					data-flx="cast.manage-cast-characters-modal.button.save"
				>
					<Trans>Save</Trans>
				</Button>
			</Modal.Footer>
		</Modal.Root>
	);
});
