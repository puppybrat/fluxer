// SPDX-License-Identifier: AGPL-3.0-or-later

import type {MeilisearchClient, MeilisearchTask} from '@app/api/search/meilisearch/MeilisearchClient';
import {MeilisearchMessageAdapter} from '@app/api/search/meilisearch/MeilisearchDomainAdapters';
import {MEILISEARCH_MAX_TRACKED_BULK_TASKS} from '@app/api/search/meilisearch/MeilisearchIndexAdapter';
import type {SearchableMessage} from '@fluxer/schema/src/contracts/search/SearchDocumentTypes';
import {describe, expect, it} from 'vitest';

interface RecordedMeilisearchRequest {
	method: string;
	path: string;
	body: unknown;
}

// Meilisearch settings sub-resources whose value is an object; these accept PATCH
// only. Everything else under /settings/ is array-valued and accepts PUT.
const OBJECT_VALUED_SETTINGS = ['pagination', 'faceting', 'typo-tolerance'];

class FakeMeilisearchClient implements MeilisearchClient {
	readonly requests: Array<RecordedMeilisearchRequest> = [];
	readonly waitedTaskUids: Array<number> = [];
	private nextTaskUid = 1;
	indexExists = false;

	async request<TResponse>(method: string, path: string, body?: unknown): Promise<TResponse> {
		this.requests.push({method, path, body});
		if (method === 'GET' && path.startsWith('/indexes/')) {
			if (!this.indexExists) {
				throw new Error('404 index_not_found');
			}
			return {uid: path.slice('/indexes/'.length)} as TResponse;
		}
		if (method === 'POST' && path === '/indexes') {
			this.indexExists = true;
			return this.nextTask() as TResponse;
		}
		// Mirror real Meilisearch's verb split so a wrong method fails here rather
		// than at container startup: object-valued settings answer PUT with
		// `405 Method Not Allowed / allow: GET, PATCH, DELETE`, array-valued ones
		// only accept PUT. Getting this wrong once took production down.
		if (path.includes('/settings/')) {
			const objectValuedSetting = OBJECT_VALUED_SETTINGS.some((name) => path.endsWith(`/settings/${name}`));
			const expected = objectValuedSetting ? 'PATCH' : 'PUT';
			if (method !== expected) {
				throw new Error(`405 Method Not Allowed: ${method} ${path} (Meilisearch requires ${expected} here)`);
			}
			return this.nextTask() as TResponse;
		}
		if (method === 'POST' && path.endsWith('/documents')) {
			return this.nextTask() as TResponse;
		}
		if (method === 'POST' && path.endsWith('/documents/delete-batch')) {
			return this.nextTask() as TResponse;
		}
		if (method === 'POST' && path.endsWith('/search')) {
			return {
				hits: [{id: 'message-1'}],
				estimatedTotalHits: 1,
			} as TResponse;
		}
		throw new Error(`Unhandled fake Meilisearch request: ${method} ${path}`);
	}

	async waitForTask(taskUid: number): Promise<void> {
		this.waitedTaskUids.push(taskUid);
	}

	clear(): void {
		this.requests.length = 0;
		this.waitedTaskUids.length = 0;
	}

	private nextTask(): MeilisearchTask {
		return {
			taskUid: this.nextTaskUid++,
			status: 'enqueued',
		};
	}
}

