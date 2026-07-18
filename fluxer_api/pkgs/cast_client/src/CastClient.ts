// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHttpClient} from '@pkgs/http_client/src/HttpClient';
import type {HttpClient} from '@pkgs/http_client/src/HttpClientTypes';
import {createPublicInternetRequestUrlPolicy} from '@pkgs/http_client/src/PublicInternetRequestUrlPolicy';
import {z} from 'zod';

const CAST_SECRET_HEADER = 'X-Fluxer-Cast-Secret';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Wire shape returned by the personal site's fluxer-cast.php endpoint.
 *
 * This is the *external* contract and is deliberately permissive: unknown columns are
 * stripped rather than rejected, so adding a column on the PHP side cannot break Fluxer.
 * Only the fields Fluxer actually consumes are declared. The trimmed shape Fluxer exposes
 * to its own clients lives in @fluxer/schema/src/domains/cast/CastSchemas.
 */
const CastCharacterPayload = z.object({
	id: z.union([z.string(), z.number()]),
	name: z.string().nullish(),
	alias: z.string().nullish(),
	ship: z.string().nullish(),
});

const CastPrimaryPayload = z.object({
	character_id: z.union([z.string(), z.number()]),
	server_id: z.union([z.string(), z.number()]).nullish(),
	channel_id: z.union([z.string(), z.number()]).nullish(),
	is_primary: z.union([z.boolean(), z.number(), z.string()]).nullish(),
});

const CastCategoryPayload = z.object({
	id: z.union([z.string(), z.number()]).nullish(),
	pair_slug: z.string().nullish(),
	au_slug: z.string().nullish(),
	server_id: z.union([z.string(), z.number()]).nullish(),
	category_id: z.union([z.string(), z.number()]).nullish(),
});

const CastResponsePayload = z.object({
	characters: z.array(CastCharacterPayload).default([]),
	primaries: z.array(CastPrimaryPayload).default([]),
	categories: z.array(CastCategoryPayload).default([]),
});

export type CastPayload = z.infer<typeof CastResponsePayload>;

/**
 * Write-side wire shapes. Deliberately permissive for the same reason as the read payload:
 * the personal site owns this contract. The endpoint reports failure as `{"error": "..."}`
 * with a 4xx status, so a 2xx body is treated as success regardless of which confirmation
 * fields it carries, and the override is read from either a nested object or flat fields.
 */
const CastOverridePayload = z.object({
	character_id: z.union([z.string(), z.number()]).nullish(),
	nickname: z.string().nullish(),
	pfp_url: z.string().nullish(),
	is_primary: z.union([z.boolean(), z.number()]).nullish(),
});

const CastWritePayload = z.object({
	error: z.string().nullish(),
	// The endpoint returns the affected row under `row` for every write action; `override` and
	// the flat fields are kept as fallbacks so an older or changed deployment still parses.
	// Omitting `row` here made zod strip it, which is why updateOverride reported a null
	// override while the value persisted correctly upstream.
	row: CastOverridePayload.nullish(),
	override: CastOverridePayload.nullish(),
	nickname: z.string().nullish(),
	pfp_url: z.string().nullish(),
});

export interface CastOverride {
	nickname: string | null;
	pfpUrl: string | null;
}

export type CastWriteResult = {ok: true; override: CastOverride | null} | {ok: false; failure: CastFetchFailure};

export interface CastOverrideUpdate {
	nickname?: string | null;
	pfpUrl?: string | null;
}

/**
 * Why a discriminated union rather than a boolean:
 * the caller needs to distinguish "the personal site is down" (retryable, log-worthy)
 * from "this deployment has no Cast configured" (expected, silent) from "the endpoint
 * returned something we cannot parse" (a deploy skew bug worth alerting on). Collapsing
 * these to a single flag is the antipattern this client exists to avoid.
 */
export type CastFetchFailure =
	| {kind: 'not_configured'}
	| {kind: 'network'; detail: string}
	| {kind: 'http_status'; status: number; message?: string}
	| {kind: 'malformed_json'; detail: string}
	| {kind: 'invalid_shape'; detail: string};

