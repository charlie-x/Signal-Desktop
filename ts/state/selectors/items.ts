// Copyright 2019 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createSelector } from 'reselect';
import { isInteger } from 'lodash';

import { ITEM_NAME as UNIVERSAL_EXPIRE_TIMER_ITEM } from '../../util/universalExpireTimer';
import { SafetyNumberMode } from '../../types/safetyNumber';
import { innerIsBucketValueEnabled } from '../../RemoteConfig';
import type { ConfigKeyType, ConfigMapType } from '../../RemoteConfig';
import type { StateType } from '../reducer';
import type { ItemsStateType } from '../ducks/items';
import type {
  ConversationColorType,
  CustomColorType,
} from '../../types/Colors';
import type { UUIDStringType } from '../../types/UUID';
import { DEFAULT_CONVERSATION_COLOR } from '../../types/Colors';
import { getPreferredReactionEmoji as getPreferredReactionEmojiFromStoredValue } from '../../reactions/preferredReactionEmoji';
import { isBeta } from '../../util/version';
import { DurationInSeconds } from '../../util/durations';
import { generateUsernameLink } from '../../util/sgnlHref';
import * as Bytes from '../../Bytes';
import { getUserNumber, getUserACI } from './user';

const DEFAULT_PREFERRED_LEFT_PANE_WIDTH = 320;

export const getItems = (state: StateType): ItemsStateType => state.items;

export const getAreWeASubscriber = createSelector(
  getItems,
  ({ areWeASubscriber }: Readonly<ItemsStateType>): boolean =>
    Boolean(areWeASubscriber)
);

export const getUserAgent = createSelector(
  getItems,
  (state: ItemsStateType): string => state.userAgent as string
);

export const getPinnedConversationIds = createSelector(
  getItems,
  (state: ItemsStateType): Array<string> =>
    (state.pinnedConversationIds || []) as Array<string>
);

export const getUniversalExpireTimer = createSelector(
  getItems,
  (state: ItemsStateType): DurationInSeconds =>
    DurationInSeconds.fromSeconds(state[UNIVERSAL_EXPIRE_TIMER_ITEM] || 0)
);

export const isRemoteConfigFlagEnabled = (
  config: Readonly<ConfigMapType>,
  key: ConfigKeyType
): boolean => Boolean(config[key]?.enabled);

// See isBucketValueEnabled in RemoteConfig.ts
const isRemoteConfigBucketEnabled = (
  config: Readonly<ConfigMapType>,
  name: ConfigKeyType,
  e164: string | undefined,
  uuid: UUIDStringType | undefined
): boolean => {
  const flagValue = config[name]?.value;
  return innerIsBucketValueEnabled(name, flagValue, e164, uuid);
};

export const getRemoteConfig = createSelector(
  getItems,
  (state: ItemsStateType): ConfigMapType => state.remoteConfig || {}
);

export const getServerTimeSkew = createSelector(
  getItems,
  (state: ItemsStateType): number => state.serverTimeSkew || 0
);

export const getUsernamesEnabled = createSelector(
  getRemoteConfig,
  (remoteConfig: ConfigMapType): boolean =>
    isRemoteConfigFlagEnabled(remoteConfig, 'desktop.usernames')
);

export const getHasCompletedUsernameOnboarding = createSelector(
  getItems,
  (state: ItemsStateType): boolean =>
    Boolean(state.hasCompletedUsernameOnboarding)
);

export const getHasCompletedUsernameLinkOnboarding = createSelector(
  getItems,
  (state: ItemsStateType): boolean =>
    Boolean(state.hasCompletedUsernameLinkOnboarding)
);

export const getHasCompletedSafetyNumberOnboarding = createSelector(
  getItems,
  (state: ItemsStateType): boolean =>
    Boolean(state.hasCompletedSafetyNumberOnboarding)
);

export const getUsernameLinkColor = createSelector(
  getItems,
  (state: ItemsStateType): number | undefined => state.usernameLinkColor
);

export const getUsernameLink = createSelector(
  getItems,
  ({ usernameLink }: ItemsStateType): string | undefined => {
    if (!usernameLink) {
      return undefined;
    }
    const { entropy, serverId } = usernameLink;

    if (!entropy.length || !serverId.length) {
      return undefined;
    }

    const content = Bytes.concatenate([entropy, serverId]);

    return generateUsernameLink(Bytes.toBase64(content));
  }
);

export const isInternalUser = createSelector(
  getRemoteConfig,
  (remoteConfig: ConfigMapType): boolean => {
    return isRemoteConfigFlagEnabled(remoteConfig, 'desktop.internalUser');
  }
);

