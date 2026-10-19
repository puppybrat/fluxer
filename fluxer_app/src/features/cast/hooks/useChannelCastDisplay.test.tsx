// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/cast/state/GuildCastDisplay', () => ({
	default: {ensureChannelLoaded: vi.fn(async () => {})},
}));

import {useChannelCastDisplay} from '@app/features/cast/hooks/useChannelCastDisplay';
import GuildCastDisplay from '@app/features/cast/state/GuildCastDisplay';

const GUILD = '1517785346346057000';
const PARENT = '1517785346346057001';
const THREAD = '1517785346346057002';
const OTHER_THREAD = '1517785346346057003';

/** Stands in for ThreadChat, which calls the hook with the thread it renders. */
const ThreadHost: React.FC<{guildId: string | undefined; threadId: string}> = ({guildId, threadId}) => {
	useChannelCastDisplay(guildId, threadId);
	return null;
};

let container: HTMLDivElement;
let root: Root;

function render(guildId: string | undefined, threadId: string): void {
	act(() => {
		root.render(<ThreadHost guildId={guildId} threadId={threadId} />);
	});
}

beforeEach(() => {
	vi.mocked(GuildCastDisplay.ensureChannelLoaded).mockClear();
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => {
		root.unmount();
	});
	container.remove();
});

describe('useChannelCastDisplay — thread side panel (step 5a, D4)', () => {
	it("loads the thread's own resolved cast, not only the parent's", () => {
		render(GUILD, THREAD);
		expect(GuildCastDisplay.ensureChannelLoaded).toHaveBeenCalledTimes(1);
		expect(GuildCastDisplay.ensureChannelLoaded).toHaveBeenCalledWith(GUILD, THREAD);
		expect(GuildCastDisplay.ensureChannelLoaded).not.toHaveBeenCalledWith(GUILD, PARENT);
	});

	it('loads again when the panel switches to another thread', () => {
		render(GUILD, THREAD);
		render(GUILD, OTHER_THREAD);
		expect(vi.mocked(GuildCastDisplay.ensureChannelLoaded).mock.calls).toEqual([
			[GUILD, THREAD],
			[GUILD, OTHER_THREAD],
		]);
	});

	it('does nothing without a guild', () => {
		render(undefined, THREAD);
		expect(GuildCastDisplay.ensureChannelLoaded).not.toHaveBeenCalled();
	});
});
