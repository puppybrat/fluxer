// SPDX-License-Identifier: AGPL-3.0-or-later

module.exports = {
	// This fork is deliberately English-only, so en-US is the only catalog extract/compile process.
	// Keep this list in sync with `supportedLocales` in src/app/I18n.ts.
	locales: ['en-US'],
	sourceLocale: 'en-US',
	catalogs: [
		{
			path: 'src/features/i18n/locales/{locale}/messages',
			include: ['src'],
			exclude: ['**/node_modules/**', '**/*.d.ts'],
		},
	],
	format: 'po',
	compileNamespace: 'es',
};