export type CastFetchResult = {ok: true; data: CastPayload; cached: boolean} | {ok: false; failure: CastFetchFailure};

export interface CastClientConfig {
	apiUrl: string;
	apiSecret: string;
	timeoutMs?: number;
	cacheTtlMs?: number;
}

interface CacheEntry {
	data: CastPayload;
	expiresAt: number;
}

/**
 * Short-TTL in-memory cache, keyed by server_id.
 *
 * ASSUMPTION: this is burst protection, not correctness-critical caching. A cast edit on
 * the personal site may take up to the TTL to appear in Fluxer, and that is acceptable.
 * The cache is per-process and deliberately unbounded-in-time only by TTL: the key space
 * is the set of guilds with Cast configured, which is small. Do not extend this into a
 * read-through cache for anything where staleness matters.
 */
export class CastClient {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly http: HttpClient;
	private readonly timeoutMs: number;
	private readonly cacheTtlMs: number;

	constructor(private readonly config: CastClientConfig) {
		this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
		this.http = createHttpClient({
			userAgent: 'fluxer-api',
			defaultTimeoutMs: this.timeoutMs,
			requestUrlPolicy: createPublicInternetRequestUrlPolicy(),
		});
	}

	isConfigured(): boolean {
		return this.config.apiUrl.length > 0 && this.config.apiSecret.length > 0;
	}

	clearCache(): void {
		this.cache.clear();
	}

