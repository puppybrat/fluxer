// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import Accessibility from '@app/features/accessibility/state/Accessibility';
import {ChannelItem} from '@app/features/app/components/layout/ChannelItem';
import channelItemStyles from '@app/features/app/components/layout/ChannelItem.module.css';
import {ChannelItemContent} from '@app/features/app/components/layout/ChannelItemContent';
import styles from '@app/features/app/components/layout/ChannelListContent.module.css';
import {
	CollapsedCategoryVoiceParticipants,
	CollapsedChannelAvatarStack,
} from '@app/features/app/components/layout/CollapsedCategoryVoiceParticipants';
import {GenericChannelItem} from '@app/features/app/components/layout/GenericChannelItem';
import {GuildDetachedBanner} from '@app/features/app/components/layout/GuildDetachedBanner';
import {NullSpaceDropIndicator} from '@app/features/app/components/layout/NullSpaceDropIndicator';
import {ScrollIndicatorOverlay} from '@app/features/app/components/layout/ScrollIndicatorOverlay';
import {DND_TYPES, type DragItem, type DropResult} from '@app/features/app/components/layout/types/DndTypes';
import {
	shouldShowChannelInCollapsedCategory,
	shouldShowChannelWhenHidingMutedChannels,
} from '@app/features/app/components/layout/utils/ChannelListVisibility';
import {createChannelMoveOperation} from '@app/features/app/components/layout/utils/ChannelMoveOperation';
import {type ChannelGroup, organizeChannels} from '@app/features/app/components/layout/utils/ChannelOrganization';
import {getChannelUnreadState} from '@app/features/app/components/layout/utils/ChannelUnreadState';
import {VoiceParticipantsList} from '@app/features/app/components/layout/VoiceParticipantsList';
import {useRovingFocusList} from '@app/features/app/hooks/useRovingFocusList';
import type {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import * as GuildCommands from '@app/features/guild/commands/GuildCommands';
import type {Guild} from '@app/features/guild/models/Guild';
import {isKeyboardActivationKey} from '@app/features/input/utils/KeyboardUtils';
import {
	asGuildPageSegment,
	getGuildChannelSegment,
	getGuildPathSegment,
} from '@app/features/navigation/utils/GuildRouteSegments';
import * as RouterUtils from '@app/features/navigation/utils/RouterUtils';
import Permission from '@app/features/permissions/state/Permission';
import {useLocation} from '@app/features/platform/components/router/RouterReact';
import {failureCode} from '@app/features/platform/utils/ResponseInspection';
import ReadStates from '@app/features/read_state/state/ReadStates';
import {ChannelListContextMenu} from '@app/features/ui/action_menu/ChannelListContextMenu';
import * as ContextMenuCommands from '@app/features/ui/commands/ContextMenuCommands';
import * as DimensionCommands from '@app/features/ui/commands/DimensionCommands';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import type {ScrollerHandle} from '@app/features/ui/components/Scroller';
import {Scroller} from '@app/features/ui/components/Scroller';
import Dimension from '@app/features/ui/state/Dimension';
import KeyboardMode from '@app/features/ui/state/KeyboardMode';
import * as UserGuildSettingsCommands from '@app/features/user/commands/UserGuildSettingsCommands';
import UserGuildSettings from '@app/features/user/state/UserGuildSettings';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {MAX_CHANNELS_PER_CATEGORY} from '@fluxer/constants/src/LimitConstants';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {UsersThreeIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type {MotionValue} from 'motion';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useDragLayer} from 'react-dnd';
import {GenericErrorModal} from '../alerts/GenericErrorModal';

const CATEGORY_FULL_DESCRIPTOR = msg({
	message: 'Category full',
	comment: 'Short label in the app layout channel list content.',
});
const THIS_CATEGORY_ALREADY_CONTAINS_THE_MAXIMUM_OF_CHANNELS_DESCRIPTOR = msg({
	message: 'This category already contains the maximum of {maxChannelsPerCategory} channels.',
	comment:
		'Modal body shown when a category cannot accept another channel because the per-category limit is reached. Limit is interpolated.',
});
const CHANNELS_DESCRIPTOR = msg({
	message: '{guildName} channels',
	comment: 'Short label in the app layout channel list content. Preserve {guildName}; it is inserted by code.',
});
const CAST_DESCRIPTOR = msg({
	message: 'Cast',
	context: 'channel-list-entry',
	comment: 'Sidebar entry above the channel list opening the community cast overview page.',
});
const CAST_SELECTED_DESCRIPTOR = msg({
	message: 'Cast (selected)',
	context: 'channel-list-entry',
	comment: 'Accessible label for the sidebar Cast entry when its page is the current view.',
});
const NEW_MESSAGES_DESCRIPTOR = msg({
	message: 'New messages',
	comment: 'Short label in the app layout channel list content.',
});
const MEMBERS_PAGE_PERMISSIONS =
	Permissions.MANAGE_GUILD |
	Permissions.MANAGE_ROLES |
	Permissions.MANAGE_NICKNAMES |
	Permissions.BAN_MEMBERS |
	Permissions.MODERATE_MEMBERS |
	Permissions.KICK_MEMBERS;
const EMPTY_ARRAY: ReadonlyArray<never> = Object.freeze([]);
export const ChannelListContent = observer(({guild, scrollY}: {guild: Guild; scrollY: MotionValue<number>}) => {
	const {i18n} = useLingui();
	const channels = Channels.getGuildChannels(guild.id);
	const location = useLocation();
	const userGuildSettings = UserGuildSettings.getSettings(guild.id);
	const isDraggingAnything = useDragLayer((monitor) => {
		if (!monitor.isDragging()) return false;
		const itemType = monitor.getItemType();
		return (
			itemType === DND_TYPES.CHANNEL || itemType === DND_TYPES.CATEGORY || itemType === DND_TYPES.VOICE_PARTICIPANT
		);
	});
	const [activeDragItem, setActiveDragItem] = useState<DragItem | null>(null);
	const scrollerRef = useRef<ScrollerHandle>(null);
	const stickToBottomRef = useRef(false);
	const pendingScrollTopRef = useRef<number | null>(null);
	const scrollPersistRafRef = useRef<number | null>(null);
	const channelListNavigationRef = useRovingFocusList<HTMLDivElement>({
		focusableSelector: '[data-channel-list-focus-item="true"]',
		orientation: 'vertical',
		loop: true,
		enabled: KeyboardMode.keyboardModeEnabled,
		restoreFocusOnWindowFocus: false,
		manageTabIndex: true,
	});
	const connectedChannelId = MediaEngine.channelId;
	const hideMutedChannels = userGuildSettings?.hide_muted_channels ?? false;
	const showFadedUnreadOnMutedChannels = Accessibility.showFadedUnreadOnMutedChannels;
	// Deliberately reuses MEMBERS_PAGE_PERMISSIONS rather than inventing a cast-specific permission:
	// this entry occupies the slot the Members entry did, under the same gate.
	//
	// Not gated on platform. This list is the mobile "no channel selected" screen as well as the
	// desktop sidebar — GuildLayout renders the same GuildNavbar in both — so the entry sits in the
	// same slot above the channel list either way, and its transitionTo is the same mechanism a
	// channel tap uses. GuildLayout recognises the resulting route via showsGuildContent, which is
	// route-based and so does not care which control triggered the navigation.
	const canViewCast = ((Permission.getGuildPermissions(guild.id) ?? 0n) & MEMBERS_PAGE_PERMISSIONS) !== 0n;
	// Shared with GuildLayout so the sidebar's idea of "a guild page is open" cannot drift from the
	// layout's — they disagreeing is exactly what left these routes rendering nothing on mobile.
	const guildPageSegment = asGuildPageSegment(getGuildPathSegment(location.pathname, guild.id));
	const selectedChannelInGuildId = getGuildChannelSegment(location.pathname, guild.id);
	const isCastSelected = guildPageSegment === 'cast';
	// Members is no longer linked from this sidebar, but the route still exists and stays reachable
	// from the guild menu, so it must still suppress channel selection rather than read as an id.
	const isOnNonChannelRoute = guildPageSegment != null;
	const handleCastClick = useCallback(() => {
		RouterUtils.transitionTo(Routes.guildCast(guild.id));
	}, [guild.id]);
	const handleCastKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (!isKeyboardActivationKey(event.key)) return;
			event.preventDefault();
			handleCastClick();
		},
		[handleCastClick],
	);
	const collapsedCategories = useMemo(() => {
		const overrides = userGuildSettings?.channel_overrides;
		if (!overrides) return null;
		let collapsed: Set<string> | null = null;
		for (const channelId in overrides) {
			if (overrides[channelId as keyof typeof overrides].collapsed) {
				if (!collapsed) collapsed = new Set<string>();
				collapsed.add(channelId);
			}
		}
		return collapsed;
	}, [userGuildSettings]);
	const toggleCategory = useCallback(
		(categoryId: string) => {
			UserGuildSettingsCommands.toggleChannelCollapsed(guild.id, categoryId);
		},
		[guild.id],
	);
	const channelGroups = useMemo(() => organizeChannels(channels), [channels]);
	const showTrailingDropZone = channelGroups.length > 0;
	const channelIndicatorDependencies = useMemo(
		() => [channels.length, ReadStates.version, userGuildSettings, hideMutedChannels, showFadedUnreadOnMutedChannels],
		[channels.length, ReadStates.version, userGuildSettings, hideMutedChannels, showFadedUnreadOnMutedChannels],
	);
	const getChannelScrollContainer = useCallback(() => scrollerRef.current?.getScrollerNode() ?? null, [scrollerRef]);
	const handleChannelDrop = useCallback(
		(item: DragItem, result: DropResult) => {
			if (!result) return;
			const guildChannels = Channels.getGuildChannels(guild.id);
			const operation = createChannelMoveOperation({
				channels: guildChannels,
				dragItem: item,
				dropResult: result,
			});
			if (!operation) return;
			void (async () => {
				try {
					await GuildCommands.moveChannel(guild.id, operation);
				} catch (error) {
					if (failureCode(error) === APIErrorCodes.MAX_CATEGORY_CHANNELS) {
						ModalCommands.push(
							ModalCommands.modal(() => (
								<GenericErrorModal
									title={i18n._(CATEGORY_FULL_DESCRIPTOR)}
									message={i18n._(THIS_CATEGORY_ALREADY_CONTAINS_THE_MAXIMUM_OF_CHANNELS_DESCRIPTOR, {
										maxChannelsPerCategory: MAX_CHANNELS_PER_CATEGORY,
									})}
									data-flx="app.channel-list-content.handle-channel-drop.confirm-modal"
								/>
							)),
						);
						return;
					}
					throw error;
				}
			})();
		},
		[guild.id],
	);
	const handleScroll = useCallback(
		(event: React.UIEvent<HTMLDivElement>) => {
			const scrollTop = event.currentTarget.scrollTop;
			const scrollHeight = event.currentTarget.scrollHeight;
			const offsetHeight = event.currentTarget.offsetHeight;
			stickToBottomRef.current = scrollHeight - (scrollTop + offsetHeight) <= 8;
			scrollY.set(scrollTop);
			pendingScrollTopRef.current = scrollTop;
			if (scrollPersistRafRef.current != null) return;
			scrollPersistRafRef.current = requestAnimationFrame(() => {
				scrollPersistRafRef.current = null;
				const pendingScrollTop = pendingScrollTopRef.current;
				if (pendingScrollTop == null) return;
				DimensionCommands.updateChannelListScroll(guild.id, pendingScrollTop);
			});
		},
		[scrollY, guild.id],
	);
	useEffect(() => {
		return () => {
			if (scrollPersistRafRef.current != null) {
				cancelAnimationFrame(scrollPersistRafRef.current);
				scrollPersistRafRef.current = null;
			}
		};
	}, [guild.id]);
	const handleResize = useCallback((_entry: ResizeObserverEntry, _type: 'container' | 'content') => {
		if (stickToBottomRef.current && scrollerRef.current) {
			scrollerRef.current.scrollToBottom({animate: false});
		}
	}, []);
	useEffect(() => {
		const guildDimensions = Dimension.getGuildDimensions(guild.id);
		if (guildDimensions.scrollTo) {
			const element = document.querySelector(`[data-channel-id="${guildDimensions.scrollTo}"]`);
			if (element && scrollerRef.current) {
				scrollerRef.current.scrollIntoViewNode({node: element as HTMLElement, shouldScrollToStart: false});
			}
			DimensionCommands.clearChannelListScrollTo(guild.id);
		} else if (guildDimensions.scrollTop && guildDimensions.scrollTop > 0 && scrollerRef.current) {
			scrollerRef.current.scrollTo({to: guildDimensions.scrollTop, animate: false});
		}
	}, [guild.id]);
	const handleContextMenu = useCallback(
		(event: React.MouseEvent) => {
			ContextMenuCommands.openFromEvent(event, ({onClose}) => (
				<ChannelListContextMenu
					guild={guild}
					onClose={onClose}
					data-flx="app.channel-list-content.handle-context-menu.channel-list-context-menu"
				/>
			));
		},
		[guild],
	);
	const hasVisibleUnreadInChannel = (channelId: string): boolean => {
		const unreadCount = ReadStates.getUnreadCount(channelId);
		const mentionCount = ReadStates.getMentionCount(channelId);
		const isMuted =
			UserGuildSettings.isCategoryMuted(guild.id, channelId) || UserGuildSettings.isChannelMuted(guild.id, channelId);
		const channel = Channels.getChannel(channelId);
		const unreadBadgesLevel = channel
			? UserGuildSettings.resolvedUnreadBadgesLevel({
					id: channel.id,
					guildId: channel.guildId ?? undefined,
					parentId: channel.parentId ?? undefined,
					type: channel.type,
				})
			: null;
		const unreadState = getChannelUnreadState({
			unreadCount,
			mentionCount,
			isMuted,
			showFadedUnreadOnMutedChannels,
			unreadBadgesLevel,
		});
		return unreadState.hasVisibleUnread;
	};
	/** A channel row plus whether the category it actually lives in counts as muted. */
	type SurfacedChannel = {channel: Channel; categoryMuted: boolean};
	/**
	 * Every channel anywhere beneath a collapsed category.
	 *
	 * `categoryMuted` is carried per channel rather than taken from the collapsed category, because a
	 * channel three levels down belongs to its own category's mute state — and a mute anywhere up the
	 * chain still silences everything under it, which is why it propagates downward here.
	 */
	const collectSubtreeChannels = (group: ChannelGroup): {text: Array<SurfacedChannel>; voice: Array<SurfacedChannel>} => {
		const text: Array<SurfacedChannel> = [];
		const voice: Array<SurfacedChannel> = [];
		const walk = (current: ChannelGroup, ancestorMuted: boolean): void => {
			const categoryMuted =
				ancestorMuted ||
				(current.category ? UserGuildSettings.isChannelMuted(guild.id, current.category.id) : false);
			for (const ch of current.textChannels) text.push({channel: ch, categoryMuted});
			for (const ch of current.voiceChannels) voice.push({channel: ch, categoryMuted});
			for (const child of current.children) walk(child, categoryMuted);
		};
		walk(group, false);
		return {text, voice};
	};
	const keepWhenHidingMuted = (channel: Channel, isVoice: boolean): boolean => {
		const isMuted = UserGuildSettings.isChannelMuted(guild.id, channel.id);
		return shouldShowChannelWhenHidingMutedChannels({
			isMuted,
			isSelected: channel.id === selectedChannelInGuildId,
			isConnected: isVoice && channel.id === connectedChannelId,
			hasVisibleUnread: isMuted && hasVisibleUnreadInChannel(channel.id),
		});
	};
	/**
	 * Renders one category and everything under it, recursing for nested categories.
	 *
	 * Collapsing hides the entire subtree — no descendant category header, no descendant channel row —
	 * except for the rows the sidebar has always refused to hide: the selected channel, unread ones,
	 * and the voice channel you are connected to. Those surface from ANY depth, so collapsing a
	 * top-level category cannot silently swallow a mention buried three levels down.
	 *
	 * A descendant's own collapsed flag is never written here, only read, so a child that was collapsed
	 * before its parent was collapsed comes back collapsed when the parent expands.
	 */
	const renderGroup = (group: ChannelGroup, nested: boolean): React.ReactNode => {
		const category = group.category;
		const isNullSpace = !category;
		const isCollapsed = category ? (collapsedCategories?.has(category.id) ?? false) : false;
		const isCategoryMuted = category ? UserGuildSettings.isChannelMuted(guild.id, category.id) : false;
		// Collapsed: the candidate pool is the whole subtree. Expanded: only this category's own
		// channels, because its nested categories render themselves.
		const pool = isCollapsed
			? collectSubtreeChannels(group)
			: {
					text: group.textChannels.map((channel) => ({channel, categoryMuted: isCategoryMuted})),
					voice: group.voiceChannels.map((channel) => ({channel, categoryMuted: isCategoryMuted})),
				};
		const filteredTextChannels = hideMutedChannels
			? pool.text.filter((entry) => keepWhenHidingMuted(entry.channel, false))
			: pool.text;
		const filteredVoiceChannels = hideMutedChannels
			? pool.voice.filter((entry) => keepWhenHidingMuted(entry.channel, true))
			: pool.voice;
		let visibleTextChannels: ReadonlyArray<SurfacedChannel> = filteredTextChannels;
		let visibleVoiceChannels: ReadonlyArray<SurfacedChannel> = filteredVoiceChannels;
		let connectedChannelInGroup = false;
		if (isCollapsed) {
			visibleTextChannels = filteredTextChannels.filter((entry) =>
				shouldShowChannelInCollapsedCategory({
					isCategoryMuted: entry.categoryMuted,
					isSelected: entry.channel.id === selectedChannelInGuildId,
					hasVisibleUnread: hasVisibleUnreadInChannel(entry.channel.id),
				}),
			);
			const voiceSet = new Set<string>();
			if (selectedChannelInGuildId) voiceSet.add(selectedChannelInGuildId);
			if (connectedChannelId) {
				for (const entry of filteredVoiceChannels) {
					if (entry.channel.id === connectedChannelId) {
						connectedChannelInGroup = true;
						voiceSet.add(connectedChannelId);
						break;
					}
				}
			}
			for (const entry of filteredVoiceChannels) {
				if (
					shouldShowChannelInCollapsedCategory({
						isCategoryMuted: entry.categoryMuted,
						isSelected: entry.channel.id === selectedChannelInGuildId,
						hasVisibleUnread: hasVisibleUnreadInChannel(entry.channel.id),
					})
				) {
					voiceSet.add(entry.channel.id);
				}
			}
			if (voiceSet.size === 0) {
				visibleVoiceChannels = EMPTY_ARRAY;
			} else {
				const next: Array<SurfacedChannel> = [];
				let connectedRow: SurfacedChannel | null = null;
				for (const entry of filteredVoiceChannels) {
					if (!voiceSet.has(entry.channel.id)) continue;
					if (entry.channel.id === connectedChannelId) {
						connectedRow = entry;
					} else {
						next.push(entry);
					}
				}
				visibleVoiceChannels = connectedRow ? [connectedRow, ...next] : next;
			}
		}
		const childNodes = isCollapsed ? EMPTY_ARRAY : group.children.map((child) => renderGroup(child, true));
		const hasVisibleChildren = childNodes.some((node) => node != null);
		if (isNullSpace && filteredTextChannels.length === 0 && filteredVoiceChannels.length === 0) {
			return null;
		}
		// A category whose own channels are all hidden still renders when a nested category under it
		// has something to show — dropping it would orphan that descendant.
		if (
			hideMutedChannels &&
			category &&
			filteredTextChannels.length === 0 &&
			filteredVoiceChannels.length === 0 &&
			!hasVisibleChildren
		) {
			return null;
		}
		const showTextChannels = !isCollapsed || visibleTextChannels.length > 0;
		const showVoiceChannels = !isCollapsed || visibleVoiceChannels.length > 0;
		return (
			<div
				key={category?.id || 'null-space'}
				className={clsx(styles.channelGroup, nested && styles.nestedChannelGroup)}
				data-flx="app.channel-list-content.channel-group"
			>
				{category && (
					<ChannelItem
						guild={guild}
						channel={category}
						isCollapsed={isCollapsed}
						onToggle={() => toggleCategory(category.id)}
						isDraggingAnything={isDraggingAnything}
						activeDragItem={activeDragItem}
						onChannelDrop={handleChannelDrop}
						onDragStateChange={setActiveDragItem}
						isSelectedByPath={selectedChannelInGuildId === category.id}
						isOnNonChannelRoute={isOnNonChannelRoute}
						data-flx="app.channel-list-content.channel-item"
					/>
				)}
				{isCollapsed && category && !connectedChannelInGroup && (
					<CollapsedCategoryVoiceParticipants
						guild={guild}
						voiceChannels={filteredVoiceChannels.map((entry) => entry.channel)}
						data-flx="app.channel-list-content.collapsed-category-voice-participants"
					/>
				)}
				{showTextChannels &&
					visibleTextChannels.map((entry) => (
						<ChannelItem
							key={entry.channel.id}
							guild={guild}
							channel={entry.channel}
							isDraggingAnything={isDraggingAnything}
							activeDragItem={activeDragItem}
							onChannelDrop={handleChannelDrop}
							onDragStateChange={setActiveDragItem}
							isSelectedByPath={selectedChannelInGuildId === entry.channel.id}
							isOnNonChannelRoute={isOnNonChannelRoute}
							data-flx="app.channel-list-content.channel-item--2"
						/>
					))}
				{showVoiceChannels &&
					visibleVoiceChannels.map((entry) => {
						const ch = entry.channel;
						const channelRow = (
							<ChannelItem
								key={ch.id}
								guild={guild}
								channel={ch}
								isDraggingAnything={isDraggingAnything}
								activeDragItem={activeDragItem}
								onChannelDrop={handleChannelDrop}
								onDragStateChange={setActiveDragItem}
								isSelectedByPath={selectedChannelInGuildId === ch.id}
								isOnNonChannelRoute={isOnNonChannelRoute}
								data-flx="app.channel-list-content.channel-item--3"
							/>
						);
						if (isCollapsed && connectedChannelId && ch.id === connectedChannelId) {
							return (
								<React.Fragment key={ch.id}>
									{channelRow}
									<CollapsedChannelAvatarStack
										guild={guild}
										channel={ch}
										data-flx="app.channel-list-content.collapsed-channel-avatar-stack"
									/>
								</React.Fragment>
							);
						}
						return (
							<React.Fragment key={ch.id}>
								{channelRow}
								{!isCollapsed && (
									<VoiceParticipantsList
										guild={guild}
										channel={ch}
										data-flx="app.channel-list-content.voice-participants-list"
									/>
								)}
							</React.Fragment>
						);
					})}
				{childNodes}
			</div>
		);
	};
	return (
		<div
			className={styles.channelListScrollerWrapper}
			data-flx="app.channel-list-content.channel-list-scroller-wrapper"
		>
			<Scroller
				ref={scrollerRef}
				className={styles.channelListScroller}
				onScroll={handleScroll}
				onResize={handleResize}
				key={guild.id}
				data-flx="app.channel-list-content.channel-list-scroller"
			>
				<div
					className={styles.navigationContainer}
					onContextMenu={handleContextMenu}
					role="navigation"
					aria-label={i18n._(CHANNELS_DESCRIPTOR, {guildName: guild.name})}
					ref={channelListNavigationRef}
					data-flx="app.channel-list-content.navigation-container.context-menu"
				>
					<GuildDetachedBanner guild={guild} data-flx="app.channel-list-content.guild-detached-banner" />
					<div className={styles.topDropZone} data-flx="app.channel-list-content.top-drop-zone">
						<NullSpaceDropIndicator
							isDraggingAnything={isDraggingAnything}
							onChannelDrop={handleChannelDrop}
							variant="top"
							data-flx="app.channel-list-content.null-space-drop-indicator"
						/>
					</div>
					{canViewCast && (
						<>
							<div className={styles.membersSection} data-flx="app.channel-list-content.cast-section">
								<GenericChannelItem
									containerClassName={channelItemStyles.container}
									className={clsx(
										channelItemStyles.channelItem,
										channelItemStyles.channelItemRegular,
										isCastSelected && channelItemStyles.channelItemSelected,
										!isCastSelected && channelItemStyles.channelItemHoverable,
									)}
									isSelected={isCastSelected}
									aria-label={isCastSelected ? i18n._(CAST_SELECTED_DESCRIPTOR) : i18n._(CAST_DESCRIPTOR)}
									aria-current={isCastSelected ? 'page' : undefined}
									onClick={handleCastClick}
									onKeyDown={handleCastKeyDown}
									data-flx="app.channel-list-content.generic-channel-item.cast-click"
								>
									<ChannelItemContent
										icon={
											<UsersThreeIcon
												size={20}
												className={clsx(
													channelItemStyles.channelItemIcon,
													isCastSelected
														? channelItemStyles.channelItemIconSelected
														: channelItemStyles.channelItemIconUnselected,
												)}
												data-flx="app.channel-list-content.cast-icon"
											/>
										}
										name={i18n._(CAST_DESCRIPTOR)}
										data-flx="app.channel-list-content.channel-item-content"
									/>
								</GenericChannelItem>
							</div>
							<div className={styles.membersSeparator} data-flx="app.channel-list-content.cast-separator" />
						</>
					)}
					<div className={styles.channelGroupsContainer} data-flx="app.channel-list-content.channel-groups-container">
						{channelGroups.map((group) => renderGroup(group, false))}
					</div>
					{showTrailingDropZone && (
						<div className={styles.bottomDropZone} data-flx="app.channel-list-content.bottom-drop-zone">
							<NullSpaceDropIndicator
								isDraggingAnything={isDraggingAnything}
								onChannelDrop={handleChannelDrop}
								variant="bottom"
								data-flx="app.channel-list-content.null-space-drop-indicator--2"
							/>
						</div>
					)}
					<div className={styles.bottomSpacer} data-flx="app.channel-list-content.bottom-spacer" />
				</div>
			</Scroller>
			<ScrollIndicatorOverlay
				getScrollContainer={getChannelScrollContainer}
				dependencies={channelIndicatorDependencies}
				label={i18n._(NEW_MESSAGES_DESCRIPTOR)}
				data-flx="app.channel-list-content.scroll-indicator-overlay"
			/>
		</div>
	);
});
