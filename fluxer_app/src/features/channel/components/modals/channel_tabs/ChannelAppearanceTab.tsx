/*
 * LOCAL-ONLY: This file is a local-only addition and will never exist upstream. It is the channel
 * theme editor shell: a theme library picker, a raw CSS surface, and the four save/apply actions.
 *
 * Structured per-variable controls are deliberately absent for now — the textarea is the only edit
 * surface until they are generated from theme-editor/variable-manifest.json.
 *
 * Do not confuse this with the user-settings Appearance tab (features/user/.../AppearanceTab.tsx),
 * which configures the global app theme and is unrelated to channels.
 *
 * KNOWN LIMITATION: channel settings cannot be opened for a DM. Permission.ts assigns
 * PermissionUtils.NONE to any channel with no guildId, so `canEditChannel` is false, the context
 * menu never offers "Edit channel", and getAvailableTabs would filter every permission-gated tab
 * out anyway. This tab is therefore reachable on guild channels only. Making it reachable for DMs
 * is a deliberate follow-up, not an oversight.
 *
 * Lines to check on upstream merge: none — exclude this file entirely from any upstream sync.
 */

// SPDX-License-Identifier: AGPL-3.0-or-later

import {ConfirmModal} from '@app/features/app/components/dialogs/ConfirmModal';
import * as Modal from '@app/features/app/components/dialogs/Modal';
import {SettingsSection} from '@app/features/app/components/dialogs/shared/SettingsSection';
import styles from '@app/features/channel/components/modals/channel_tabs/ChannelAppearanceTab.module.css';
import Channels from '@app/features/channel/state/Channels';
import ChannelThemes from '@app/features/channel/state/ChannelThemes';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import * as UnsavedChangesCommands from '@app/features/ui/commands/UnsavedChangesCommands';
import {Combobox, type ComboboxOption} from '@app/features/ui/components/form/FormCombobox';
import {Input, Textarea} from '@app/features/ui/components/form/FormInput';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useCallback, useEffect, useState} from 'react';

export const CHANNEL_APPEARANCE_TAB_ID = 'appearance';

const THEME_DESCRIPTOR = msg({
	message: 'Theme',
	comment: 'Channel appearance settings tab label for the saved theme picker. Keep it concise.',
});
const CUSTOM_CSS_DESCRIPTOR = msg({
	message: 'Custom CSS',
	comment: 'Channel appearance settings tab label for the raw CSS editing surface. Keep it concise.',
});
const THEME_NAME_DESCRIPTOR = msg({
	message: 'Theme name',
	comment: 'Label for the text input naming a saved channel theme. Keep it concise.',
});
const SAVE_THEME_DESCRIPTOR = msg({
	message: 'Save theme',
	comment: 'Button label in the channel appearance tab that stores the current CSS as a named theme.',
});
const DELETE_THEME_DESCRIPTOR = msg({
	message: 'Delete theme',
	comment: 'Button label in the channel appearance tab that deletes the loaded named theme.',
});
const NO_THEME_VALUE = '';

/**
 * Prompts for a theme name. Kept local to this file: it exists only to name a theme, and the
 * shared ConfirmModal takes no free-text input.
 */
const ThemeNamePromptModal: React.FC<{
	initialName: string;
	onSubmit: (name: string) => Promise<void> | void;
}> = ({initialName, onSubmit}) => {
	const {i18n} = useLingui();
	const [name, setName] = useState(initialName);
	const [submitting, setSubmitting] = useState(false);
	const trimmed = name.trim();
	const handleSubmit = useCallback(async () => {
		if (trimmed.length === 0) return;
		setSubmitting(true);
		try {
			await onSubmit(trimmed);
			ModalCommands.pop();
		} finally {
			setSubmitting(false);
		}
	}, [onSubmit, trimmed]);
	return (
		<Modal.Root size="small" data-flx="channel.channel-appearance-tab.name-prompt.modal-root">
			<Modal.Header
				title={i18n._(SAVE_THEME_DESCRIPTOR)}
				data-flx="channel.channel-appearance-tab.name-prompt.header"
			/>
			<Modal.Content data-flx="channel.channel-appearance-tab.name-prompt.content">
				<Input
					autoFocus={true}
					label={i18n._(THEME_NAME_DESCRIPTOR)}
					maxLength={100}
					value={name}
					onChange={(event) => setName(event.target.value)}
					data-flx="channel.channel-appearance-tab.name-prompt.input"
				/>
			</Modal.Content>
			<Modal.Footer data-flx="channel.channel-appearance-tab.name-prompt.footer">
				<Button
					variant="secondary"
					onClick={() => ModalCommands.pop()}
					data-flx="channel.channel-appearance-tab.name-prompt.cancel"
				>
					<Trans>Cancel</Trans>
				</Button>
				<Button
					variant="primary"
					disabled={trimmed.length === 0}
					submitting={submitting}
					onClick={handleSubmit}
					data-flx="channel.channel-appearance-tab.name-prompt.submit"
				>
					<Trans>Save</Trans>
				</Button>
			</Modal.Footer>
		</Modal.Root>
	);
};