describe('MeilisearchMessageAdapter', () => {
	it('creates missing indexes and applies settings before becoming available', async () => {
		const client = new FakeMeilisearchClient();
		const adapter = new MeilisearchMessageAdapter({client});

		await adapter.initialize();

		expect(adapter.isAvailable()).toBe(true);
		expect(client.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
			'GET /indexes/messages',
			'POST /indexes',
			'PUT /indexes/messages/settings/searchable-attributes',
			'PUT /indexes/messages/settings/filterable-attributes',
			'PUT /indexes/messages/settings/sortable-attributes',
			'PUT /indexes/messages/settings/ranking-rules',
			// PATCH, not PUT: Meilisearch answers PUT on object-valued settings with 405.
			'PATCH /indexes/messages/settings/pagination',
		]);
		expect(client.waitedTaskUids).toEqual([1, 2, 3, 4, 5, 6]);
		// The messages index defines its own result window, which wins over the 10k default.
		expect(client.requests.find((request) => request.path.endsWith('/settings/pagination'))?.body).toEqual({
			maxTotalHits: 100_000,
		});
	});

	it('builds Meilisearch search requests from message filters', async () => {
		const client = new FakeMeilisearchClient();
		client.indexExists = true;
		const adapter = new MeilisearchMessageAdapter({client});
		await adapter.initialize();
		client.clear();

		const result = await adapter.search(
			'hello',
			{
				guildId: 'guild-1',
				channelIds: ['channel-"quoted"', 'channel-2'],
				mentions: ['user-1'],
				sortBy: 'timestamp',
				sortOrder: 'asc',
			},
			{limit: 10, offset: 20},
		);

		expect(result).toEqual({hits: [{id: 'message-1'}], total: 1});
		expect(client.requests).toHaveLength(1);
		expect(client.requests[0]).toEqual({
			method: 'POST',
			path: '/indexes/messages/search',
			body: {
				q: 'hello',
				filter:
					'(guildId = "guild-1") AND ((channelId = "channel-\\"quoted\\"" OR channelId = "channel-2")) AND (mentionedUserIds = "user-1")',
				limit: 10,
				offset: 20,
				sort: ['createdAt:asc', 'id:asc'],
				attributesToSearchOn: ['content', 'embedContent'],
				showRankingScore: false,
			},
		});
	});

	it('waits for queued bulk index tasks when refreshed', async () => {
		const client = new FakeMeilisearchClient();
		client.indexExists = true;
		const adapter = new MeilisearchMessageAdapter({client});
		await adapter.initialize();
		client.clear();

		await adapter.bulkIndexDocuments([{id: 'message-1'} as SearchableMessage]);

		expect(client.waitedTaskUids).toEqual([]);
		await adapter.refreshIndex();
		expect(client.waitedTaskUids).toEqual([6]);
	});

	it('does not retain task state for per-document writes', async () => {
		const client = new FakeMeilisearchClient();
		client.indexExists = true;
		const adapter = new MeilisearchMessageAdapter({client});
		await adapter.initialize();
		client.clear();

		for (let index = 0; index < 500; index++) {
			await adapter.indexDocument({id: `message-${index}`} as SearchableMessage);
			await adapter.updateDocument({id: `message-${index}`} as SearchableMessage);
			await adapter.deleteDocument(`message-${index}`);
		}

		expect(client.requests).toHaveLength(1500);
		await adapter.refreshIndex();
		expect(client.waitedTaskUids).toEqual([]);
	});

	it('bounds the tracked bulk task set', async () => {
		const client = new FakeMeilisearchClient();
		client.indexExists = true;
		const adapter = new MeilisearchMessageAdapter({client});
		await adapter.initialize();
		client.clear();

		const batches = MEILISEARCH_MAX_TRACKED_BULK_TASKS + 100;
		for (let index = 0; index < batches; index++) {
			await adapter.bulkIndexDocuments([{id: `message-${index}`} as SearchableMessage]);
		}

		await adapter.refreshIndex();
		expect(client.waitedTaskUids).toHaveLength(MEILISEARCH_MAX_TRACKED_BULK_TASKS);
		expect(client.waitedTaskUids[0]).toBe(105);
	});

	it('drops tracked bulk tasks on shutdown', async () => {
		const client = new FakeMeilisearchClient();
		client.indexExists = true;
		const adapter = new MeilisearchMessageAdapter({client});
		await adapter.initialize();
		client.clear();

		await adapter.bulkIndexDocuments([{id: 'message-1'} as SearchableMessage]);
		await adapter.shutdown();
		await adapter.refreshIndex();

		expect(client.waitedTaskUids).toEqual([]);
	});
});
