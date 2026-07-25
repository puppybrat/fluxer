// SPDX-License-Identifier: AGPL-3.0-or-later

import * as MediaViewerCommands from '@app/features/ui/commands/MediaViewerCommands';

/**
 * Opens a single image (a character's reference image, or its pfp as fallback) in the shared media
 * viewer — the same modal an image embed/attachment opens. The image URL is already proxied by the
 * time it reaches here (GuildCastDisplay carries the proxied cast URLs), so it is used as-is.
 *
 * Natural dimensions are unknown for an arbitrary cast image, so they are left at 0: the viewer
 * measures the loaded <img> for zoom/pan and simply hides its dimension label when they are 0.
 */
export function openCharacterImageViewer(imageUrl: string): void {
	MediaViewerCommands.openMediaViewer(
		[{src: imageUrl, originalSrc: imageUrl, naturalWidth: 0, naturalHeight: 0, type: 'image'}],
		0,
	);
}