	/**
	 * Fetches Cast data for a server. Never throws: every failure path is returned as a
	 * typed failure so a personal-site outage can never take down an API request.
	 *
	 * An unmapped server is NOT a failure — the endpoint returns 200 with empty arrays and
	 * that is passed through as a normal success result.
	 */
	async fetchForServer(serverId: string): Promise<CastFetchResult> {
		if (!this.isConfigured()) {
			return {ok: false, failure: {kind: 'not_configured'}};
		}

		const cached = this.cache.get(serverId);
		if (cached && cached.expiresAt > Date.now()) {
			return {ok: true, data: cached.data, cached: true};
		}

		let status: number;
		let body: string;
		try {
			const url = new URL(this.config.apiUrl);
			url.searchParams.set('server_id', serverId);
			const response = await this.http.sendRequest({
				url: url.toString(),
				method: 'GET',
				headers: {[CAST_SECRET_HEADER]: this.config.apiSecret, Accept: 'application/json'},
				timeout: this.timeoutMs,
				serviceName: 'cast',
			});
			status = response.status;
			body = await this.readBody(response.stream);
		} catch (error) {
			return {ok: false, failure: {kind: 'network', detail: errorDetail(error)}};
		}

		if (status < 200 || status >= 300) {
			return {ok: false, failure: {kind: 'http_status', status}};
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch (error) {
			return {ok: false, failure: {kind: 'malformed_json', detail: errorDetail(error)}};
		}

		const result = CastResponsePayload.safeParse(parsed);
		if (!result.success) {
			return {ok: false, failure: {kind: 'invalid_shape', detail: result.error.issues[0]?.message ?? 'unknown'}};
		}

		this.cache.set(serverId, {data: result.data, expiresAt: Date.now() + this.cacheTtlMs});
		return {ok: true, data: result.data, cached: false};
	}

	/**
	 * Adds a character to a guild's cast. Idempotency is the personal site's business, not
	 * this client's — a repeat add is whatever the endpoint decides it is.
	 */
	async addToCast(serverId: string, characterId: number): Promise<CastWriteResult> {
		return this.write(serverId, {action: 'add_to_cast', server_id: serverId, character_id: characterId});
	}

	async removeFromCast(serverId: string, characterId: number): Promise<CastWriteResult> {
		return this.write(serverId, {action: 'remove_from_cast', server_id: serverId, character_id: characterId});
	}

	/**
	 * Updates the per-guild display override. Fields left undefined are omitted from the
	 * request entirely, so "not supplied" and "explicitly cleared to null" stay distinct all
	 * the way to the personal site rather than collapsing into one meaning here.
	 */
	async updateOverride(serverId: string, characterId: number, update: CastOverrideUpdate): Promise<CastWriteResult> {
		const body: Record<string, unknown> = {
			action: 'update_override',
			server_id: serverId,
			character_id: characterId,
		};
		if (update.nickname !== undefined) {
			body.nickname = update.nickname;
		}
		if (update.pfpUrl !== undefined) {
			body.pfp_url = update.pfpUrl;
		}
		return this.write(serverId, body);
	}

	/**
	 * Sets whether an existing cast member is a primary. Membership lives in character_primaries
	 * and is a precondition, not something this creates: the endpoint answers 409 when the
	 * character is not already in the cast, which surfaces here as an http_status failure.
	 */
	async setPrimary(serverId: string, characterId: number, isPrimary: boolean): Promise<CastWriteResult> {
		return this.write(serverId, {
			action: 'set_primary',
			server_id: serverId,
			character_id: characterId,
			is_primary: isPrimary,
		});
	}

	/**
	 * Drops this server's cached read so the next fetchForServer() goes to the origin.
	 * Without this a caller would keep seeing pre-write data for up to the TTL, which reads
	 * as "my edit did not save".
	 */
	invalidate(serverId: string): void {
		this.cache.delete(serverId);
	}

	private async write(serverId: string, body: Record<string, unknown>): Promise<CastWriteResult> {
		if (!this.isConfigured()) {
			return {ok: false, failure: {kind: 'not_configured'}};
		}

		let status: number;
		let responseBody: string;
		try {
			const response = await this.http.sendRequest({
				url: this.config.apiUrl,
				method: 'POST',
				headers: {[CAST_SECRET_HEADER]: this.config.apiSecret, Accept: 'application/json'},
				body,
				timeout: this.timeoutMs,
				serviceName: 'cast',
			});
			status = response.status;
			responseBody = await this.readBody(response.stream);
		} catch (error) {
			return {ok: false, failure: {kind: 'network', detail: errorDetail(error)}};
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(responseBody);
		} catch (error) {
			// A non-2xx with an unparseable body is still primarily a status failure: report it
			// as such rather than as malformed JSON, which would misdirect the reader.
			if (status < 200 || status >= 300) {
				return {ok: false, failure: {kind: 'http_status', status}};
			}
			return {ok: false, failure: {kind: 'malformed_json', detail: errorDetail(error)}};
		}

		const result = CastWritePayload.safeParse(parsed);
		if (!result.success) {
			return {ok: false, failure: {kind: 'invalid_shape', detail: result.error.issues[0]?.message ?? 'unknown'}};
		}

		if (status < 200 || status >= 300) {
			return {ok: false, failure: {kind: 'http_status', status, message: result.data.error ?? undefined}};
		}

		// Only a confirmed write invalidates: dropping the entry on failure would turn every
		// rejected request into a cache stampede against the personal site.
		this.invalidate(serverId);

		const override = result.data.override ?? result.data.row ?? result.data;
		const hasOverride = override.nickname != null || override.pfp_url != null;
		return {
			ok: true,
			override: hasOverride ? {nickname: override.nickname ?? null, pfpUrl: override.pfp_url ?? null} : null,
		};
	}

	private async readBody(stream: ReadableStream<Uint8Array> | null): Promise<string> {
		if (!stream) {
			return '';
		}
		const reader = stream.getReader();
		const chunks: Array<Uint8Array> = [];
		let total = 0;
		try {
			while (true) {
				const {done, value} = await reader.read();
				if (done) {
					break;
				}
				if (!value) {
					continue;
				}
				total += value.byteLength;
				if (total > MAX_RESPONSE_BYTES) {
					await reader.cancel().catch(() => {});
					throw new Error(`cast response exceeded ${MAX_RESPONSE_BYTES} bytes`);
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const merged = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return new TextDecoder().decode(merged);
	}
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

let defaultClient: CastClient | null = null;

export function initCastClient(config: CastClientConfig): CastClient {
	defaultClient = new CastClient(config);
	return defaultClient;
}

export function getCastClient(): CastClient {
	if (!defaultClient) {
		throw new Error('Cast client accessed before initCastClient()');
	}
	return defaultClient;
}

export function shutdownCastClient(): void {
	defaultClient?.clearCache();
	defaultClient = null;
}
