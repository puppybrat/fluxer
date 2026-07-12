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

import type {Message} from '@app/features/messaging/models/MessagingMessage';
import {ChannelMessages} from '@app/features/messaging/state/ChannelMessages';
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
            // Message objects are captured here (before removal) so they can be reinserted
            // into the destination channel below, without a round trip back to the API.
            const channelMsgs = MessagingMessages.getMessages(channelId);
            const startBigInt = BigInt(startMessageId);
            const endBigInt = BigInt(endMessageId);
            const idsToRemove: Array<string> = [];
            const movedMessages: Array<Message> = [];
            channelMsgs.forEach((message) => {
                const mid = BigInt(message.id);
                if (mid >= startBigInt && mid <= endBigInt) {
                    idsToRemove.push(message.id);
                    movedMessages.push(message);
                }
            });
            if (idsToRemove.length > 0) {
                MessagingMessages.handleMessageDeleteBulk({ids: idsToRemove, channelId});
            }

            // Insert into the destination channel's in-memory list so the messages appear
            // immediately without a refresh. Only attempted if the destination channel has
            // already been loaded (ready) — otherwise the normal fetch-on-open path will
            // pick them up. Safe because the backend preserves the original snowflake IDs
            // and only rewrites channel_id on move.
            if (movedMessages.length > 0 && ChannelMessages.get(destChannelId)?.ready) {
                for (const message of movedMessages) {
                    MessagingMessages.handleIncomingMessage({
                        channelId: destChannelId,
                        message: {...message.toJSON(), channel_id: destChannelId},
                    });
                }
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
