// SPDX-License-Identifier: AGPL-3.0-or-later

import {useEffect, useId} from 'react';
import type {RefObject} from 'react';

const STYLE_ELEMENT_PREFIX = 'fluxer-channel-theme-style';
const DATA_ATTR = 'data-channel-theme-id';

export function useChannelThemeStyle(
	containerRef: RefObject<HTMLElement | null>,
	css: string | null | undefined,
): void {
	const id = useId();
	const scopeId = id.replace(/:/g, '');

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const trimmedCss = css?.trim();
		const styleId = `${STYLE_ELEMENT_PREFIX}-${scopeId}`;
		const existing = document.getElementById(styleId) as HTMLStyleElement | null;

		if (!trimmedCss) {
			if (existing?.parentNode) {
				existing.parentNode.removeChild(existing);
			}
			container.removeAttribute(DATA_ATTR);
			return;
		}

		container.setAttribute(DATA_ATTR, scopeId);

		// Replace :root with the channel container's attribute selector so custom
		// properties cascade only within this element, not document-wide.
		const scopedCss = trimmedCss.replace(/:root\b/g, `[${DATA_ATTR}="${scopeId}"]`);
		const styleElement = existing ?? document.createElement('style');
		styleElement.id = styleId;
		styleElement.textContent = scopedCss;

		if (!existing) {
			document.head.appendChild(styleElement);
		}

		return () => {
			if (styleElement.parentNode) {
				styleElement.parentNode.removeChild(styleElement);
			}
			container.removeAttribute(DATA_ATTR);
		};
	}, [containerRef, css, scopeId]);
}
