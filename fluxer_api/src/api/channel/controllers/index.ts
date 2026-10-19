// SPDX-License-Identifier: AGPL-3.0-or-later

import {CallController} from '@app/api/channel/controllers/CallController';
import {ChannelController} from '@app/api/channel/controllers/ChannelController';
import {ChannelFollowController} from '@app/api/channel/controllers/ChannelFollowController';
// LOCAL-ONLY: ChannelThemeController is a local-only addition — exclude from upstream sync.
import {ChannelThemeController} from '@app/api/channel/controllers/ChannelThemeController';
import {ForumController} from '@app/api/channel/controllers/ForumController';
import {MessageController} from '@app/api/channel/controllers/MessageController';
import {MessageInteractionController} from '@app/api/channel/controllers/MessageInteractionController';
// LOCAL-ONLY: RelocateMessagesController is a local-only addition — exclude from upstream sync.
import {RelocateMessagesController} from '@app/api/channel/controllers/RelocateMessagesController';
import {StreamController} from '@app/api/channel/controllers/StreamController';
import {ThreadController} from '@app/api/channel/controllers/ThreadController';
import {ThreadMemberSettingsController} from '@app/api/channel/controllers/ThreadMemberSettingsController';
import type {HonoApp} from '@app/api/types/HonoEnv';

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
	ChannelFollowController(app);
	MessageInteractionController(app);
	MessageController(app);
	CallController(app);
	StreamController(app);
	ThreadController(app);
	ForumController(app);
	ThreadMemberSettingsController(app);
}
