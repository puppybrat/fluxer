/*
 * LOCAL-ONLY: This file is a local-only addition and will never exist upstream. It is the channel
 * theme editor shell: a theme library picker, a raw CSS surface, and the four save/apply actions.
 *
 * Structured per-variable controls are generated from theme-editor/variable-manifest.json and sit
 * below the CSS surface, grouped by the manifest's own categories, with the settings sidebar
 * offering each group as a scroll target.
 *
 * The working CSS string is the only state: controls parse it to read and rewrite it to write, so
 * the CSS editor is authoritative by construction rather than by a precedence rule, and the two
 * stay in step in both directions. The accent picker is a derivation tool over that same string.
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
import variableManifest from '@app/features/channel/theme-editor/variable-manifest.json';
import Theme from '@app/features/theme/state/Theme';
import QuickCssEditor from '@app/features/theme_studio/sections/QuickCssEditor';
import {StudioTokenColor, StudioTokenFont, StudioTokenValue} from '@app/features/theme_studio/ui/StudioToken';
import {getThemeStudioBaseTheme} from '@app/features/theme_studio/utils/ThemeStudioPinnedVariables';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import * as UnsavedChangesCommands from '@app/features/ui/commands/UnsavedChangesCommands';
import {ColorPickerField} from '@app/features/ui/components/form/ColorPickerField';
import {Combobox, type ComboboxOption} from '@app/features/ui/components/form/FormCombobox';
import {Input} from '@app/features/ui/components/form/FormInput';
import type {ThemeVariableKind} from '@app/features/user/components/modals/tabs/appearance_tab/theme/ThemeConstants';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

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
const ACCENT_DESCRIPTOR = msg({
	message: 'Accent colour',
	comment: 'Label for the picker that re-tints every channel theme colour to one hue. Keep it concise.',
});
const BRIGHTNESS_DESCRIPTOR = msg({
	message: 'Brightness',
	comment: 'Label for the slider that lightens or darkens accent-derived colours. Keep it concise.',
});
const ADVANCED_DESCRIPTOR = msg({
	message: 'Advanced',
	comment: 'Channel appearance section holding rarely-used theme variables. Keep it concise.',
});

interface ManifestVariable {
	name: string;
	defaultLight: string;
	defaultDark: string;
	impact: string;
	inputType: string;
	excluded?: boolean;
}

interface ManifestCategory {
	name: string;
	variables: Array<ManifestVariable>;
}

const MANIFEST_CATEGORIES = (variableManifest as {categories: Array<ManifestCategory>}).categories;
const isRenderable = (variable: ManifestVariable): boolean => variable.excluded !== true;

/** High and medium impact, grouped by the manifest's own categories. Empty groups are dropped. */
const CONTROL_GROUPS = MANIFEST_CATEGORIES.map((category) => ({
	name: category.name,
	variables: category.variables.filter((variable) => isRenderable(variable) && variable.impact !== 'edge-case'),
})).filter((group) => group.variables.length > 0);

/** Everything else that is still renderable, collected behind one collapsed disclosure. */
const ADVANCED_VARIABLES = MANIFEST_CATEGORIES.flatMap((category) =>
	category.variables.filter((variable) => isRenderable(variable) && variable.impact === 'edge-case'),
);

/**
 * Descriptions name the surface a group paints rather than restating its title. Only groups whose
 * effect is genuinely unclear from the heading get one; "Text" and "Buttons" say what they are.
 */
