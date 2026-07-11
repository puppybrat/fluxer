/*
 * LOCAL-ONLY: This file is a local-only addition to fluxer_app and will never exist upstream.
 * It manages a synthetic history entry so the OS back gesture / hardware back button dismisses
 * the mobile SelectMode overlay, mirroring MobileVoiceTextChatHistory.ts.
 *
 * Lines to check on upstream merge: none — exclude this file entirely from any upstream sync.
 */

// SPDX-License-Identifier: AGPL-3.0-or-later

import SelectMode from '@app/features/channel/state/SelectMode';
import {useEffect} from 'react';

const MOBILE_SELECT_MODE_HISTORY_KEY = '__fluxer_mobile_select_mode';

interface MobileSelectModeHistoryState {
	[MOBILE_SELECT_MODE_HISTORY_KEY]: {
		channelId: string;
	};
}

function getCurrentPath(): string {
	return window.location.pathname + window.location.search + window.location.hash;
}

export function isMobileSelectModeHistoryState(state: unknown, channelId: string): boolean {
	if (typeof state !== 'object' || state === null) {
		return false;
	}
	const value = (state as Partial<MobileSelectModeHistoryState>)[MOBILE_SELECT_MODE_HISTORY_KEY];
	return value?.channelId === channelId;
}

export function isCurrentMobileSelectModeHistoryEntry(channelId: string): boolean {
	if (typeof window === 'undefined') {
		return false;
	}
	return isMobileSelectModeHistoryState(window.history.state, channelId);
}

export function pushMobileSelectModePanelEntry(channelId: string): void {
	if (typeof window === 'undefined') {
		return;
	}
	if (isCurrentMobileSelectModeHistoryEntry(channelId)) {
		return;
	}
	const nextState: MobileSelectModeHistoryState = {
		[MOBILE_SELECT_MODE_HISTORY_KEY]: {
			channelId,
		},
	};
	window.history.pushState(nextState, '', getCurrentPath());
}

export function goBackFromMobileSelectModePanelEntry(channelId: string): boolean {
	if (typeof window === 'undefined') {
		return false;
	}
	if (!isCurrentMobileSelectModeHistoryEntry(channelId)) {
		return false;
	}
	if (window.history.length <= 1) {
		return false;
	}
	window.history.back();
	return true;
}

// LOCAL-ONLY: dismisses the mobile SelectMode overlay when its synthetic history entry is
// popped (OS back gesture / hardware back button) — exclude from upstream sync.
export function useMobileSelectModeHistoryDismiss(channelId: string, isMobileLayout: boolean): void {
	useEffect(() => {
		if (!isMobileLayout) return;
		const handlePopState = () => {
			if (
				SelectMode.isActive &&
				SelectMode.channelId === channelId &&
				!isCurrentMobileSelectModeHistoryEntry(channelId)
			) {
				SelectMode.deactivate();
			}
		};
		window.addEventListener('popstate', handlePopState);
		return () => {
			window.removeEventListener('popstate', handlePopState);
		};
	}, [channelId, isMobileLayout]);
}
