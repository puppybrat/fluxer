// SPDX-License-Identifier: AGPL-3.0-or-later

import type {HonoApp} from '../../types/HonoEnv';
import {CallController} from './CallController';
import {ChannelController} from './ChannelController';
import {MessageController} from './MessageController';
import {MessageInteractionController} from './MessageInteractionController';
// LOCAL-ONLY: RelocateMessagesController is a local-only addition — exclude from upstream sync.
import {RelocateMessagesController} from './RelocateMessagesController';
import {ScheduledMessageController} from './ScheduledMessageController';
import {StreamController} from './StreamController';
import {VoiceDiagnosticsController} from './VoiceDiagnosticsController';
import {VoicePresenceController} from './VoicePresenceController';

export function registerChannelControllers(app: HonoApp) {
	// LOCAL-ONLY: RelocateMessagesController must register before ChannelController so the
	// literal GET /channels/relocate-log route isn't shadowed by ChannelController's
	// GET /channels/:channel_id — exclude from upstream sync.
	RelocateMessagesController(app);
	ChannelController(app);
	MessageInteractionController(app);
	MessageController(app);
	ScheduledMessageController(app);
	CallController(app);
	StreamController(app);
	VoiceDiagnosticsController(app);
	VoicePresenceController(app);
}
