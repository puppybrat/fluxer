// SPDX-License-Identifier: AGPL-3.0-or-later

import {PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {useMemo} from 'react';

const LOADING_DESCRIPTOR = msg({
	message: 'Loading {productName}.',
	comment: 'Neutral splash-screen loading fallback for non-English locales. Do not imply that rotating quotes exist.',
});

export interface SplashQuote {
	readonly text: string;
	readonly source: string;
}

const isEnglishLocale = (locale: string | null | undefined): boolean => locale?.toLowerCase().startsWith('en') ?? false;

export function useSplashQuotes(): ReadonlyArray<SplashQuote> {
	const {i18n} = useLingui();
	return useMemo(() => {
		if (!isEnglishLocale(i18n.locale)) {
			return [
				{
					text: i18n._(LOADING_DESCRIPTOR, {productName: PRODUCT_NAME}),
					source: PRODUCT_NAME,
				},
			];
		}
		const quotes: Array<SplashQuote> = [
			{text: "I'm a non-obnoxious loading quote.", source: 'Milo'},
			{text: "I'm sparing you from all those other quotes.", source: 'Milo'},
			{text: '*zap*', source: 'Harlow'},
		];
		return quotes;
	}, [i18n.locale, i18n]);
}
