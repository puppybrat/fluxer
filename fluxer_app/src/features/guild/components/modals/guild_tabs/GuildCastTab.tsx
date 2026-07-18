// SPDX-License-Identifier: AGPL-3.0-or-later

import {StatusSlate} from '@app/features/app/components/dialogs/shared/StatusSlate';
import Cast from '@app/features/cast/state/Cast';
import styles from '@app/features/guild/components/modals/guild_tabs/GuildCastTab.module.css';
import {TRY_AGAIN_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Spinner} from '@app/features/ui/components/Spinner';
import {Trans, useLingui} from '@lingui/react/macro';
import {StarIcon, UsersThreeIcon, WarningCircleIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useCallback, useEffect} from 'react';

/**
 * The list renders flat: nothing in the schema links a character to an AU or category, so
 * there is no honest way to group them. Grouping can come back if that link is ever added.
 */
const GuildCastTab: React.FC<{guildId: string}> = observer(({guildId}) => {
	const {i18n} = useLingui();
	const loadCast = useCallback(() => {
		void Cast.load(guildId);
	}, [guildId]);

	useEffect(() => {
		loadCast();
		return () => {
			Cast.reset();
		};
	}, [loadCast]);

	const characters = Cast.characters;

	return (
		<div className={styles.container} data-flx="guild.guild-tabs.guild-cast-tab.container">
			<div className={styles.header} data-flx="guild.guild-tabs.guild-cast-tab.header">
				<h2 className={styles.title} data-flx="guild.guild-tabs.guild-cast-tab.title">
					<Trans>Cast</Trans>
				</h2>
				<p className={styles.subtitle} data-flx="guild.guild-tabs.guild-cast-tab.subtitle">
					<Trans>Characters available in this community, and which are currently primary.</Trans>
				</p>
			</div>

			{Cast.loading && (
				<div className={styles.spinnerContainer} data-flx="guild.guild-tabs.guild-cast-tab.spinner-container">
					<Spinner data-flx="guild.guild-tabs.guild-cast-tab.spinner" />
				</div>
			)}

			{!Cast.loading && Cast.error != null && (
				<StatusSlate
					Icon={WarningCircleIcon}
					title={<Trans>Failed to load cast</Trans>}
					description={<Trans>There was an error loading the cast for this community. Try again.</Trans>}
					actions={[
						{
							text: i18n._(TRY_AGAIN_DESCRIPTOR),
							onClick: loadCast,
							variant: 'primary',
						},
					]}
					fullHeight={true}
					data-flx="guild.guild-tabs.guild-cast-tab.status-slate"
				/>
			)}

			{!Cast.loading && Cast.error == null && characters.length === 0 && (
				<StatusSlate
					Icon={UsersThreeIcon}
					title={<Trans>No cast configured</Trans>}
					description={<Trans>This community doesn't have any cast characters mapped to it yet.</Trans>}
					fullHeight={true}
					data-flx="guild.guild-tabs.guild-cast-tab.status-slate--2"
				/>
			)}

			{!Cast.loading && Cast.error == null && characters.length > 0 && (
				<div className={styles.characterList} data-flx="guild.guild-tabs.guild-cast-tab.character-list">
					{characters.map((character) => (
						<div
							key={character.id}
							className={styles.characterItem}
							data-flx="guild.guild-tabs.guild-cast-tab.character-item"
						>
							<span className={styles.characterName} data-flx="guild.guild-tabs.guild-cast-tab.character-name">
								{character.name ?? character.id}
							</span>
							{character.alias != null && character.alias !== '' && (
								<span className={styles.characterAlias} data-flx="guild.guild-tabs.guild-cast-tab.character-alias">
									{character.alias}
								</span>
							)}
							{Cast.isPrimary(character.id) && (
								<span className={styles.primaryBadge} data-flx="guild.guild-tabs.guild-cast-tab.primary-badge">
									<StarIcon size={12} weight="fill" data-flx="guild.guild-tabs.guild-cast-tab.primary-icon" />
									<Trans>Primary</Trans>
								</span>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
});

export default GuildCastTab;