// Note: ts/util/stories is the other place this check is done
export const getStoriesEnabled = createSelector(
  getItems,
  getRemoteConfig,
  getUserNumber,
  getUserACI,
  (
    state: ItemsStateType,
    remoteConfig: ConfigMapType,
    e164: string | undefined,
    aci: UUIDStringType | undefined
  ): boolean => {
    if (state.hasStoriesDisabled) {
      return false;
    }

    if (
      isRemoteConfigBucketEnabled(remoteConfig, 'desktop.stories2', e164, aci)
    ) {
      return true;
    }

    if (isRemoteConfigFlagEnabled(remoteConfig, 'desktop.internalUser')) {
      return true;
    }

    if (
      isRemoteConfigFlagEnabled(remoteConfig, 'desktop.stories2.beta') &&
      isBeta(window.getVersion())
    ) {
      return true;
    }

    return false;
  }
);

export const getContactManagementEnabled = createSelector(
  getRemoteConfig,
  (remoteConfig: ConfigMapType): boolean => {
    if (isRemoteConfigFlagEnabled(remoteConfig, 'desktop.contactManagement')) {
      return true;
    }

    if (
      isRemoteConfigFlagEnabled(
        remoteConfig,
        'desktop.contactManagement.beta'
      ) &&
      isBeta(window.getVersion())
    ) {
      return true;
    }

    return false;
  }
);

export const getSafetyNumberMode = createSelector(
  getRemoteConfig,
  getServerTimeSkew,
  (_state: StateType, { now }: { now: number }) => now,
  (
    remoteConfig: ConfigMapType,
    serverTimeSkew: number,
    now: number
  ): SafetyNumberMode => {
    if (
      !isRemoteConfigFlagEnabled(remoteConfig, 'desktop.safetyNumberAci') &&
      !(
        isRemoteConfigFlagEnabled(
          remoteConfig,
          'desktop.safetyNumberAci.beta'
        ) && isBeta(window.getVersion())
      )
    ) {
      return SafetyNumberMode.JustE164;
    }

    const timestamp = remoteConfig['global.safetyNumberAci']?.value;
    if (typeof timestamp !== 'number') {
      return SafetyNumberMode.DefaultE164AndThenACI;
    }

    // Note: serverTimeSkew is a difference between server time and local time,
    // so we have to add local time to it to correct it for a skew.
    return now + serverTimeSkew >= timestamp
      ? SafetyNumberMode.DefaultACIAndMaybeE164
      : SafetyNumberMode.DefaultE164AndThenACI;
  }
);

export const getDefaultConversationColor = createSelector(
  getItems,
  (
    state: ItemsStateType
  ): {
    color: ConversationColorType;
    customColorData?: {
      id: string;
      value: CustomColorType;
    };
  } => state.defaultConversationColor ?? DEFAULT_CONVERSATION_COLOR
);

export const getCustomColors = createSelector(
  getItems,
  (state: ItemsStateType): Record<string, CustomColorType> | undefined =>
    state.customColors?.colors
);

export const getEmojiSkinTone = createSelector(
  getItems,
  ({ skinTone }: Readonly<ItemsStateType>): number =>
    typeof skinTone === 'number' &&
    isInteger(skinTone) &&
    skinTone >= 0 &&
    skinTone <= 5
      ? skinTone
      : 0
);

export const getPreferredLeftPaneWidth = createSelector(
  getItems,
  ({ preferredLeftPaneWidth }: Readonly<ItemsStateType>): number =>
    typeof preferredLeftPaneWidth === 'number' &&
    Number.isInteger(preferredLeftPaneWidth)
      ? preferredLeftPaneWidth
      : DEFAULT_PREFERRED_LEFT_PANE_WIDTH
);

export const getPreferredReactionEmoji = createSelector(
  getItems,
  getEmojiSkinTone,
  (state: Readonly<ItemsStateType>, skinTone: number): Array<string> =>
    getPreferredReactionEmojiFromStoredValue(
      state.preferredReactionEmoji,
      skinTone
    )
);

export const getHideMenuBar = createSelector(
  getItems,
  (state: ItemsStateType): boolean => Boolean(state['hide-menu-bar'])
);

export const getHasSetMyStoriesPrivacy = createSelector(
  getItems,
  (state: ItemsStateType): boolean => Boolean(state.hasSetMyStoriesPrivacy)
);

export const getHasReadReceiptSetting = createSelector(
  getItems,
  (state: ItemsStateType): boolean => Boolean(state['read-receipt-setting'])
);

export const getHasStoryViewReceiptSetting = createSelector(
  getItems,
  (state: ItemsStateType): boolean =>
    Boolean(
      state.storyViewReceiptsEnabled ?? state['read-receipt-setting'] ?? false
    )
);

export const getRemoteBuildExpiration = createSelector(
  getItems,
  (state: ItemsStateType): number | undefined =>
    state.remoteBuildExpiration === undefined
      ? undefined
      : Number(state.remoteBuildExpiration)
);

export const getAutoDownloadUpdate = createSelector(
  getItems,
  (state: ItemsStateType): boolean =>
    Boolean(state['auto-download-update'] ?? true)
);

export const getTextFormattingEnabled = createSelector(
  getItems,
  (state: ItemsStateType): boolean => Boolean(state.textFormatting ?? true)
);
