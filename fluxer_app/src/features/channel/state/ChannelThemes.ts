// SPDX-License-Identifier: AGPL-3.0-or-later

import {action, makeAutoObservable} from 'mobx';

class ChannelThemes {
	private readonly themeCssByChannelId = new Map<string, string>();

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	getThemeCss(channelId: string): string | null {
		return this.themeCssByChannelId.get(channelId) ?? null;
	}

	@action
	setThemeCss(channelId: string, css: string | null): void {
		if (css == null) {
			this.themeCssByChannelId.delete(channelId);
		} else {
			this.themeCssByChannelId.set(channelId, css);
		}
	}
}

export default new ChannelThemes();
