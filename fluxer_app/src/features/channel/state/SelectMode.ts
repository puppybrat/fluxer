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

import {http} from '@app/features/platform/transport/RestTransport';
import MessagingMessages from '@app/features/messaging/state/MessagingMessages';
import {makeAutoObservable, runInAction} from 'mobx';

interface RelocateResponse {
    movedCount: number;
}

class SelectMode {
    isActive = false;
    channelId: string | null = null;
    anchorId: string | null = null;
    headId: string | null = null;
    destChannelId: string | null = null;
    submitting = false;
    lastError: string | null = null;
    result: RelocateResponse | null = null;

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
        this.isActive = true;
        this.channelId = channelId;
        this.anchorId = null;
        this.headId = null;
        this.destChannelId = null;
        this.result = null;
        this.lastError = null;
    }

    deactivate(): void {
        this.isActive = false;
        this.channelId = null;
        this.anchorId = null;
        this.headId = null;
        this.destChannelId = null;
        this.submitting = false;
        this.lastError = null;
        this.result = null;
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

    setDestChannelId(channelId: string | null): void {
        this.destChannelId = channelId;
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
            const channelMsgs = MessagingMessages.getMessages(channelId);
            const startBigInt = BigInt(startMessageId);
            const endBigInt = BigInt(endMessageId);
            const idsToRemove: Array<string> = [];
            channelMsgs.forEach((message) => {
                const mid = BigInt(message.id);
                if (mid >= startBigInt && mid <= endBigInt) {
                    idsToRemove.push(message.id);
                }
            });
            if (idsToRemove.length > 0) {
                MessagingMessages.handleMessageDeleteBulk({ids: idsToRemove, channelId});
            }

            runInAction(() => {
                this.result = response.body;
                this.submitting = false;
            });
        } catch (error) {
            runInAction(() => {
                this.lastError = error instanceof Error ? error.message : 'unknown';
                this.submitting = false;
            });
        }
    }
}

export default new SelectMode();
