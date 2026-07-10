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
import type {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import SelectMode from '@app/features/channel/state/SelectMode';
import * as ChannelUtils from '@app/features/channel/utils/ChannelUtils';
import type {Guild} from '@app/features/guild/models/Guild';
import Guilds from '@app/features/guild/state/Guilds';
import MessagingMessages from '@app/features/messaging/state/MessagingMessages';
import {Button} from '@app/features/ui/button/Button';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {XIcon} from '@phosphor-icons/react';
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

    // LOCAL-ONLY: message previews for the anchor/head sections — exclude from upstream sync.
    const anchorPreview = getMessagePreview(SelectMode.channelId, SelectMode.anchorId);
    const headPreview = getMessagePreview(SelectMode.channelId, SelectMode.headId);
    const canReset = SelectMode.anchorId != null || SelectMode.headId != null;

    return (
        <OutlineFrame hideTopBorder sides={{left: false}}>
            <div className={styles.container} data-flx="channel.channel-view.select-mode-panel.container">
                <div className={styles.header} data-flx="channel.channel-view.select-mode-panel.header">
                    <span className={styles.title} data-flx="channel.channel-view.select-mode-panel.title">
                        Relocate Messages
                    </span>
                    <Button
                        type="button"
                        square
                        icon={<XIcon data-flx="channel.channel-view.select-mode-panel.close-icon" />}
                        aria-label="Close relocation panel"
                        variant="secondary"
                        small
                        onClick={SelectMode.deactivate}
                        data-flx="channel.channel-view.select-mode-panel.close-button"
                    />
                </div>

                <div className={styles.section} data-flx="channel.channel-view.select-mode-panel.anchor-section">
                    <span
                        className={styles.fieldLabel}
                        data-flx="channel.channel-view.select-mode-panel.anchor-label"
                    >
                        Anchor message
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
                        Head message
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

                <div
                    className={styles.section}
                    data-flx="channel.channel-view.select-mode-panel.dest-server-section"
                >
                    <label
                        className={styles.fieldLabel}
                        htmlFor="select-mode-dest-server"
                        data-flx="channel.channel-view.select-mode-panel.dest-server-label"
                    >
                        Destination server
                    </label>
                    <select
                        id="select-mode-dest-server"
                        className={styles.select}
                        value={destGuildId ?? ''}
                        onChange={(e) => handleDestGuildChange(e.target.value)}
                        data-flx="channel.channel-view.select-mode-panel.dest-server-select"
                    >
                        <option value={DMS_DEST_VALUE}>Direct Messages</option>
                        {guilds.map((g) => (
                            <option key={g.id} value={g.id}>
                                {g.name}
                            </option>
                        ))}
                    </select>
                </div>

                <div className={styles.section} data-flx="channel.channel-view.select-mode-panel.dest-section">
                    <label
                        className={styles.fieldLabel}
                        htmlFor="select-mode-dest"
                        data-flx="channel.channel-view.select-mode-panel.dest-label"
                    >
                        Destination channel
                    </label>
                    <select
                        id="select-mode-dest"
                        className={styles.select}
                        value={SelectMode.destChannelId ?? ''}
                        onChange={(e) => SelectMode.setDestChannelId(e.target.value || null)}
                        data-flx="channel.channel-view.select-mode-panel.dest-select"
                    >
                        <option value="">Pick a channel…</option>
                        {destChannels.map((c) => (
                            <option key={c.id} value={c.id}>
                                {destGuildId === DMS_DEST_VALUE ? ChannelUtils.getDMDisplayName(c) : `#${c.name}`}
                            </option>
                        ))}
                    </select>
                </div>

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
            </div>
        </OutlineFrame>
    );
});
