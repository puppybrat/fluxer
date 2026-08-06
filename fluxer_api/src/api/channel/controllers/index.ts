// SPDX-License-Identifier: AGPL-3.0-or-later

import type {HonoApp} from '../../types/HonoEnv';
import {CallController} from './CallController';
import {ChannelController} from './ChannelController';
// LOCAL-ONLY: ChannelThemeController is a local-only addition — exclude from upstream sync.
import {ChannelThemeController} from './ChannelThemeController';
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
	// LOCAL-ONLY: ChannelThemeController must register before ChannelController for the same
	// reason RelocateMessagesController does — its /channels/:channel_id/appearance routes must
	// not be shadowed by ChannelController's parameterised /channels/:channel_id family — and it
	// also owns the /themes library routes. Exclude from upstream sync.
	ChannelThemeController(app);
	ChannelController(app);
	MessageInteractionController(app);
	MessageController(app);
	ScheduledMessageController(app);
	CallController(app);
	StreamController(app);
	VoiceDiagnosticsController(app);
	VoicePresenceController(app);
}
