// Copyright 2023 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Note that this file should not important any binary addons or Node.js modules
// because it can be imported by storybook
import {
  CallMode,
  CallState,
  GroupCallConnectionState,
} from '../../types/Calling';
import type { UUIDStringType } from '../../types/UUID';
import { missingCaseError } from '../../util/missingCaseError';
import type {
  DirectCallStateType,
  CallsByConversationType,
  GroupCallPeekInfoType,
  GroupCallStateType,
} from './calling';

// In theory, there could be multiple incoming calls, or an incoming call while there's
//   an active call. In practice, the UI is not ready for this, and RingRTC doesn't
//   support it for direct calls.
export const getIncomingCall = (
  callsByConversation: Readonly<CallsByConversationType>,
  ourUuid: UUIDStringType
): undefined | DirectCallStateType | GroupCallStateType =>
  Object.values(callsByConversation).find(call => {
    switch (call.callMode) {
      case CallMode.Direct:
        return call.isIncoming && call.callState === CallState.Ringing;
      case CallMode.Group:
        return (
          call.ringerUuid &&
          call.connectionState === GroupCallConnectionState.NotConnected &&
          isAnybodyElseInGroupCall(call.peekInfo, ourUuid)
        );
      default:
        throw missingCaseError(call);
    }
  });

export const isAnybodyElseInGroupCall = (
  peekInfo: undefined | Readonly<Pick<GroupCallPeekInfoType, 'uuids'>>,
  ourUuid: UUIDStringType
): boolean => Boolean(peekInfo?.uuids.some(id => id !== ourUuid));