const CATEGORY_DESCRIPTIONS: Record<string, MessageDescriptor> = {
	Surfaces: msg({
		message: 'Backgrounds behind the chat area, channel sidebar, and server rail.',
		comment: 'Describes which surfaces a channel theme category paints. One short sentence.',
	}),
	'Borders & focus': msg({
		message: 'Dividers, outlines, corner rounding, and keyboard focus rings.',
		comment: 'Describes which surfaces a channel theme category paints. One short sentence.',
	}),
	Forms: msg({
		message: 'The message input box and its buttons.',
		comment: 'Describes which surfaces a channel theme category paints. One short sentence.',
	}),
	'Markup & mentions': msg({
		message: 'Mentions, links, and spoilers inside messages.',
		comment: 'Describes which surfaces a channel theme category paints. One short sentence.',
	}),
	'Code & terminal': msg({
		message: 'Code blocks inside messages, and their terminal colours.',
		comment: 'Describes which surfaces a channel theme category paints. One short sentence.',
	}),
	'Alerts & callouts': msg({
		message: 'Markdown callout blocks inside messages.',
		comment: 'Describes which surfaces a channel theme category paints. One short sentence.',
	}),
	'Status indicators': msg({
		message: 'The presence dot on avatars.',
		comment: 'Describes which surfaces a channel theme category paints. One short sentence.',
	}),
	Tables: msg({
		message: 'Markdown tables inside messages.',
		comment: 'Describes which surfaces a channel theme category paints. One short sentence.',
	}),
	Scrolling: msg({
		message: 'Scrollbar colours. Scrollbar size is not themeable.',
		comment: 'Describes which surfaces a channel theme category paints. One short sentence.',
	}),
	Layout: msg({
		message: 'Widths, heights, and spacing of the server rail, sidebar, and header.',
		comment: 'Describes which surfaces a channel theme category paints. One short sentence.',
	}),
	Motion: msg({
		message: 'How quickly hover and state changes animate.',
		comment: 'Describes which surfaces a channel theme category paints. One short sentence.',
	}),
	Emoji: msg({
		message: 'Emoji size inside messages.',
		comment: 'Describes which surfaces a channel theme category paints. One short sentence.',
	}),
	Messages: msg({
		message: 'Avatar size, spacing, timestamps, and replies in the message list.',
		comment: 'Describes which surfaces a channel theme category paints. One short sentence.',
	}),
};

/** Section ids in render order, so the settings sidebar can offer them as scroll targets. */
export const CHANNEL_APPEARANCE_SECTION_IDS: ReadonlyArray<string> = [
	'channel-theme',
	'channel-theme-css',
	'channel-theme-accent',
	...CONTROL_GROUPS.map((group) => groupSectionId(group.name)),
	'channel-theme-vars-advanced',
];

