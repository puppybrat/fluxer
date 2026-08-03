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
	/**
	 * The roster row itself. Carried so a row can hand the whole character to surfaces that take one
	 * (the edit modal), and so the REAL name — nullable, unlike `name` — stays reachable for the
	 * profile link, which must not be built from an id fallback.
	 */
	character: CastCharacter;
	status: CastOverviewEntryStatus;
	/**
	 * The nickname set at THIS scope, or null. Never an inherited one.
	 *
	 * Kept for excluded rows too: excluding only flips the `excluded` flag and leaves the display
	 * fields untouched, so hiding the nickname here would misreport what un-excluding restores.
	 */
	nickname: string | null;
	/** Whether this character is flagged primary at THIS exact scope. */
	isPrimary: boolean;
	/** The avatar for this row: this scope's override when it sets one, else the roster's. */
	pfpUrl: string | null;
	/**
	 * The override row at THIS exact scope, or null when none exists.
	 *
	 * This — never a resolved or inherited value — is what an edit modal must pre-fill from: saving
	 * an inherited value unchanged would silently promote it into a real local override here.
	 */
	localOverride: {nickname: string | null; pfpUrl: string | null; referenceImageUrl: string | null} | null;
}

export type CastOverviewScopeKind = 'server' | 'category' | 'channel';

export interface CastOverviewGroup {
	kind: CastOverviewScopeKind;
	/** The channel/category id this group is scoped to; null for the server-wide group. */
	scopeId: string | null;
	name: string;
	/** This scope's own local rows. Empty is normal and rendered as label + Add. */
	entries: Array<CastOverviewEntry>;
	/**
	 * What sits under this scope: its channel groups first, then the categories nested inside it, each
	 * carrying its own children to any depth. Always empty for channel and server groups.
	 */
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
 * The sidebar's order comes from ChannelOrganization.organizeChannels, which emits the ROOT bucket —
 * the parentless channels — before any category, each category following in position order with its
 * own channels and then its own nested categories beneath it. Parentless channels therefore always
 * sit ABOVE every category, and within a category its channels sit above its subcategories; the
 * sidebar never interleaves the two, so neither does this tree.
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
	const characterById = new Map(characters.map((character) => [character.id, character]));
	const localOverrides = new Map(
		overrides.filter((override) => (override.channel_id ?? null) === scopeId).map((o) => [o.character_id, o]),
	);
	// The membership rows at this scope, keyed so the primary flag survives alongside the id. A row's
	// presence is what makes a character local here; `is_primary` is a property of that same row.
	const localMembership = new Map(
		primaries.filter((primary) => (primary.channel_id ?? null) === scopeId).map((primary) => [primary.character_id, primary]),
	);

	/** A character present only in the rows, not the roster, still deserves a row over being dropped. */
	const fallbackCharacter = (id: string): CastCharacter => ({
		id,
		name: null,
		alias: null,
		ship: null,
		owner: null,
		nickname: null,
		pfp_url: null,
		reference_image_url: null,
	});

	const entries: Array<CastOverviewEntry> = [];
	const seen = new Set<string>();
	const push = (characterId: string, status: CastOverviewEntryStatus) => {
		if (seen.has(characterId)) {
			return;
		}
		seen.add(characterId);
		const character = characterById.get(characterId) ?? fallbackCharacter(characterId);
		const override = localOverrides.get(characterId);
		entries.push({
			characterId,
			name: character.name ?? characterId,
			character,
			status,
			nickname: override?.nickname ?? null,
			isPrimary: localMembership.get(characterId)?.is_primary ?? false,
			// This scope's own avatar wins; otherwise the roster's server-scope projection, which is
			// what the character looks like before this scope says anything about it.
			pfpUrl: override?.pfp_url ?? character.pfp_url,
			localOverride:
				override == null
					? null
					: {
							nickname: override.nickname,
							pfpUrl: override.pfp_url,
							referenceImageUrl: override.reference_image_url,
						},
		});
	};

	for (const [characterId, override] of localOverrides) {
		if (override.excluded) {
			push(characterId, 'excluded');
		} else if (hasDisplayOverride(override)) {
			push(characterId, 'edited');
		}
	}
	// Anything with a local membership row but no override of its own is a plain local add. Excluded
	// characters also carry a membership row, so the loop above must run first to claim them.
	for (const characterId of localMembership.keys()) {
		push(characterId, 'added');
	}
	return entries.sort(compareByName);
}

