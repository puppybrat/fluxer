/*
 * LOCAL-ONLY: This file is a local-only addition to fluxer_app and will never exist upstream.
 * It implements selection mode for the message relocation feature, coordinating with the
 * POST /api/v1/channels/relocate-messages endpoint added in fluxer_api.
 *
 * Known limitations (inherited from the API):
 *  - Meilisearch search index is NOT updated after a move.
 *  - No gateway events are dispatched; only the local in-memory state is updated.
 *
 * Lines to check on upstream merge: none — exclude this file entirely from any upstream sync.
 */

// SPDX-License-Identifier: AGPL-3.0-or-later

import MessagingMessages from '@app/features/messaging/state/MessagingMessages';
import {http} from '@app/features/platform/transport/RestTransport';
import {makeAutoObservable, runInAction} from 'mobx';

interface RelocateResponse {
    movedCount: number;
}

// LOCAL-ONLY: shape of GET /channels/relocate-log entries — exclude from upstream sync.
export interface RelocateLogEntry {
    logId: string;
    performedBy: {
        id: string;
        displayName: string | null;
    };
    sourceChannel: {
        id: string;
        name: string | null;
    };
    destChannel: {
        id: string;
        name: string | null;
    };
    startMessageId: string;
    endMessageId: string;
    movedCount: number;
    createdAt: string;
}

const RECENT_LOG_LIMIT = 5;

class SelectMode {
    isActive = false;
    // LOCAL-ONLY: isPanelOpen is mobile-only — controls the panel overlay's visibility
    // independently of isActive (selection enablement). Desktop ignores this field and
    // keeps rendering the panel whenever isActive && channelId matches — exclude from upstream sync.
    isPanelOpen = false;
    channelId: string | null = null;
    anchorId: string | null = null;
    headId: string | null = null;
    destChannelId: string | null = null;
    submitting = false;
    lastError: string | null = null;
    result: RelocateResponse | null = null;
    recentLog: Array<RelocateLogEntry> = [];
    logLoading = false;

    constructor() {
        makeAutoObservable(this, {}, {autoBind: true});
    }

    get startMessageId(): string | null {
        if (this.anchorId == null) return null;
        if (this.headId == null) return this.anchorId;
        return BigInt(this.anchorId) <= BigInt(this.headId) ? this.anchorId : this.headId;
    }

    get endMessageId(): string | null {
        if (this.anchorId == null) return null;
        if (this.headId == null) return this.anchorId;
        return BigInt(this.anchorId) >= BigInt(this.headId) ? this.anchorId : this.headId;
    }

    get canSubmit(): boolean {
        return this.isActive && this.anchorId != null && this.destChannelId != null && !this.submitting;
    }

    activate(channelId: string): void {
        this.channelId = channelId;
        this.openPanel();
        void this.fetchRecentLog();
    }

    deactivate(): void {
        this.isActive = false;
        this.isPanelOpen = false;
        this.channelId = null;
        this.anchorId = null;
        this.headId = null;
        this.destChannelId = null;
        this.submitting = false;
        this.lastError = null;
        this.result = null;
    }

    // LOCAL-ONLY: mobile panel visibility — decoupled from isActive — exclude from upstream sync.
    openPanel(): void {
        this.isPanelOpen = true;
    }

    closePanel(): void {
        this.isPanelOpen = false;
    }

    // LOCAL-ONLY: toggles selection enablement independently of panel visibility — exclude from upstream sync.
    toggleSelectionMode(): void {
        if (this.isActive) {
            this.isActive = false;
            this.anchorId = null;
            this.headId = null;
            this.destChannelId = null;
            this.result = null;
            this.lastError = null;
        } else {
            this.isActive = true;
        }
    }

    setAnchor(messageId: string): void {
        this.anchorId = messageId;
        this.headId = null;
        this.result = null;
        this.lastError = null;
    }

    setHead(messageId: string): void {
        this.headId = messageId;
    }

    reset(): void {
        this.anchorId = null;
        this.headId = null;
        this.result = null;
        this.lastError = null;
    }

    setDestChannelId(channelId: string | null): void {
        this.destChannelId = channelId;
    }

    // LOCAL-ONLY: relocate audit log fetch — exclude from upstream sync.
    async fetchRecentLog(): Promise<void> {
        runInAction(() => {
            this.logLoading = true;
        });
        try {
            const response = await http.get<Array<RelocateLogEntry>>('/channels/relocate-log', {
                query: {limit: RECENT_LOG_LIMIT},
            });
            runInAction(() => {
                this.recentLog = response.body;
                this.logLoading = false;
            });
        } catch {
            runInAction(() => {
                this.logLoading = false;
            });
        }
    }

    async submit(): Promise<void> {
        const {channelId, startMessageId, endMessageId, destChannelId} = this;
        if (!this.canSubmit || channelId == null || startMessageId == null || endMessageId == null || destChannelId == null) {
            return;
        }

        runInAction(() => {
            this.submitting = true;
            this.lastError = null;
            this.result = null;
        });

        try {
            const response = await http.post<RelocateResponse>('/channels/relocate-messages', {
                body: {
                    sourceChannelId: channelId,
                    destChannelId,
                    startMessageId,
                    endMessageId,
                },
            });

            // Surgically remove moved messages from the source channel's in-memory list.
            // Uses the same path as gateway MESSAGE_DELETE_BULK so scroll position is preserved.
            // The destination channel is intentionally NOT updated in-memory: the captured wire
            // objects carry literal attachment/embed URLs with the source channel ID baked into
            // the path, so reinserting them locally renders 404 media. The destination picks the
            // messages up with correct URLs via the normal fetch-on-open path.
            const channelMsgs = MessagingMessages.getMessages(channelId);
            const startBigInt = BigInt(startMessageId);
            const endBigInt = BigInt(endMessageId);
            const idsToRemove: Array<string> = [];
            // forAll (not forEach) walks the before/after buffers too, not just the visible window —
            // otherwise moved messages that have scrolled into beforeBuffer are never collected here,
            // never removed from the local cache, and get replayed on scroll-up via loadFromCache.
            channelMsgs.forAll((message) => {
                const mid = BigInt(message.id);
                if (mid >= startBigInt && mid <= endBigInt) {
                    idsToRemove.push(message.id);
                }
            });
            // Arm the moved-id guard so a subsequent scroll-up that hits the network can't resurface
            // these relocated messages via an API-fetched page (see MessagingMessages.markMovedIds).
            MessagingMessages.markMovedIds(channelId, idsToRemove);
            if (idsToRemove.length > 0) {
                MessagingMessages.handleMessageDeleteBulk({ids: idsToRemove, channelId});
            }

            runInAction(() => {
                this.result = response.body;
                this.submitting = false;
            });
            void this.fetchRecentLog();
        } catch (error) {
            runInAction(() => {
                this.lastError = error instanceof Error ? error.message : 'unknown';
                this.submitting = false;
            });
        }
    }
}

export default new SelectMode();
