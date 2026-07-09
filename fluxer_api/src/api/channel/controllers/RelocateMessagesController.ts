/*
 * LOCAL-ONLY: This file is a local-only addition to fluxer_api and will never exist upstream.
 * It exposes POST /channels/relocate-messages — an admin-only endpoint for moving a
 * contiguous range of messages from one channel to another.
 *
 * Known limitations (not fixed here):
 *  - Meilisearch search index is NOT updated after the move.
 *  - No gateway events are dispatched for moved messages.
 *
 * Lines to check on upstream merge: none — exclude this file entirely from any upstream sync.
 */

// SPDX-License-Identifier: AGPL-3.0-or-later

import {z} from 'zod';
import {createChannelID, createMessageID} from '../../BrandedTypes';
import {LoginRequired} from '../../middleware/AuthMiddleware';
import type {HonoApp} from '../../types/HonoEnv';
import {Validator} from '../../Validator';
import {MessageRelocationRepository} from '../repositories/message/MessageRelocationRepository';

const RelocateMessagesRequest = z.object({
	sourceChannelId: z.string(),
	destChannelId: z.string(),
	startMessageId: z.string(),
	endMessageId: z.string(),
});

export function RelocateMessagesController(app: HonoApp) {
	app.post(
		'/channels/relocate-messages',
		LoginRequired,
		Validator('json', RelocateMessagesRequest),
		async (ctx) => {
			const {sourceChannelId, destChannelId, startMessageId, endMessageId} = ctx.req.valid('json');
			const repo = new MessageRelocationRepository();
			const result = await repo.relocateMessages({
				sourceChannelId: createChannelID(BigInt(sourceChannelId)),
				destChannelId: createChannelID(BigInt(destChannelId)),
				startMessageId: createMessageID(BigInt(startMessageId)),
				endMessageId: createMessageID(BigInt(endMessageId)),
			});
			return ctx.json(result);
		},
	);
}
