/*
 * LOCAL-ONLY: This file is a local-only addition to fluxer_app and will never exist upstream.
 * It renders the side panel for the message relocation feature. The panel reflects SelectMode
 * store state; message click handling (setAnchor / setHead) is wired separately in message components.
 *
 * Known limitations (inherited from the API and store):
 *  - Meilisearch search index is NOT updated after a move.
 *  - No gateway events are dispatched; only local in-memory state is updated.
 *
 * Lines to check on upstream merge: none — exclude this file entirely from any upstream sync.
 */

// SPDX-License-Identifier: AGPL-3.0-or-later

import {OutlineFrame} from '@app/features/app/components/layout/OutlineFrame';
// LOCAL-ONLY: the destination channel dropdown reuses the splash screen's quote attribution
// style verbatim for the parent category suffix — see destChannelOptions / renderOption below.
// Exclude from upstream sync.
import splashStyles from '@app/features/app/components/layout/SplashScreen.module.css';
import styles from '@app/features/channel/components/channel_view/SelectModePanel.module.css';
import {formatRecentOrFallback} from '@app/features/channel/components/guild_members_page/GuildMembersPageFormatting';
import type {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import SelectMode from '@app/features/channel/state/SelectMode';
import * as ChannelUtils from '@app/features/channel/utils/ChannelUtils';
import type {Guild} from '@app/features/guild/models/Guild';
import Guilds from '@app/features/guild/state/Guilds';
import MessagingMessages from '@app/features/messaging/state/MessagingMessages';
import {Button} from '@app/features/ui/button/Button';
import {Combobox, type ComboboxOption} from '@app/features/ui/components/form/FormCombobox';
import {Switch} from '@app/features/ui/components/form/FormSwitch';
import {Scroller} from '@app/features/ui/components/Scroller';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';

const DMS_DEST_VALUE = 'dms';
const PREVIEW_MAX_LENGTH = 80;

// LOCAL-ONLY: message preview helper for the anchor/head sections below — exclude from upstream sync.
function getMessagePreview(channelId: string | null, messageId: string | null): string | null {
    if (channelId == null || messageId == null) {
        return null;
    }
    const message = MessagingMessages.getMessages(channelId).get(messageId);
    if (!message || !message.content) {
        return null;
    }
    return message.content.length > PREVIEW_MAX_LENGTH
        ? `${message.content.slice(0, PREVIEW_MAX_LENGTH)}...`
        : message.content;
}

/*
 * LOCAL-ONLY: destination channel options carry the channel's own label and its immediate parent
 * category name as separate fields so the Combobox's renderOption can style the two parts
 * differently. `label` stays a plain string: FormCombobox types ComboboxOption.label as string and
 * uses it both for filtering (option.label.toLowerCase()) and for the text shown in the closed
 * input, so it holds the full "#channel - Category" text. Exclude from upstream sync.
 */
interface DestChannelOption extends ComboboxOption {
    channelLabel: string;
    categoryName: string | null;
}

// LOCAL-ONLY: immediate parent category name of a guild channel, or null when it sits outside any
// category (and always for DMs, which have no categories) — exclude from upstream sync.
function getParentCategoryName(channel: Channel): string | null {
    if (channel.parentId == null) {
        return null;
    }
    const parent = Channels.getChannel(channel.parentId);
    if (!parent || parent.type !== ChannelTypes.GUILD_CATEGORY) {
        return null;
    }
    return parent.name ?? null;
}

interface SelectModePanelProps {
    guild?: Guild | null;
    channel: Channel;
}

export const SelectModePanel = observer(function SelectModePanel({guild, channel}: SelectModePanelProps) {
    const {i18n} = useLingui();
    /*
     * LOCAL-ONLY: the destination server is read from SelectMode rather than held as component
     * state so it survives the mobile cycle of closing the panel to tap messages and reopening it
     * to submit — component state is lost on that unmount, the store is not. A null in the store
     * means "the user has not picked a server yet", so we fall back to this channel's own context.
     * SelectMode.activate() nulls it back out when selection moves to a different source channel,
     * which restores that fallback; there is deliberately no effect syncing it to the `guild` prop,
     * as that would overwrite the user's choice on every remount. Exclude from upstream sync.
     */
    const destGuildId: string | typeof DMS_DEST_VALUE | null =
        SelectMode.destGuildId ?? (guild ? guild.id : DMS_DEST_VALUE);

    const guilds = Guilds.getGuilds();
    const destChannels =
        destGuildId != null && destGuildId !== DMS_DEST_VALUE
            ? Channels.getGuildChannels(destGuildId).filter(
                  (c) => c.type === ChannelTypes.GUILD_TEXT && c.id !== channel.id,
              )
            : destGuildId === DMS_DEST_VALUE
              ? Channels.dmChannels.filter((c) => c.id !== channel.id)
              : [];

    // LOCAL-ONLY: setDestGuildId already drops the previously picked channel when the server
    // actually changes, so no separate setDestChannelId(null) is needed here.
    // Exclude from upstream sync.
    const handleDestGuildChange = (value: string) => {
        SelectMode.setDestGuildId(value === DMS_DEST_VALUE ? DMS_DEST_VALUE : value || null);
    };

    // LOCAL-ONLY: dropdown options for the styled Combobox selects below — exclude from upstream sync.
    const destGuildOptions: Array<ComboboxOption> = [
        {value: DMS_DEST_VALUE, label: 'Direct Messages'},
        ...guilds.map((g) => ({value: g.id, label: g.name || ''})),
    ];
    const destChannelOptions: Array<DestChannelOption> = destChannels.map((c) => {
        const channelLabel = destGuildId === DMS_DEST_VALUE ? ChannelUtils.getDMDisplayName(c) : `#${c.name}`;
        const categoryName = destGuildId === DMS_DEST_VALUE ? null : getParentCategoryName(c);
        return {
            value: c.id,
            label: categoryName != null ? `${channelLabel} - ${categoryName}` : channelLabel,
            channelLabel,
            categoryName,
        };
    });

    // LOCAL-ONLY: message previews for the anchor/head sections — exclude from upstream sync.
    const anchorPreview = getMessagePreview(SelectMode.channelId, SelectMode.anchorId);
    const headPreview = getMessagePreview(SelectMode.channelId, SelectMode.headId);
    const canReset = SelectMode.anchorId != null || SelectMode.headId != null;

    // LOCAL-ONLY: mirrors ChannelMembers' frameSides exactly. In a guild on desktop the Members
    // panel drops the frame's own left border and lets ChannelViewScaffold's .memberListDivider
    // (right: var(--member-list-width, 16.5rem), 0.0625rem, z-index 5) draw that line instead;
    // GuildChannelView now renders that divider for this panel too. The mobile overlay has no
    // scaffold divider, so it keeps the frame border. Exclude from upstream sync.
    const frameSides = guild && !MobileLayout.enabled ? {left: false} : undefined;

    return (
        <OutlineFrame hideTopBorder sides={frameSides}>
            {/*
             * LOCAL-ONLY: structure mirrors MemberListContainer.tsx — an <aside> for
             * layout/background (overflow: hidden, no padding) wrapping the same
             * Scroller component the Members panel uses, which carries the actual
             * padding via its className — exclude from upstream sync.
             */}
            <aside className={styles.container} data-flx="channel.channel-view.select-mode-panel.container">
                <Scroller
                    className={styles.scrollerPadding}
                    contentClassName={styles.scrollerContent}
                    data-flx="channel.channel-view.select-mode-panel.scroller"
                >
                    {/*
                     * LOCAL-ONLY: enable/disable selection toggle — mobile only; on desktop
                     * SelectMode.isActive is driven by the header button — exclude from upstream sync.
                     */}
                    {MobileLayout.enabled && (
                        <Switch
                            // LOCAL-ONLY: Switch renders `label` inside its own <span>, so the shared
                            // section-header style is carried by this span — same approach as the two
                            // Combobox headers below. Exclude from upstream sync.
                            label={
                                <span
                                    className={styles.fieldLabel}
                                    data-flx="channel.channel-view.select-mode-panel.enable-selection-label"
                                >
                                    Message selection
                                </span>
                            }
                            description="Tap messages to set start and end points"
                            value={SelectMode.isActive}
                            onChange={() => SelectMode.toggleSelectionMode()}
                            data-flx="channel.channel-view.select-mode-panel.enable-selection-switch"
                        />
                    )}

                    <div className={styles.section} data-flx="channel.channel-view.select-mode-panel.anchor-section">
                        <span
                            className={styles.fieldLabel}
                            data-flx="channel.channel-view.select-mode-panel.anchor-label"
                        >
                            Start message
                        </span>
                        {SelectMode.anchorId != null ? (
                            <>
                                <span
                                    className={styles.idValue}
                                    data-flx="channel.channel-view.select-mode-panel.anchor-value"
                                >
                                    {SelectMode.anchorId}
                                </span>
                                {anchorPreview != null && (
                                    <span
                                        className={styles.preview}
                                        data-flx="channel.channel-view.select-mode-panel.anchor-preview"
                                    >
                                        {anchorPreview}
                                    </span>
                                )}
                            </>
                        ) : (
                            <span
                                className={styles.placeholder}
                                data-flx="channel.channel-view.select-mode-panel.anchor-placeholder"
                            >
                                Click a message to set start
                            </span>
                        )}
                    </div>

                    <div className={styles.section} data-flx="channel.channel-view.select-mode-panel.head-section">
                        <span
                            className={styles.fieldLabel}
                            data-flx="channel.channel-view.select-mode-panel.head-label"
                        >
                            End message
                        </span>
                        {SelectMode.headId != null ? (
                            <>
                                <span
                                    className={styles.idValue}
                                    data-flx="channel.channel-view.select-mode-panel.head-value"
                                >
                                    {SelectMode.headId}
                                </span>
                                {headPreview != null && (
                                    <span
                                        className={styles.preview}
                                        data-flx="channel.channel-view.select-mode-panel.head-preview"
                                    >
                                        {headPreview}
                                    </span>
                                )}
                            </>
                        ) : (
                            <span
                                className={styles.placeholder}
                                data-flx="channel.channel-view.select-mode-panel.head-placeholder"
                            >
                                Click another message to set end
                            </span>
                        )}
                    </div>

                    <Button
                        type="button"
                        variant="secondary"
                        onClick={SelectMode.reset}
                        disabled={!canReset}
                        small
                        data-flx="channel.channel-view.select-mode-panel.reset-button"
                    >
                        Reset selection
                    </Button>

                    <Combobox
                        id="select-mode-dest-server"
                        // LOCAL-ONLY: Combobox renders `label` inside its own <label> element, so the
                        // .virtualGroupRow-matching style is carried by this span (every property of
                        // FormCombobox's .label is overridden by it) — exclude from upstream sync.
                        label={
                            <span
                                className={styles.fieldLabel}
                                data-flx="channel.channel-view.select-mode-panel.dest-server-label"
                            >
                                Destination server
                            </span>
                        }
                        value={destGuildId ?? ''}
                        options={destGuildOptions}
                        onChange={handleDestGuildChange}
                        data-flx="channel.channel-view.select-mode-panel.dest-server-select"
                    />

                    <Combobox
                        id="select-mode-dest"
                        // LOCAL-ONLY: see the dest-server Combobox above — exclude from upstream sync.
                        label={
                            <span
                                className={styles.fieldLabel}
                                data-flx="channel.channel-view.select-mode-panel.dest-channel-label"
                            >
                                Destination channel
                            </span>
                        }
                        value={SelectMode.destChannelId ?? ''}
                        options={destChannelOptions}
                        // LOCAL-ONLY: channel name stays primary; the immediate parent category is
                        // appended in the splash screen's quote attribution style (smaller, muted).
                        // Channels with no parent category render the name alone. The two parts are
                        // wrapped in a flex row so a long category truncates with an ellipsis
                        // instead of widening the option row — spans rather than divs, since the
                        // Combobox nests this inside its own <span className={styles.itemText}>.
                        // Exclude from upstream sync.
                        renderOption={(option) =>
                            option.categoryName != null ? (
                                <span
                                    className={styles.destOptionRow}
                                    data-flx="channel.channel-view.select-mode-panel.dest-option-row"
                                >
                                    <span
                                        className={styles.destOptionChannel}
                                        data-flx="channel.channel-view.select-mode-panel.dest-option-channel"
                                    >
                                        {option.channelLabel}
                                    </span>
                                    <span
                                        className={clsx(splashStyles.quoteSource, styles.destOptionCategory)}
                                        data-flx="channel.channel-view.select-mode-panel.dest-option-category"
                                    >
                                        {' - '}
                                        {option.categoryName}
                                    </span>
                                </span>
                            ) : (
                                option.channelLabel
                            )
                        }
                        onChange={(value) => SelectMode.setDestChannelId(value || null)}
                        placeholder="Pick a channel…"
                        data-flx="channel.channel-view.select-mode-panel.dest-select"
                    />

                    {SelectMode.result != null && (
                        <div className={styles.success} data-flx="channel.channel-view.select-mode-panel.success">
                            Moved {SelectMode.result.movedCount} message
                            {SelectMode.result.movedCount !== 1 ? 's' : ''}.
                        </div>
                    )}

                    {SelectMode.lastError != null && (
                        <div className={styles.error} data-flx="channel.channel-view.select-mode-panel.error">
                            Error: {SelectMode.lastError}
                        </div>
                    )}

                    <Button
                        type="button"
                        variant="primary"
                        onClick={() => void SelectMode.submit()}
                        disabled={!SelectMode.canSubmit}
                        submitting={SelectMode.submitting}
                        fitContainer
                        data-flx="channel.channel-view.select-mode-panel.relocate-button"
                    >
                        Relocate
                    </Button>

                    {/* LOCAL-ONLY: recent relocate audit log — exclude from upstream sync. */}
                    <div className={styles.logSection} data-flx="channel.channel-view.select-mode-panel.log-section">
                        <span
                            className={styles.fieldLabel}
                            data-flx="channel.channel-view.select-mode-panel.log-label"
                        >
                            Recent moves
                        </span>
                        {SelectMode.logLoading ? (
                            <span
                                className={styles.placeholder}
                                data-flx="channel.channel-view.select-mode-panel.log-loading"
                            >
                                Loading…
                            </span>
                        ) : SelectMode.recentLog.length === 0 ? (
                            <span
                                className={styles.placeholder}
                                data-flx="channel.channel-view.select-mode-panel.log-empty"
                            >
                                No recent moves
                            </span>
                        ) : (
                            <div className={styles.logList} data-flx="channel.channel-view.select-mode-panel.log-list">
                                {SelectMode.recentLog.slice(0, 5).map((entry) => (
                                    <div
                                        key={entry.logId}
                                        className={styles.logEntry}
                                        data-flx="channel.channel-view.select-mode-panel.log-entry"
                                    >
                                        <span
                                            className={styles.logRoute}
                                            data-flx="channel.channel-view.select-mode-panel.log-route"
                                        >
                                            {entry.sourceChannel.name ?? entry.sourceChannel.id} →{' '}
                                            {entry.destChannel.name ?? entry.destChannel.id}
                                        </span>
                                        <span
                                            className={styles.logMeta}
                                            data-flx="channel.channel-view.select-mode-panel.log-meta"
                                        >
                                            {entry.movedCount} message{entry.movedCount !== 1 ? 's' : ''} ·{' '}
                                            {entry.performedBy.displayName ?? entry.performedBy.id} ·{' '}
                                            {formatRecentOrFallback(new Date(entry.createdAt), i18n)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </Scroller>
            </aside>
        </OutlineFrame>
    );
});
