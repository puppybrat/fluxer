// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {useChannelThemeStyle} from '@app/features/channel/hooks/useChannelThemeStyle';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const STYLE_ELEMENT_ID = 'fluxer-channel-theme-style';
const CUSTOM_THEME_STYLE_ID = 'fluxer-custom-theme-style';
const CSS = ':root { --background-secondary-lighter: #1a0a2a; }';

/** Minimal stand-in for ChannelLayout: it exists only to drive the hook. */
const Host: React.FC<{css: string | null | undefined}> = ({css}) => {
	useChannelThemeStyle(css);
	return null;
};

let container: HTMLDivElement;
let root: Root;

function render(css: string | null | undefined): void {
	act(() => {
		root.render(<Host css={css} />);
	});
}

function styleElement(): HTMLElement | null {
	return document.getElementById(STYLE_ELEMENT_ID);
}

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => {
		root.unmount();
	});
	container.remove();
	for (const id of [STYLE_ELEMENT_ID, CUSTOM_THEME_STYLE_ID]) {
		document.getElementById(id)?.remove();
	}
});

describe('useChannelThemeStyle — document-level injection', () => {
	it('injects a style element into <head> under a stable id', () => {
		render(CSS);
		const element = styleElement();
		expect(element).not.toBeNull();
		expect(element?.tagName).toBe('STYLE');
		expect(element?.parentElement).toBe(document.head);
	});

	/**
	 * The whole point of the change: the CSS goes in verbatim. An earlier implementation rewrote
	 * `:root` to a `[data-channel-theme-id]` attribute selector, which confined the theme to the
	 * channel container and left the surrounding chrome on the global palette.
	 */
	it('keeps :root intact rather than rewriting it to a scoped selector', () => {
		render(CSS);
		expect(styleElement()?.textContent).toBe(CSS);
		expect(styleElement()?.textContent).toContain(':root');
		expect(styleElement()?.textContent).not.toContain('data-channel-theme-id');
	});

	it('sets no data-channel-theme-id attribute anywhere', () => {
		render(CSS);
		expect(document.querySelector('[data-channel-theme-id]')).toBeNull();
	});

	it('updates the injected CSS when the theme changes', () => {
		render(CSS);
		const next = ':root { --background-tertiary: #14081f; }';
		render(next);
		expect(styleElement()?.textContent).toBe(next);
		// One element, not one per change.
		expect(document.querySelectorAll(`#${STYLE_ELEMENT_ID}`)).toHaveLength(1);
	});

	/** Navigating away from a themed channel must restore the user's global theme. */
	it('removes the style element on unmount', () => {
		render(CSS);
		expect(styleElement()).not.toBeNull();
		act(() => {
			root.unmount();
		});
		expect(styleElement()).toBeNull();
	});

	it('removes the style element when the theme becomes null', () => {
		render(CSS);
		expect(styleElement()).not.toBeNull();
		render(null);
		expect(styleElement()).toBeNull();
	});

	it('injects nothing for an unthemed channel', () => {
		render(null);
		expect(styleElement()).toBeNull();
		render(undefined);
		expect(styleElement()).toBeNull();
	});

	it('treats whitespace-only CSS as no theme', () => {
		render('   \n\t  ');
		expect(styleElement()).toBeNull();
	});

	/**
	 * Cascade order is load-bearing. Both this hook and useCustomThemeStyle declare custom properties
	 * on :root — same element, equal specificity — so the later element in <head> wins. The global
	 * custom theme is injected from AppWrapper long before any channel mounts, so the channel theme
	 * must land after it, or a user with a global custom theme would see it beat the channel's.
	 */
	it('injects after the global custom theme element so it wins the cascade', () => {
		const customTheme = document.createElement('style');
		customTheme.id = CUSTOM_THEME_STYLE_ID;
		customTheme.textContent = ':root { --background-secondary-lighter: #ffffff; }';
		document.head.appendChild(customTheme);

		render(CSS);

		const ids = [...document.head.querySelectorAll('style')].map((element) => element.id);
		expect(ids.indexOf(STYLE_ELEMENT_ID)).toBeGreaterThan(ids.indexOf(CUSTOM_THEME_STYLE_ID));
	});

	it('still lands last after the theme changes', () => {
		const customTheme = document.createElement('style');
		customTheme.id = CUSTOM_THEME_STYLE_ID;
		document.head.appendChild(customTheme);

		render(CSS);
		render(':root { --background-tertiary: #14081f; }');

		const ids = [...document.head.querySelectorAll('style')].map((element) => element.id);
		expect(ids.indexOf(STYLE_ELEMENT_ID)).toBeGreaterThan(ids.indexOf(CUSTOM_THEME_STYLE_ID));
	});
});
