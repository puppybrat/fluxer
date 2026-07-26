// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CastCharacter, CastOverrideRow, CastPrimary} from '@app/features/cast/commands/CastCommands';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {compareChannelOrdering} from '@fluxer/schema/src/domains/channel/GuildChannelOrdering';

/**
 * What a scope did to a character LOCALLY, in precedence order:
 * - `excluded` — a local excluded override hides the character here, whatever broader scopes say.
 * - `edited`   — a local override supplies a nickname/pfp/reference here.
 * - `added`    — a local membership row puts the character in this scope's cast, unmodified.
 *
 * `excluded` outranks `edited` because excluding also writes a membership row (see ChannelCast.exclude),
 * and `edited` outranks `added` because an edited character is necessarily also present.
 */
export type CastOverviewEntryStatus = 'excluded' | 'edited' | 'added';

export interface CastOverviewEntry {
	characterId: string;
	/** The character's real name, or its id when the roster does not carry one. */
	name: string;
	status: CastOverviewEntryStatus;
	/** The nickname set at THIS scope, or null. Never an inherited one. */
	nickname: string | null;
}

export type CastOverviewScopeKind = 'server' | 'category' | 'channel';

export interface CastOverviewGroup {
	kind: CastOverviewScopeKind;
	/** The channel/category id this group is scoped to; null for the server-wide group. */
	scopeId: string | null;
	name: string;
	entries: Array<CastOverviewEntry>;
	/**
	 * True when a category appears ONLY to host overridden channels beneath it and has no local
	 * delta of its own. Such a category is still rendered as a header so its children nest visibly
	 * under the right name rather than floating at the top level.
	 */
	structuralOnly: boolean;
	/** Channel groups nested under a category. Always empty for channel and server groups. */
	children: Array<CastOverviewGroup>;
}

/** The channel facts this builder needs, read from the Channels store by the caller. */
export interface CastOverviewChannelInfo {
	id: string;
	name: string | null;
	parentId: string | null;
	isCategory: boolean;
	/** The sidebar ordering field. Optional exactly as Channel.position is; absent sorts as 0. */
	position?: number | null;
}

interface BuildArgs {
	characters: ReadonlyArray<CastCharacter>;
	primaries: ReadonlyArray<CastPrimary>;
	overrides: ReadonlyArray<CastOverrideRow>;
	/** Every channel/category in the guild, keyed by id. Missing ids degrade gracefully. */
	channelsById: ReadonlyMap<string, CastOverviewChannelInfo>;
}

function compareByName(a: {name: string}, b: {name: string}): number {
	return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'});
}

/**
 * Groups are ordered the way the real channel sidebar orders itself, not alphabetically.
 *
 * The sidebar's order comes from ChannelOrganization.organizeChannels, which sorts everything with
 * compareChannelOrdering (position, then id as a tiebreak) and then emits the ROOT bucket — the
 * parentless channels — before any category, each category following in position order with its own
 * children beneath it. Parentless channels therefore always sit ABOVE every category; the sidebar
 * never interleaves the two, so neither does this tree.
 *
 * compareChannelOrdering is imported rather than reimplemented so the two orderings cannot drift.
 */
interface SortableGroup {
	/**
	 * Shim satisfying ChannelOrderingChannel. `type` is required by that interface but is not read by
	 * compareChannelOrdering (which compares position then id); it is filled in faithfully anyway so
	 * the shim never misrepresents a category as a text channel.
	 */
	ordering: {id: string; type: number; position?: number | null};
	group: CastOverviewGroup;
}

function compareSortable(a: SortableGroup, b: SortableGroup): number {
	return compareChannelOrdering(a.ordering, b.ordering);
}

function hasDisplayOverride(override: CastOverrideRow): boolean {
	return override.nickname != null || override.pfp_url != null || override.reference_image_url != null;
}

/**
 * Builds the LOCAL delta for one scope — the characters this exact scope adds, edits or excludes.
 *
 * Deliberately computed from the raw per-scope rows rather than from `resolved_cast`: the overview
 * shows what each scope CHANGES, not the roster it resolves to, and the unscoped read carries every
 * scope's rows at once (so the whole tree costs one fetch). This is the same local/inherited/excluded
 * distinction ChannelCast draws via isLocalRow, applied per scope instead of to a single open tab.
 */
function buildEntriesForScope(
	scopeId: string | null,
	{characters, primaries, overrides}: Omit<BuildArgs, 'channelsById'>,
): Array<CastOverviewEntry> {
	const nameById = new Map(characters.map((character) => [character.id, character.name]));
	const localOverrides = new Map(
		overrides.filter((override) => (override.channel_id ?? null) === scopeId).map((o) => [o.character_id, o]),
	);
	const localPrimaryIds = new Set(
		primaries.filter((primary) => (primary.channel_id ?? null) === scopeId).map((primary) => primary.character_id),
	);

	const entries: Array<CastOverviewEntry> = [];
	const seen = new Set<string>();
	const push = (characterId: string, status: CastOverviewEntryStatus, nickname: string | null) => {
		if (seen.has(characterId)) {
			return;
		}
		seen.add(characterId);
		entries.push({characterId, name: nameById.get(characterId) ?? characterId, status, nickname});
	};

	for (const [characterId, override] of localOverrides) {
		if (override.excluded) {
			push(characterId, 'excluded', null);
		} else if (hasDisplayOverride(override)) {
			push(characterId, 'edited', override.nickname);
		}
	}
	// Anything with a local membership row but no override of its own is a plain local add. Excluded
	// characters also carry a membership row, so the loop above must run first to claim them.
	for (const characterId of localPrimaryIds) {
		push(characterId, 'added', null);
	}
	return entries.sort(compareByName);
}

