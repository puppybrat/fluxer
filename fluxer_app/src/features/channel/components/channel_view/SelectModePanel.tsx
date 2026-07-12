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
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';

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

interface SelectModePanelProps {
    guild?: Guild | null;
    channel: Channel;
}

export const SelectModePanel = observer(function SelectModePanel({guild, channel}: SelectModePanelProps) {
    const {i18n} = useLingui();
    const [destGuildId, setDestGuildId] = useState<string | typeof DMS_DEST_VALUE | null>(
        guild ? guild.id : DMS_DEST_VALUE,
    );

    useEffect(() => {
        setDestGuildId(guild ? guild.id : DMS_DEST_VALUE);
    }, [guild]);

    const guilds = Guilds.getGuilds();
    const destChannels =
        destGuildId != null && destGuildId !== DMS_DEST_VALUE
            ? Channels.getGuildChannels(destGuildId).filter(
                  (c) => c.type === ChannelTypes.GUILD_TEXT && c.id !== channel.id,
              )
            : destGuildId === DMS_DEST_VALUE
              ? Channels.dmChannels.filter((c) => c.id !== channel.id)
              : [];

    const handleDestGuildChange = (value: string) => {
        setDestGuildId(value === DMS_DEST_VALUE ? DMS_DEST_VALUE : value || null);
        SelectMode.setDestChannelId(null);
    };

    // LOCAL-ONLY: dropdown options for the styled Combobox selects below — exclude from upstream sync.
    const destGuildOptions: Array<ComboboxOption> = [
        {value: DMS_DEST_VALUE, label: 'Direct Messages'},
        ...guilds.map((g) => ({value: g.id, label: g.name || ''})),
    ];
    const destChannelOptions: Array<ComboboxOption> = destChannels.map((c) => ({
        value: c.id,
        label: destGuildId === DMS_DEST_VALUE ? ChannelUtils.getDMDisplayName(c) : `#${c.name}`,
    }));

    // LOCAL-ONLY: message previews for the anchor/head sections — exclude from upstream sync.
    const anchorPreview = getMessagePreview(SelectMode.channelId, SelectMode.anchorId);
    const headPreview = getMessagePreview(SelectMode.channelId, SelectMode.headId);
    const canReset = SelectMode.anchorId != null || SelectMode.headId != null;

    return (
        <OutlineFrame hideTopBorder>
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
                    <div className={styles.header} data-flx="channel.channel-view.select-mode-panel.header">
                        <span className={styles.title} data-flx="channel.channel-view.select-mode-panel.title">
                            Relocate Messages
                        </span>
                    </div>

                    {/* LOCAL-ONLY: enable/disable selection toggle — exclude from upstream sync. */}
                    <Switch
                        label="Message selection"
                        description="Tap messages to set start and end points"
                        value={SelectMode.isActive}
                        onChange={() => SelectMode.toggleSelectionMode()}
                        data-flx="channel.channel-view.select-mode-panel.enable-selection-switch"
                    />

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
                        label="Destination server"
                        value={destGuildId ?? ''}
                        options={destGuildOptions}
                        onChange={handleDestGuildChange}
                        data-flx="channel.channel-view.select-mode-panel.dest-server-select"
                    />

                    <Combobox
                        id="select-mode-dest"
                        label="Destination channel"
                        value={SelectMode.destChannelId ?? ''}
                        options={destChannelOptions}
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
