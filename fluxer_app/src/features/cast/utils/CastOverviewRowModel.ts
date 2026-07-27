// SPDX-License-Identifier: AGPL-3.0-or-later

import * as CastCommands from '@app/features/cast/commands/CastCommands';
import {characterProfileUrl} from '@app/features/cast/utils/CharacterSlug';
import type {CastOverviewEntry, CastOverviewScopeKind} from '@app/features/cast/utils/CastOverviewTree';

/**
 * What a Cast Overview row shows, decided from the row's scope and status alone.
 *
 * Split out from the component for the same reason CastOverviewTree is split out from the page: the
 * rules are the part worth pinning, and pinning them here costs no render harness. The component is
 * then a direct transcription of this, with nothing to get subtly wrong per platform.
 */
export interface CastOverviewRowControls {
	/** The row is hidden at this scope; the checkbox is checked and the row renders dimmed. */
	isExcluded: boolean;
	/** Reflects the primary flag on this scope's own membership row. */
	isPrimary: boolean;
	/**
	 * Exclude is offered for category and channel scopes only. Server-wide there is no broader scope
	 * to fall back to, so hiding a character there would just be a worse way of removing it.
	 */
	canExclude: boolean;
	/**
	 * Always true. Every row the overview renders is LOCAL to its scope by construction — the tree
	 * emits a scope's own added/edited/excluded rows and nothing inherited — so removal always applies
	 * and always means the same thing, whatever sub-state the row is in.
	 */
	canRemove: boolean;
	/** The public profile link, or null when the roster carries no name worth slugging. */
	profileUrl: string | null;
}

export function castOverviewRowControls(
	scopeKind: CastOverviewScopeKind,
	entry: CastOverviewEntry,
): CastOverviewRowControls {
	return {
		isExcluded: entry.status === 'excluded',
		isPrimary: entry.isPrimary,
		canExclude: scopeKind !== 'server',
		canRemove: true,
		profileUrl: characterProfileUrl(entry.character.name),
	};
}

/**
 * A row's write, described before it is issued.
 *
 * Descriptors rather than direct calls so the ARGUMENT construction is testable without a network:
 * every bug this page can plausibly have is a scope threaded wrong, and that is entirely visible
 * here. `runCastRowWrite` is the only thing that touches the transport.
 */
export type CastRowWrite =
	| {kind: 'setPrimary'; guildId: string; characterId: string; isPrimary: boolean; channelId: string | undefined}
	| {kind: 'setExcluded'; guildId: string; characterId: string; excluded: boolean; channelId: string | null}
	| {kind: 'remove'; guildId: string; characterId: string; channelId: string | undefined};

/**
 * `undefined`, never `null`, for the server scope: setPrimary and removeCharacter omit `channel_id`
 * entirely when it is undefined, which is the exact body the guild settings tab sends. Passing null
 * would instead send an explicit `channel_id: null` that no existing call site produces.
 */
function scopeArg(scopeId: string | null): string | undefined {
	return scopeId ?? undefined;
}

export function primaryWrite(
	guildId: string,
	scopeId: string | null,
	entry: CastOverviewEntry,
	isPrimary: boolean,
): CastRowWrite {
	return {kind: 'setPrimary', guildId, characterId: entry.characterId, isPrimary, channelId: scopeArg(scopeId)};
}

/**
 * Excluding flips ONLY the excluded flag and leaves the nickname, avatar and reference image exactly
 * as they were, so un-checking restores them untouched.
 *
 * Deliberately NOT the ChannelCast store's exclude(), which first adds a membership row: every row
 * here already has one, by construction. And deliberately not removeCharacter on the way back, which
 * would delete the row along with its overrides — that is the X's job, and a separate decision.
 */
export function excludeWrite(
	guildId: string,
	scopeId: string | null,
	entry: CastOverviewEntry,
	excluded: boolean,
): CastRowWrite {
	return {kind: 'setExcluded', guildId, characterId: entry.characterId, excluded, channelId: scopeId};
}

/**
 * Drops this scope's local row entirely. The backend cascade takes the membership row and any
 * override with it, so a character with a parent scope still listing it reverts to pure inheritance,
 * and one with no parent presence disappears here.
 */
export function removeWrite(guildId: string, scopeId: string | null, entry: CastOverviewEntry): CastRowWrite {
	return {kind: 'remove', guildId, characterId: entry.characterId, channelId: scopeArg(scopeId)};
}

export function runCastRowWrite(write: CastRowWrite): Promise<unknown> {
	switch (write.kind) {
		case 'setPrimary':
			return CastCommands.setPrimary(write.guildId, write.characterId, write.isPrimary, write.channelId);
		case 'setExcluded':
			return CastCommands.updateOverride(write.guildId, write.characterId, {
				channelId: write.channelId,
				excluded: write.excluded,
			});
		case 'remove':
			return CastCommands.removeCharacter(write.guildId, write.characterId, write.channelId);
	}
}
