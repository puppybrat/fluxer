/*
 * LOCAL-ONLY: This file is a local-only addition to fluxer_app and will never exist upstream.
 * It manages a synthetic history entry so the OS back gesture / hardware back button dismisses
 * the mobile SelectMode panel overlay, mirroring MobileVoiceTextChatHistory.ts. Unlike that file,
 * the action that opens the panel (SelectMode.openPanel(), invoked from ChannelHeader.tsx) lives
 * outside the component that owns this hook, so the history entry is pushed reactively off
 * SelectMode.isPanelOpen rather than pushed directly from a click handler.
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

function isMobileSelectModeHistoryState(state: unknown, channelId: string): boolean {
	if (typeof state !== 'object' || state === null) {
		return false;
	}
	const value = (state as Partial<MobileSelectModeHistoryState>)[MOBILE_SELECT_MODE_HISTORY_KEY];
	return value?.channelId === channelId;
}

function isCurrentMobileSelectModeHistoryEntry(channelId: string): boolean {
	if (typeof window === 'undefined') {
		return false;
	}
	return isMobileSelectModeHistoryState(window.history.state, channelId);
}

function pushMobileSelectModeHistoryEntry(channelId: string): void {
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

// LOCAL-ONLY: pushes a synthetic history entry while the mobile panel is open (so the OS back
// gesture has something to pop) and closes the panel — never deactivates selection — when that
// entry is the one popped — exclude from upstream sync.
export function useMobileSelectModeHistoryDismiss(channelId: string, isMobileLayout: boolean): void {
	const isPanelOpenForChannel = isMobileLayout && SelectMode.isPanelOpen && SelectMode.channelId === channelId;

	useEffect(() => {
		if (!isPanelOpenForChannel) return;
		pushMobileSelectModeHistoryEntry(channelId);
	}, [isPanelOpenForChannel, channelId]);

	useEffect(() => {
		if (!isMobileLayout) return;
		const handlePopState = () => {
			if (
				SelectMode.isPanelOpen &&
				SelectMode.channelId === channelId &&
				!isCurrentMobileSelectModeHistoryEntry(channelId)
			) {
				SelectMode.closePanel();
			}
		};
		window.addEventListener('popstate', handlePopState);
		return () => {
			window.removeEventListener('popstate', handlePopState);
		};
	}, [channelId, isMobileLayout]);
}