/**
 * Builds the Cast Overview tree from ONE unscoped cast read.
 *
 * Shape mirrors the real channel sidebar (ChannelOrganization.organizeChannels): the server group
 * first, then parentless channel groups in sidebar order, then root category groups in sidebar order,
 * each carrying its own overridden channels and then the categories nested inside it — to any depth,
 * since categories may nest.
 *
 * Parentless channels sit ABOVE the categories rather than interleaved among them because that is
 * what the sidebar does — organizeChannels emits the root bucket before any category, so position
 * only orders within each partition and can never lift a channel between two categories. The same
 * split repeats inside every category: its channels first, then its subcategories.
 *
 * EVERY category and channel gets a group, whether or not it has any local cast data. An empty one
 * renders as just its label and an Add button, which is how a scope gets its first override — build
 * the tree only from scopes that already have rows and there is no way in.
 *
 * Nothing is ever dropped. A parentId that resolves to no known category — stale, unsynced, or not a
 * category at all — is treated as absent and the group surfaces at root; a parent cycle is broken the
 * same way, leaving its members reachable at root rather than nested into each other forever.
 */
export function buildCastOverviewTree(args: BuildArgs): Array<CastOverviewGroup> {
	const {primaries, overrides, channelsById} = args;

	// The union of every channel in the guild AND every scope carrying rows. The second half is not
	// redundant: cast rows can outlive the channel they point at (a deleted channel whose overrides
	// were never cleaned up upstream), and enumerating the store alone would silently hide them.
	const scopedIds = new Set<string>(channelsById.keys());
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
		// No empty-scope skip: a scope with nothing local is exactly the one that needs its Add button.
		const entries = buildEntriesForScope(scopeId, args);
		if (info?.isCategory) {
			categoryGroups.set(scopeId, {
				ordering: orderingFor(scopeId, info),
				group: {
					kind: 'category',
					scopeId,
					name: displayName(scopeId, info, true),
					entries,
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

	// Channel groups are attached to their category before any category nesting is resolved, so the
	// nesting pass below only has to move whole categories around.
	const channelChildrenByCategory = new Map<string, Array<SortableGroup>>();
	for (const [parentId, children] of pendingChildren) {
		if (!categoryGroups.has(parentId)) {
			// A parent the store does not know about: still emitted so its children stay grouped under
			// something rather than floating at the top level.
			const info = channelsById.get(parentId);
			categoryGroups.set(parentId, {
				ordering: orderingFor(parentId, info),
				group: {
					kind: 'category',
					scopeId: parentId,
					name: displayName(parentId, info, true),
					entries: buildEntriesForScope(parentId, args),
					children: [],
				},
			});
		}
		channelChildrenByCategory.set(parentId, children);
	}

	/**
	 * The category this category renders inside, or null for root.
	 *
	 * Walking to the top proves the chain terminates. A cycle returns null so every member stays
	 * reachable at root — nesting them into each other would build a subtree no root can reach, which
	 * is the silent drop this builder promises never to do.
	 */
	const resolveCategoryParentId = (categoryId: string): string | null => {
		const directParentId = channelsById.get(categoryId)?.parentId ?? null;
		if (directParentId == null || !categoryGroups.has(directParentId)) {
			return null;
		}
		const seen = new Set<string>([categoryId]);
		let ancestorId: string | null = directParentId;
		while (ancestorId != null) {
			if (seen.has(ancestorId)) {
				return null;
			}
			seen.add(ancestorId);
			const nextId: string | null = channelsById.get(ancestorId)?.parentId ?? null;
			ancestorId = nextId != null && categoryGroups.has(nextId) ? nextId : null;
		}
		return directParentId;
	};

	const rootCategoryGroups: Array<SortableGroup> = [];
	const categoryChildrenByCategory = new Map<string, Array<SortableGroup>>();
	for (const [categoryId, sortable] of categoryGroups) {
		const parentId = resolveCategoryParentId(categoryId);
		if (parentId == null) {
			rootCategoryGroups.push(sortable);
			continue;
		}
		const siblings = categoryChildrenByCategory.get(parentId);
		if (siblings) {
			siblings.push(sortable);
		} else {
			categoryChildrenByCategory.set(parentId, [sortable]);
		}
	}

	// Channels above subcategories at every depth, mirroring the sidebar's root ordering. Assignment is
	// by reference, so a grandchild attached here is already in place when its parent is assigned.
	for (const [categoryId, sortable] of categoryGroups) {
		const channelChildren = (channelChildrenByCategory.get(categoryId) ?? []).sort(compareSortable);
		const categoryChildren = (categoryChildrenByCategory.get(categoryId) ?? []).sort(compareSortable);
		sortable.group.children = [...channelChildren, ...categoryChildren].map((child) => child.group);
	}

	const serverGroup: CastOverviewGroup = {
		kind: 'server',
		scopeId: null,
		name: '',
		entries: buildEntriesForScope(null, args),
		children: [],
	};

	// Root bucket before categories, exactly as organizeChannels emits them. Only ROOT categories are
	// listed here; a nested one reaches the renderer through its parent's `children`.
	const topLevel = [...topLevelChannelGroups.sort(compareSortable), ...rootCategoryGroups.sort(compareSortable)].map(
		(entry) => entry.group,
	);
	return [serverGroup, ...topLevel];
}