const ChannelAppearanceTab: React.FC<{channelId: string}> = observer(({channelId}) => {
	const {i18n} = useLingui();
	// Working state: local until an explicit action, exactly like the Overview tab's form state.
	const [workingCss, setWorkingCss] = useState('');
	const [loadedThemeId, setLoadedThemeId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// Populated only when a delete is refused. The server is the sole authority on which channels
	// reference a theme — the store knows the active state of channels visited this session, so a
	// local pre-check could not be trusted to be complete.
	const [blockedByChannelIds, setBlockedByChannelIds] = useState<Array<string>>([]);

	const appliedCss = ChannelThemes.getThemeCss(channelId) ?? '';
	const activeState = ChannelThemes.getChannelState(channelId);
	const hasUnsavedChanges = workingCss !== appliedCss;

	// Seeds working state once the channel's active state and the library have both landed. Uses
	// loadChannelState rather than the deduped ensure* so opening settings always reflects current
	// server state, which an editor needs and a render path does not.
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			await Promise.all([ChannelThemes.ensureLibraryLoaded(), ChannelThemes.loadChannelState(channelId)]);
			if (cancelled) return;
			setWorkingCss(ChannelThemes.getThemeCss(channelId) ?? '');
			setLoadedThemeId(ChannelThemes.getChannelState(channelId)?.themeId ?? null);
			setBlockedByChannelIds([]);
		})();
		return () => {
			cancelled = true;
		};
	}, [channelId]);

	const handleRevert = useCallback(() => {
		setWorkingCss(ChannelThemes.getThemeCss(channelId) ?? '');
		setLoadedThemeId(ChannelThemes.getChannelState(channelId)?.themeId ?? null);
	}, [channelId]);

	const handleSaveAndApply = useCallback(async () => {
		setBusy(true);
		const ok = await ChannelThemes.saveAndApply(channelId, workingCss);
		setBusy(false);
		if (ok) {
			// save-and-apply writes a raw blob, which detaches the channel from any named theme.
			setLoadedThemeId(null);
			ToastCommands.createToast({type: 'success', children: <Trans>Channel theme applied</Trans>});
		} else {
			ToastCommands.createToast({type: 'error', children: <Trans>Could not apply the channel theme</Trans>});
		}
	}, [channelId, workingCss]);

	// Publishes dirtiness to the shared store the settings modal consults before closing, so the
	// editor gets the same close guard every other settings tab has.
	useEffect(() => {
		UnsavedChangesCommands.setUnsavedChanges(CHANNEL_APPEARANCE_TAB_ID, hasUnsavedChanges);
	}, [hasUnsavedChanges]);
	useEffect(() => {
		UnsavedChangesCommands.setTabData(CHANNEL_APPEARANCE_TAB_ID, {
			onReset: handleRevert,
			onSave: handleSaveAndApply,
			isSubmitting: busy,
		});
	}, [handleRevert, handleSaveAndApply, busy]);
	useEffect(() => {
		return () => {
			UnsavedChangesCommands.clearUnsavedChanges(CHANNEL_APPEARANCE_TAB_ID);
		};
	}, []);

	const themes = ChannelThemes.themes;
	const loadedTheme = loadedThemeId != null ? ChannelThemes.getTheme(loadedThemeId) : null;
	const themeOptions: Array<ComboboxOption> = [
		{value: NO_THEME_VALUE, label: i18n._(NO_THEME_DESCRIPTOR)},
		...themes.map((theme) => ({value: theme.id, label: theme.name})),
	];

	const handleSelectTheme = useCallback((value: string) => {
		setBlockedByChannelIds([]);
		if (value === NO_THEME_VALUE) {
			setLoadedThemeId(null);
			setWorkingCss('');
			return;
		}
		const theme = ChannelThemes.getTheme(value);
		if (!theme) return;
		setLoadedThemeId(theme.id);
		setWorkingCss(theme.css);
	}, []);

	const createNamedTheme = useCallback(
		async (name: string) => {
			const created = await ChannelThemes.createTheme(name, workingCss);
			if (created) {
				setLoadedThemeId(created.id);
				ToastCommands.createToast({type: 'success', children: <Trans>Theme saved</Trans>});
			} else {
				ToastCommands.createToast({type: 'error', children: <Trans>Could not save the theme</Trans>});
			}
		},
		[workingCss],
	);

	const promptForName = useCallback(
		(initialName: string) => {
			ModalCommands.push(
				modal(() => (
					<ThemeNamePromptModal
						initialName={initialName}
						onSubmit={createNamedTheme}
						data-flx="channel.channel-appearance-tab.theme-name-prompt-modal"
					/>
				)),
			);
		},
		[createNamedTheme],
	);

	const handleSaveTheme = useCallback(() => {
		if (!loadedTheme) {
			promptForName('');
			return;
		}
		// A loaded theme offers both: overwrite it in place, or branch off under a new name.
		ModalCommands.push(
			modal(() => (
				<ConfirmModal
					// The theme name is composed into the title in code rather than interpolated into the
					// description's descriptor. A descriptor carrying values leaks its raw ICU source into
					// the UI if its id is ever missing from the compiled catalog; one with none cannot.
					title={`${i18n._(SAVE_THEME_DESCRIPTOR)}: ${loadedTheme.name}`}
					description={
						<Trans>
							Overwrite this theme with the current CSS, or save it as a new theme? Overwriting updates every channel
							using it.
						</Trans>
					}
					primaryText={<Trans>Overwrite</Trans>}
					onPrimary={async () => {
						const ok = await ChannelThemes.updateTheme(loadedTheme.id, {css: workingCss});
						ToastCommands.createToast(
							ok
								? {type: 'success', children: <Trans>Theme updated</Trans>}
								: {type: 'error', children: <Trans>Could not update the theme</Trans>},
						);
					}}
					secondaryText={<Trans>Save as new</Trans>}
					onSecondary={() => promptForName(`${loadedTheme.name} copy`)}
					data-flx="channel.channel-appearance-tab.save-theme-confirm-modal"
				/>
			)),
		);
	}, [i18n, loadedTheme, promptForName, workingCss]);

	const handleClear = useCallback(async () => {
		setBusy(true);
		const ok = await ChannelThemes.clearChannelTheme(channelId);
		setBusy(false);
		if (ok) {
			setWorkingCss('');
			setLoadedThemeId(null);
			ToastCommands.createToast({type: 'success', children: <Trans>Channel theme cleared</Trans>});
		} else {
			ToastCommands.createToast({type: 'error', children: <Trans>Could not clear the channel theme</Trans>});
		}
	}, [channelId]);

	const handleDeleteTheme = useCallback(() => {
		if (!loadedTheme) return;
		ModalCommands.push(
			modal(() => (
				<ConfirmModal
					// Name in the title, composed in code — same no-interpolation rule as above.
					title={`${i18n._(DELETE_THEME_DESCRIPTOR)}: ${loadedTheme.name}`}
					description={<Trans>Deleting this theme cannot be undone.</Trans>}
					primaryText={<Trans>Delete</Trans>}
					primaryVariant="danger"
					onPrimary={async () => {
						const result = await ChannelThemes.deleteTheme(loadedTheme.id);
						if (result.ok) {
							setLoadedThemeId(null);
							setBlockedByChannelIds([]);
							ToastCommands.createToast({type: 'success', children: <Trans>Theme deleted</Trans>});
							return;
						}
						// Refused: the server returned the channels still referencing it, which are shown
						// inline rather than as a toast so they stay readable while they are acted on.
						setBlockedByChannelIds(result.channelIds);
					}}
					data-flx="channel.channel-appearance-tab.delete-theme-confirm-modal"
				/>
			)),
		);
	}, [i18n, loadedTheme]);

	return (
		<div className={styles.container} data-flx="channel.channel-appearance-tab.container">
			<SettingsSection
				id="channel-theme"
				title={i18n._(THEME_DESCRIPTOR)}
				description={<Trans>Pick a saved theme, or write CSS below. Changes apply to this channel only.</Trans>}
				data-flx="channel.channel-appearance-tab.theme-section"
			>
				{themes.length === 0 ? (
					<p className={styles.emptyState} data-flx="channel.channel-appearance-tab.empty-state">
						<Trans>No saved themes yet. Write CSS below and use Save theme to create one.</Trans>
					</p>
				) : (
					<Combobox
						id="channel-appearance-theme"
						label={i18n._(THEME_DESCRIPTOR)}
						value={loadedThemeId ?? NO_THEME_VALUE}
						options={themeOptions}
						onChange={handleSelectTheme}
						// Guarded: loading a theme would discard unsaved edits.
						disabled={hasUnsavedChanges || busy}
						data-flx="channel.channel-appearance-tab.theme-combobox"
					/>
				)}
				{hasUnsavedChanges && themes.length > 0 && (
					<p className={styles.hint} data-flx="channel.channel-appearance-tab.picker-hint">
						<Trans>Save or revert your changes before loading another theme.</Trans>
					</p>
				)}
				{blockedByChannelIds.length > 0 && (
					<div className={styles.blockedList} data-flx="channel.channel-appearance-tab.blocked-list">
						<p data-flx="channel.channel-appearance-tab.blocked-title">
							<Trans>This theme is still applied to other channels and cannot be deleted:</Trans>
						</p>
						<ul data-flx="channel.channel-appearance-tab.blocked-items">
							{blockedByChannelIds.map((blockedId) => (
								<li key={blockedId} data-flx="channel.channel-appearance-tab.blocked-item">
									{Channels.getChannel(blockedId)?.name ?? blockedId}
								</li>
							))}
						</ul>
					</div>
				)}
			</SettingsSection>

			<SettingsSection
				id="channel-theme-css"
				title={i18n._(CUSTOM_CSS_DESCRIPTOR)}
				// No JSX expression inside the descriptor: a braces literal would become a placeholder and
				// put this string in the same leak-prone class as an interpolated one.
				description={<Trans>Use :root selectors. The CSS is scoped to this channel automatically.</Trans>}
				data-flx="channel.channel-appearance-tab.css-section"
			>
				<Textarea
					label={i18n._(CUSTOM_CSS_DESCRIPTOR)}
					value={workingCss}
					onChange={(event) => setWorkingCss(event.target.value)}
					minRows={14}
					maxRows={32}
					spellCheck={false}
					placeholder=":root {&#10;  --background-primary: #101014;&#10;}"
					className={styles.cssTextarea}
					data-flx="channel.channel-appearance-tab.css-textarea"
				/>
			</SettingsSection>

			<div className={styles.actionBar} data-flx="channel.channel-appearance-tab.action-bar">
				<Button
					variant="primary"
					submitting={busy}
					onClick={handleSaveAndApply}
					data-flx="channel.channel-appearance-tab.save-and-apply"
				>
					<Trans>Save and apply</Trans>
				</Button>
				<Button variant="secondary" onClick={handleSaveTheme} data-flx="channel.channel-appearance-tab.save-theme">
					<Trans>Save theme</Trans>
				</Button>
				<Button
					variant="secondary"
					// Guarded: clearing while edits are pending would silently discard them.
					disabled={hasUnsavedChanges || busy || activeState == null}
					onClick={handleClear}
					data-flx="channel.channel-appearance-tab.clear"
				>
					<Trans>Clear channel theme</Trans>
				</Button>
				{loadedTheme != null && (
					<Button
						variant="danger"
						disabled={busy}
						onClick={handleDeleteTheme}
						data-flx="channel.channel-appearance-tab.delete-theme"
					>
						<Trans>Delete theme</Trans>
					</Button>
				)}
			</div>
		</div>
	);
});

const NO_THEME_DESCRIPTOR = msg({
	message: 'No theme',
	comment: 'Channel appearance theme picker option meaning the channel uses the default appearance.',
});

export default ChannelAppearanceTab;