/**
 * Builds the two-level Cast Overview tree from ONE unscoped cast read.
 *
 * Shape mirrors the real channel sidebar (ChannelOrganization.organizeChannels): the server group
 * first, then parentless channel groups in sidebar order, then category groups in sidebar order with
 * each category's own overridden channels nested beneath it, also in sidebar order.
 *
 * Parentless channels sit ABOVE the categories rather than interleaved among them because that is
 * what the sidebar does — organizeChannels emits the root bucket before any category, so position
 * only orders within each partition and can never lift a channel between two categories.
 *
 * A category with overridden children but no local delta of its own is still emitted, flagged
 * `structuralOnly`, so its children remain visibly grouped under the right category name.
 *
 * Only categories can have children (the channel model forbids nesting a category under a category),
 * so the tree is at most two levels deep by construction.
 */
export function buildCastOverviewTree(args: BuildArgs): Array<CastOverviewGroup> {
	const {primaries, overrides, channelsById} = args;

	const scopedIds = new Set<string>();
	for (const row of [...primaries, ...overrides]) {
		if (row.channel_id != null) {
			scopedIds.add(row.channel_id);
		}
	}

	const categoryGroups = new Map<string, SortableGroup>();
	const topLevelChannelGroups: Array<SortableGroup> = [];
	const pendingChildren = new Map<string, Array<SortableGroup>>();

	/** What compareChannelOrdering reads: the sidebar position, with the id as its stable tiebreak. */
	const orderingFor = (id: string, info: CastOverviewChannelInfo | undefined) => ({
		id,
		type: info?.isCategory ? ChannelTypes.GUILD_CATEGORY : ChannelTypes.GUILD_TEXT,
		position: info?.position ?? null,
	});

	const displayName = (id: string, info: CastOverviewChannelInfo | undefined, isCategory: boolean): string => {
		const name = info?.name;
		if (name == null || name === '') {
			// A scope whose channel is gone (or not yet synced) still has rows worth showing; fall back
			// to the raw id rather than dropping the group and silently hiding real overrides.
			return id;
		}
		return isCategory ? name : `#${name}`;
	};

	for (const scopeId of scopedIds) {
		const info = channelsById.get(scopeId);
		const entries = buildEntriesForScope(scopeId, args);
		if (entries.length === 0) {
			continue;
		}
		if (info?.isCategory) {
			categoryGroups.set(scopeId, {
				ordering: orderingFor(scopeId, info),
				group: {
					kind: 'category',
					scopeId,
					name: displayName(scopeId, info, true),
					entries,
					structuralOnly: false,
					children: [],
				},
			});
			continue;
		}
		const group: SortableGroup = {
			ordering: orderingFor(scopeId, info),
			group: {
				kind: 'channel',
				scopeId,
				name: displayName(scopeId, info, false),
				entries,
				structuralOnly: false,
				children: [],
			},
		};
		const parentId = info?.parentId ?? null;
		// An unknown parent is treated as no parent: better to show the group at the top level than to
		// hide it under a category that cannot be named.
		if (parentId != null && channelsById.get(parentId)?.isCategory) {
			const siblings = pendingChildren.get(parentId);
			if (siblings) {
				siblings.push(group);
			} else {
				pendingChildren.set(parentId, [group]);
			}
		} else {
			topLevelChannelGroups.push(group);
		}
	}

	for (const [parentId, children] of pendingChildren) {
		const existing = categoryGroups.get(parentId);
		if (existing) {
			existing.group.children = children.sort(compareSortable).map((child) => child.group);
			continue;
		}
		const info = channelsById.get(parentId);
		categoryGroups.set(parentId, {
			ordering: orderingFor(parentId, info),
			group: {
				kind: 'category',
				scopeId: parentId,
				name: displayName(parentId, info, true),
				entries: [],
				structuralOnly: true,
				children: children.sort(compareSortable).map((child) => child.group),
			},
		});
	}

	const serverGroup: CastOverviewGroup = {
		kind: 'server',
		scopeId: null,
		name: '',
		entries: buildEntriesForScope(null, args),
		structuralOnly: false,
		children: [],
	};

	// Root bucket before categories, exactly as organizeChannels emits them.
	const topLevel = [
		...topLevelChannelGroups.sort(compareSortable),
		...[...categoryGroups.values()].sort(compareSortable),
	].map((entry) => entry.group);
	return [serverGroup, ...topLevel];
}
