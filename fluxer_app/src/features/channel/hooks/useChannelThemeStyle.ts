// SPDX-License-Identifier: AGPL-3.0-or-later

import {useEffect} from 'react';

const STYLE_ELEMENT_ID = 'fluxer-channel-theme-style';

function removeChannelThemeStyle(): void {
	document.getElementById(STYLE_ELEMENT_ID)?.remove();
}

/**
 * Applies the active channel's theme CSS to the whole document for as long as that channel is open.
 *
 * The CSS is injected verbatim, `:root` selectors and all, into a single `<style>` in `<head>` —
 * the same shape `useCustomThemeStyle` uses for the user's global theme. It therefore retheme's
 * every surface visible while in the channel (server rail, channel list, header, member list,
 * chrome), not only the channel content area.
 *
 * This replaces an earlier scoped implementation that rewrote `:root` to a
 * `[data-channel-theme-id]` attribute selector on the channel container. That confined the theme to
 * `<main>` and left the surrounding chrome on the global palette, which is the behaviour this
 * deliberately drops. Nothing sets or reads that attribute any more.
 *
 * **Cascade order matters and is load-bearing.** Both this and `useCustomThemeStyle` declare custom
 * properties on `:root`, which is the same element at equal specificity — so whichever `<style>`
 * comes later in `<head>` wins. `useCustomThemeStyle` runs from AppWrapper at app mount, well
 * before any channel mounts, and it reuses its existing element rather than re-appending on change,
 * so this element reliably lands after it. A channel theme therefore overrides the user's global
 * custom theme while it is open, which is the intent.
 *
 * Cleanup removes the element outright, unlike `useCustomThemeStyle`, whose element is meant to
 * live for the session. Leaving this one behind would keep a channel's palette applied after
 * navigating away from it.
 *
 * A null or blank value removes the element and is otherwise a no-op, so an unthemed channel
 * restores the global theme rather than clearing it to nothing.
 */
export function useChannelThemeStyle(css: string | null | undefined): void {
	useEffect(() => {
		const trimmedCss = css?.trim();
		if (!trimmedCss) {
			removeChannelThemeStyle();
			return;
		}
		// Recreated rather than mutated in place on every change: the effect's own cleanup has already
		// removed the previous element, and appending afresh keeps this last in <head>, which is what
		// preserves the override order described above.
		const styleElement = document.createElement('style');
		styleElement.id = STYLE_ELEMENT_ID;
		styleElement.textContent = trimmedCss;
		document.head.appendChild(styleElement);
		return () => {
			styleElement.remove();
		};
	}, [css]);
}
