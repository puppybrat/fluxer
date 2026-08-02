// SPDX-License-Identifier: AGPL-3.0-or-later

import type {FluxerSearchIndexName} from '@pkgs/elasticsearch_search/src/ElasticsearchIndexDefinitions';

export interface MeilisearchIndexDefinition {
	uid: FluxerSearchIndexName;
	primaryKey: string;
	searchableAttributes: Array<string>;
	filterableAttributes: Array<string>;
	sortableAttributes: Array<string>;
	// Omit to keep Meilisearch's default rules. Set this only when an explicit
	// sort must outrank relevancy: the default puts `sort` fifth, so it only
	// breaks ties inside relevancy buckets rather than ordering the whole result.
	rankingRules?: Array<string>;
	// Omit to keep Meilisearch's default of 1000. That default caps `offset +
	// limit` AND clamps `estimatedTotalHits`, so on a large index every broad
	// query reports exactly 1000 matches regardless of the real number.
	//
	// Cost, measured against the 1.1M-document production index: a large `limit`
	// is expensive (~25ms per 1000 documents actually returned and ranked), but a
	// large `offset` is nearly free — limit=25 held at 4-5ms from offset 0 through
	// offset 9975. The API caps hits_per_page at 25 (MessageRequestSchemas), so the
	// worst shape a client can actually send is deep-offset/small-limit, i.e. the
	// cheap one. Shallow queries are unaffected by this value.
	pagination?: {maxTotalHits: number};
}

export const MEILISEARCH_INDEX_DEFINITIONS: Record<FluxerSearchIndexName, MeilisearchIndexDefinition> = {
	messages: {
		uid: 'messages',
		primaryKey: 'id',
		searchableAttributes: ['content', 'embedContent'],
		filterableAttributes: [
			'id',
			'channelId',
			'guildId',
			'authorId',
			'authorType',
			'mentionEveryone',
			'isPinned',
			'mentionedUserIds',
			'hasLink',
			'hasEmbed',
			'hasPoll',
			'hasFile',
			'hasVideo',
			'hasImage',
			'hasSound',
			'hasSticker',
			'hasForward',
			'embedTypes',
			'embedProviders',
			'linkHostnames',
			'attachmentFilenames',
			'attachmentExtensions',
			'ic',
			'castCharacterIds',
		],
		sortableAttributes: ['createdAt', 'id'],
		// `sort` leads so an explicit timestamp sort orders every hit. With the
		// default ordering a multi-word query buckets hits by relevancy first,
		// leaving each bucket internally sorted but restarting the timestamps at
		// every bucket boundary. Sort-by-relevancy sends no sort, so this is inert
		// there.
		rankingRules: ['sort', 'words', 'typo', 'proximity', 'attribute', 'exactness'],
		pagination: {maxTotalHits: 100_000},
	},
	guilds: {
		uid: 'guilds',
		primaryKey: 'id',
		searchableAttributes: ['name', 'discoveryTags', 'vanityUrlCode', 'discoveryDescription'],
		filterableAttributes: [
			'ownerId',
			'verificationLevel',
			'mfaLevel',
			'nsfwLevel',
			'features',
			'isDiscoverable',
			'discoveryCategory',
			'discoveryPrimaryLanguage',
			'discoveryTags',
		],
		sortableAttributes: ['createdAt', 'memberCount', 'id'],
	},
	users: {
		uid: 'users',
		primaryKey: 'id',
		searchableAttributes: ['username', 'email', 'id'],
		filterableAttributes: [
			'isBot',
			'isSystem',
			'emailVerified',
			'emailBounced',
			'premiumType',
			'tempBannedUntil',
			'pendingDeletionAt',
			'acls',
			'suspiciousActivityFlags',
			'createdAt',
		],
		sortableAttributes: ['createdAt', 'lastActiveAt', 'id'],
	},
	reports: {
		uid: 'reports',
		primaryKey: 'id',
		searchableAttributes: ['category', 'additionalInfo', 'reportedGuildName', 'reportedChannelName'],
		filterableAttributes: [
			'reporterId',
			'status',
			'reportType',
			'category',
			'reportedUserId',
			'reportedGuildId',
			'reportedMessageId',
			'guildContextId',
			'resolvedByAdminId',
			'resolvedAt',
		],
		sortableAttributes: ['createdAt', 'reportedAt', 'resolvedAt', 'id'],
	},
	audit_logs: {
		uid: 'audit_logs',
		primaryKey: 'id',
		searchableAttributes: ['action', 'targetType', 'targetId', 'auditLogReason'],
		filterableAttributes: ['adminUserId', 'targetType', 'targetId', 'action'],
		sortableAttributes: ['createdAt', 'id'],
	},
	guild_members: {
		uid: 'guild_members',
		primaryKey: 'id',
		searchableAttributes: ['username', 'usernameSearch', 'discriminator', 'globalName', 'nickname', 'userId'],
		filterableAttributes: [
			'guildId',
			'roleIds',
			'joinedAt',
			'joinSourceType',
			'sourceInviteCode',
			'userCreatedAt',
			'isBot',
		],
		sortableAttributes: ['joinedAt', 'id'],
	},
};
