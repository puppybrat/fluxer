// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/cast/commands/CastCommands', () => ({
	getOwnerAccounts: vi.fn(),
	getGuildCast: vi.fn(),
}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: 'user-1'}}));

import * as CastCommands from '@app/features/cast/commands/CastCommands';
import ComposerInCharacter from '@app/features/cast/state/ComposerInCharacter';

const GUILD = 'g1';

describe('ComposerInCharacter — owner-accounts cached per guild', () => {
	beforeEach(() => {
		ComposerInCharacter.reset();
		vi.mocked(CastCommands.getOwnerAccounts).mockReset();
		vi.mocked(CastCommands.getGuildCast).mockReset();
		vi.mocked(CastCommands.getOwnerAccounts).mockResolvedValue([{fluxer_user_id: 'user-1', owner_index: 1}] as never);
		vi.mocked(CastCommands.getGuildCast).mockImplementation(
			async (_g, ch) =>
				({
					characters: [
						{
							id: '1',
							owner: 1,
							name: 'A',
							nickname: null,
							alias: null,
							ship: null,
							pfp_url: null,
							reference_image_url: null,
						},
					],
					primaries: [],
					categories: [],
					overrides: [],
					// Distinct primary per channel so we can tell the per-channel fetch actually happened.
					resolved_cast: [
						{character_id: '1', is_primary: ch === 'cA', nickname: null, pfp_url: null, reference_image_url: null},
					],
				}) as never,
		);
	});

	it('fetches owner-accounts once per guild but resolved_cast once per channel', async () => {
		await ComposerInCharacter.ensureEligibility(GUILD, 'cA');
		await ComposerInCharacter.ensureEligibility(GUILD, 'cB');
		await ComposerInCharacter.ensureEligibility(GUILD, 'cC');

		expect(vi.mocked(CastCommands.getOwnerAccounts)).toHaveBeenCalledTimes(1); // guild-invariant, cached
		expect(vi.mocked(CastCommands.getGuildCast)).toHaveBeenCalledTimes(3); // per channel
		// Correct per-channel result: only cA has char 1 primary.
		expect(ComposerInCharacter.hasUsablePrimary('cA')).toBe(true);
		expect(ComposerInCharacter.hasUsablePrimary('cB')).toBe(false);
	});

	it('dedupes owner-accounts across concurrent first mounts', async () => {
		await Promise.all([
			ComposerInCharacter.ensureEligibility(GUILD, 'cA'),
			ComposerInCharacter.ensureEligibility(GUILD, 'cB'),
		]);
		expect(vi.mocked(CastCommands.getOwnerAccounts)).toHaveBeenCalledTimes(1);
	});

	it('refresh re-resolves channels without refetching owner-accounts', async () => {
		await ComposerInCharacter.ensureEligibility(GUILD, 'cA');
		expect(vi.mocked(CastCommands.getOwnerAccounts)).toHaveBeenCalledTimes(1);
		vi.mocked(CastCommands.getGuildCast).mockClear();

		await ComposerInCharacter.refresh(GUILD);

		expect(vi.mocked(CastCommands.getOwnerAccounts)).toHaveBeenCalledTimes(1); // still only once
		expect(vi.mocked(CastCommands.getGuildCast)).toHaveBeenCalledTimes(1); // re-fetched the one cached channel
	});

	it('caches per guild, so a second guild resolves its own index', async () => {
		await ComposerInCharacter.ensureEligibility(GUILD, 'cA');
		await ComposerInCharacter.ensureEligibility('g2', 'cZ');

		expect(vi.mocked(CastCommands.getOwnerAccounts)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(CastCommands.getOwnerAccounts).mock.calls.map(([g]) => g)).toEqual([GUILD, 'g2']);
	});

	it('does not serialise the two round trips on a guild first mount', async () => {
		// The owner-accounts call is the slow, variable-latency one. Holding it open must not delay the
		// per-channel cast fetch — otherwise the per-guild cache would have traded cold-mount latency
		// for warm-mount latency instead of just removing the repeat.
		let releaseOwnerAccounts!: () => void;
		vi.mocked(CastCommands.getOwnerAccounts).mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseOwnerAccounts = () => resolve([{fluxer_user_id: 'user-1', owner_index: 1}] as never);
				}),
		);

		const pending = ComposerInCharacter.ensureEligibility(GUILD, 'cA');
		await Promise.resolve();
		// Still blocked on owner-accounts, yet the cast fetch has already gone out.
		expect(vi.mocked(CastCommands.getGuildCast)).toHaveBeenCalledTimes(1);

		releaseOwnerAccounts();
		await pending;
		expect(ComposerInCharacter.hasUsablePrimary('cA')).toBe(true);
	});

	it('does not cache a failed owner-accounts lookup', async () => {
		vi.mocked(CastCommands.getOwnerAccounts).mockRejectedValueOnce(new Error('403'));

		await ComposerInCharacter.ensureEligibility(GUILD, 'cA');
		expect(ComposerInCharacter.hasUsablePrimary('cA')).toBe(false); // unresolved, toggle stays hidden

		// A later mount retries rather than being stuck on the cached rejection.
		await ComposerInCharacter.ensureEligibility(GUILD, 'cA');
		expect(vi.mocked(CastCommands.getOwnerAccounts)).toHaveBeenCalledTimes(2);
		expect(ComposerInCharacter.hasUsablePrimary('cA')).toBe(true);
	});
});