function groupSectionId(categoryName: string): string {
	return `channel-theme-vars-${categoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/** Category labels paired with their section ids, for the sidebar's sub-item list. */
export function getChannelAppearanceSections(): Array<{id: string; label: string}> {
	return CONTROL_GROUPS.map((group) => ({id: groupSectionId(group.name), label: group.name}));
}

/**
 * Rewrites a colour's hue while leaving saturation and lightness alone, which is what keeps each
 * group's internal light/dark relationships intact when the whole palette is re-tinted.
 *
 * Works directly on the CSS text rather than parsing to a colour object, because most defaults are
 * not plain colours: they are `hsl(258, calc(10% * var(--saturation-factor)), 14.15%)` or a
 * `color-mix()` of two such. Both keep their hue as a bare leading number, so substituting every
 * `hsl(`/`hsla(` hue in the string handles plain colours, calc-laden ones, and nested mixes alike.
 *
 * Skipped deliberately: `transparent` and `currentColor` (no hue to replace), and values that are
 * only a `var()` reference (the hue lives in whatever they point at, which this pass also rewrites).
 */
function withReplacedHue(value: string, hue: number, brightnessPercent = 100): string | null {
	const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
	if (hexMatch) {
		const hsl = hexToHsl(value.trim());
		if (hsl == null) return null;
		return `hsl(${Math.round(hue)}, ${Math.round(hsl.s)}%, ${scaleLightness(hsl.l, brightnessPercent)}%)`;
	}
	if (/hsla?\(/i.test(value)) {
		const hueReplaced = value.replace(
			/(hsla?\(\s*)(-?[\d.]+)(deg|rad|turn)?/gi,
			(_full, prefix: string) => `${prefix}${Math.round(hue)}`,
		);
		if (brightnessPercent === 100) {
			return hueReplaced;
		}
		// Lightness is the third comma-separated argument. Only a bare percentage is rescaled; a
		// calc() lightness is left as-is rather than guessed at.
		return hueReplaced.replace(
			/(hsla?\([^,]+,[^,]+,\s*)(-?[\d.]+)%/gi,
			(_full, prefix: string, lightness: string) =>
				`${prefix}${scaleLightness(Number.parseFloat(lightness), brightnessPercent)}%`,
		);
	}
	return null;
}

/** Scales a lightness by a percentage, clamped to the 0-100 the CSS syntax allows. */
function scaleLightness(lightness: number, brightnessPercent: number): number {
	return Math.round(Math.min(100, Math.max(0, (lightness * brightnessPercent) / 100)) * 100) / 100;
}

function hexToHsl(hex: string): {s: number; l: number} | null {
	const normalized = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
	const int = Number.parseInt(normalized.slice(1), 16);
	if (Number.isNaN(int)) return null;
	const r = ((int >> 16) & 255) / 255;
	const g = ((int >> 8) & 255) / 255;
	const b = (int & 255) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	const d = max - min;
	const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
	return {s: s * 100, l: l * 100};
}

/** Hue of a hex colour, 0-360, or null when it has none (pure greys still return 0). */
function hexToHue(hex: string): number | null {
	const int = Number.parseInt(hex.replace('#', ''), 16);
	if (Number.isNaN(int)) return null;
	const r = ((int >> 16) & 255) / 255;
	const g = ((int >> 8) & 255) / 255;
	const b = (int & 255) / 255;
	const max = Math.max(r, g, b);
	const d = max - Math.min(r, g, b);
	if (d === 0) return 0;
	let hue: number;
	if (max === r) hue = ((g - b) / d) % 6;
	else if (max === g) hue = (b - r) / d + 2;
	else hue = (r - g) / d + 4;
	return (hue * 60 + 360) % 360;
}

/**
 * The working CSS string is the single source of truth; the controls are a projection of it. That is
 * what makes the textarea authoritative without a precedence rule anywhere — a control reads its
 * value by parsing the CSS and writes by rewriting it, so whatever the textarea says is, by
 * construction, what every control shows.
 */
function parseDeclarations(css: string): Map<string, string> {
	const declarations = new Map<string, string>();
	for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
		declarations.set(match[1] as string, (match[2] as string).trim());
	}
	return declarations;
}

/**
 * Writes a variable into the CSS, or removes it when `value` is null (the reset affordance).
 *
 * The existing-declaration probe anchors on the colon, so `--background-secondary` cannot match
 * inside `--background-secondary-lighter`. A new declaration goes inside the first `:root` block, or
 * a `:root` block is created when the CSS has none.
 */
function upsertDeclaration(css: string, name: string, value: string | null): string {
	const existing = new RegExp(`([ \\t]*)${name}\\s*:\\s*[^;}]+;?[ \\t]*\\n?`, 'g');
	if (existing.test(css)) {
		return value === null ? css.replace(existing, '') : css.replace(existing, `$1${name}: ${value};\n`);
	}
	if (value === null) {
		return css;
	}
	const rootBlock = /:root\s*\{/.exec(css);
	if (!rootBlock) {
		const block = `:root {\n\t${name}: ${value};\n}`;
		return css.trim().length === 0 ? block : `${css.trimEnd()}\n\n${block}`;
	}
	const insertAt = rootBlock.index + rootBlock[0].length;
	return `${css.slice(0, insertAt)}\n\t${name}: ${value};${css.slice(insertAt)}`;
}

/**
 * The manifest's input types map onto Theme Studio's token kinds, which is what drives the small
 * type marker beside each field. `border-width` rides with dimensions because it is one.
 */
function kindForInputType(inputType: string): ThemeVariableKind {
	switch (inputType) {
		case 'numeric-with-unit':
		case 'border-width':
			return 'dimension';
		case 'font-family':
			return 'font';
		case 'color-picker':
			return 'color';
		default:
			return 'other';
	}
}

interface VariableControlProps {
	variable: ManifestVariable;
	/** The value the CSS currently declares, or '' when it declares none. */
	declaredValue: string;
	defaultValue: string;
	onChange: (name: string, value: string | null) => void;
}

/**
 * One row per variable, dispatched to Theme Studio's existing token controls rather than new ones —
 * they already carry a swatch, a default-valued placeholder, an overridden state and a reset button.
 *
 * `overridden` compares against the manifest default rather than the applied theme, so the indicator
 * answers "is this off-default" rather than "did I just change it".
 */
const VariableControl: React.FC<VariableControlProps> = ({variable, declaredValue, defaultValue, onChange}) => {
	const label = variable.name.replace(/^--/, '');
	const overridden = declaredValue !== '' && declaredValue !== defaultValue;
	const handleChange = (value: string | null) => onChange(variable.name, value);
	const shared = {variableName: variable.name, label, currentValue: declaredValue, defaultValue, overridden};
	if (variable.inputType === 'color-picker') {
		return <StudioTokenColor {...shared} onChange={handleChange} />;
	}
	if (variable.inputType === 'font-family') {
		return <StudioTokenFont {...shared} onChange={handleChange} />;
	}
	return <StudioTokenValue {...shared} kind={kindForInputType(variable.inputType)} onChange={handleChange} />;
};

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
	// Not a saved variable: only the overrides it writes survive, so it resets with the tab.
	const [accentColor, setAccentColor] = useState(0x7c3aed);
	const [accentHue, setAccentHue] = useState<number | null>(null);
	const [brightness, setBrightness] = useState(100);

	const appliedCss = ChannelThemes.getThemeCss(channelId) ?? '';
	const activeState = ChannelThemes.getChannelState(channelId);
	const hasUnsavedChanges = workingCss !== appliedCss;

	// Re-derived from the CSS on every edit, so a hand-typed change in the textarea moves the
	// controls too — the two are one piece of state viewed twice, not two states kept in step.
	const declarations = useMemo(() => parseDeclarations(workingCss), [workingCss]);
	const isLightTheme = Theme.effectiveTheme === 'light';
	const handleVariableChange = useCallback((name: string, value: string | null) => {
		setWorkingCss((current) => upsertDeclaration(current, name, value));
	}, []);
	/**
	 * Derivation tool only: it is not a theme variable and nothing persists it. Its whole effect is
	 * the individual overrides it writes, which the controls below then show as overridden and remain
	 * separately editable.
	 */
	const applyAccent = useCallback(
		(hue: number, brightnessPercent: number) => {
			setWorkingCss((current) => {
				let next = current;
				for (const category of MANIFEST_CATEGORIES) {
					for (const variable of category.variables) {
						// Colours only. Sizes, fonts and z-indexes have no hue to re-tint.
						if (variable.excluded === true || variable.inputType !== 'color-picker') continue;
						const base = isLightTheme ? variable.defaultLight : variable.defaultDark;
						const tinted = withReplacedHue(base, hue, brightnessPercent);
						if (tinted == null) continue;
						next = upsertDeclaration(next, variable.name, tinted);
					}
				}
				return next;
			});
		},
		[isLightTheme],
	);

	/**
	 * Derivation tool only: not a theme variable, nothing persists it. Its whole effect is the
	 * individual overrides it writes, which stay separately editable and show as overridden.
	 */
	const handleAccentPick = useCallback(
		(accent: number) => {
			setAccentColor(accent);
			const hue = hexToHue(accent.toString(16).padStart(6, '0'));
			if (hue == null) return;
			setAccentHue(hue);
			applyAccent(hue, brightness);
		},
		[applyAccent, brightness],
	);

	/**
	 * Re-derives from the same base defaults rather than compounding on the current values, so
	 * dragging the slider back to 100 lands exactly where the accent alone put things. Inert until an
	 * accent has been picked -- there is nothing accent-derived to brighten before that.
	 */
	const handleBrightnessChange = useCallback(
		(percent: number) => {
			setBrightness(percent);
			if (accentHue == null) return;
			applyAccent(accentHue, percent);
		},
		[accentHue, applyAccent],
	);

	const renderControl = useCallback(
		(variable: ManifestVariable) => (
			<VariableControl
				key={variable.name}
				variable={variable}
				declaredValue={declarations.get(variable.name) ?? ''}
				defaultValue={isLightTheme ? variable.defaultLight : variable.defaultDark}
				onChange={handleVariableChange}
			/>
		),
		[declarations, isLightTheme, handleVariableChange],
	);

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

	// Published from one effect, not two. Split across separate effects with different dependency
	// arrays, the dirty flag and the handlers can land in different commits, and the modal's save bar
	// reads them independently -- a commit that updates one but not the other renders the banner with
	// no buttons. Refs keep the published handlers current without making the effect churn on every
	// keystroke, which the previous dependency on handleSaveAndApply did.
	const saveRef = useRef(handleSaveAndApply);
	const revertRef = useRef(handleRevert);
	saveRef.current = handleSaveAndApply;
	revertRef.current = handleRevert;
	useEffect(() => {
		UnsavedChangesCommands.setTabData(CHANNEL_APPEARANCE_TAB_ID, {
			onReset: () => revertRef.current(),
			onSave: () => void saveRef.current(),
			isSubmitting: busy,
		});
		UnsavedChangesCommands.setUnsavedChanges(CHANNEL_APPEARANCE_TAB_ID, hasUnsavedChanges);
	}, [hasUnsavedChanges, busy]);
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
				<QuickCssEditor
					ariaLabel={i18n._(CUSTOM_CSS_DESCRIPTOR)}
					baseTheme={getThemeStudioBaseTheme(Theme.effectiveTheme)}
					value={workingCss}
					onChange={setWorkingCss}
					className={styles.cssEditor}
					data-flx="channel.channel-appearance-tab.css-editor"
				/>
			</SettingsSection>

			<SettingsSection
				id="channel-theme-accent"
				title={i18n._(ACCENT_DESCRIPTOR)}
				description={
					<Trans>
						Re-tints every colour below to this hue, keeping each one's own lightness. Adjust any of them afterwards.
					</Trans>
				}
				data-flx="channel.channel-appearance-tab.accent-section"
			>
				<div className={styles.accentControls} data-flx="channel.channel-appearance-tab.accent-controls">
					<ColorPickerField
						label={i18n._(ACCENT_DESCRIPTOR)}
						value={accentColor}
						onChange={handleAccentPick}
						data-flx="channel.channel-appearance-tab.accent-picker"
					/>
					<div className={styles.brightnessRow} data-flx="channel.channel-appearance-tab.brightness-row">
						<label className={styles.brightnessLabel} htmlFor="channel-theme-brightness">
							{i18n._(BRIGHTNESS_DESCRIPTOR)}
						</label>
						<input
							id="channel-theme-brightness"
							type="range"
							min={0}
							max={200}
							step={1}
							value={brightness}
							disabled={accentHue == null}
							onChange={(event) => handleBrightnessChange(Number(event.target.value))}
							data-flx="channel.channel-appearance-tab.brightness-slider"
						/>
						<span className={styles.brightnessHint} data-flx="channel.channel-appearance-tab.brightness-hint">
							{accentHue == null ? (
								<Trans>Pick an accent colour first. Brightness only adjusts colours the accent derived.</Trans>
							) : (
								<Trans>Lightens or darkens the accent-derived colours. Hand-edited values are left alone.</Trans>
							)}
						</span>
					</div>
				</div>
			</SettingsSection>

			{/* One group per manifest category. Collapsed by default: there are a few hundred
			    controls in total, and an all-expanded tab would bury the CSS surface above it. */}
			{CONTROL_GROUPS.map((group) => (
				<SettingsSection
					key={group.name}
					id={groupSectionId(group.name)}
					title={group.name}
					description={
						CATEGORY_DESCRIPTIONS[group.name]
							? i18n._(CATEGORY_DESCRIPTIONS[group.name] as MessageDescriptor)
							: undefined
					}
					data-flx="channel.channel-appearance-tab.variable-group"
				>
					<div className={styles.controlGroup} data-flx="channel.channel-appearance-tab.control-group">
						{group.variables.map(renderControl)}
					</div>
				</SettingsSection>
			))}

			{ADVANCED_VARIABLES.length > 0 && (
				<SettingsSection
					id="channel-theme-vars-advanced"
					title={i18n._(ADVANCED_DESCRIPTOR)}
					description={<Trans>Rarely-used variables. Editing these is unlikely to change how the channel looks.</Trans>}
					defaultExpanded={false}
					data-flx="channel.channel-appearance-tab.advanced-section"
				>
					<div className={styles.controlGroup} data-flx="channel.channel-appearance-tab.advanced-group">
						{ADVANCED_VARIABLES.map(renderControl)}
					</div>
				</SettingsSection>
			)}

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
