// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {
  ErrorCode,
  KEMPublicKey,
  LibSignalErrorBase,
  PreKeyBundle,
  processPreKeyBundle,
  ProtocolAddress,
  PublicKey,
} from '@signalapp/libsignal-client';

import {
  OutgoingIdentityKeyError,
  UnregisteredUserError,
  HTTPError,
} from './Errors';
import { Sessions, IdentityKeys } from '../LibSignalStores';
import { Address } from '../types/Address';
import { QualifiedAddress } from '../types/QualifiedAddress';
import { UUID } from '../types/UUID';
import type { ServerKeysType, WebAPIType } from './WebAPI';
import * as log from '../logging/log';
import { isRecord } from '../util/isRecord';

export async function getKeysForIdentifier(
  identifier: string,
  server: WebAPIType,
  devicesToUpdate?: Array<number>,
  accessKey?: string
): Promise<{ accessKeyFailed?: boolean }> {
  try {
    const { keys, accessKeyFailed } = await getServerKeys(
      identifier,
      server,
      accessKey
    );

    await handleServerKeys(identifier, keys, devicesToUpdate);

    return {
      accessKeyFailed,
    };
  } catch (error) {
    if (error instanceof HTTPError && error.code === 404) {
      const theirUuid = UUID.lookup(identifier);

      if (theirUuid) {
        await window.textsecure.storage.protocol.archiveAllSessions(theirUuid);
      }

      throw new UnregisteredUserError(identifier, error);
    }

    throw error;
  }
}

async function getServerKeys(
  identifier: string,
  server: WebAPIType,
  accessKey?: string
): Promise<{ accessKeyFailed?: boolean; keys: ServerKeysType }> {
  try {
    if (!accessKey) {
      return {
        keys: await server.getKeysForIdentifier(identifier),
      };
    }

    return {
      keys: await server.getKeysForIdentifierUnauth(identifier, undefined, {
        accessKey,
      }),
    };
  } catch (error: unknown) {
    if (
      accessKey &&
      isRecord(error) &&
      typeof error.code === 'number' &&
      (error.code === 401 || error.code === 403)
    ) {
      return {
        accessKeyFailed: true,
        keys: await server.getKeysForIdentifier(identifier),
      };
    }

    throw error;
  }
}

async function handleServerKeys(
  identifier: string,
  response: ServerKeysType,
  devicesToUpdate?: Array<number>
): Promise<void> {
  const ourUuid = window.textsecure.storage.user.getCheckedUuid();
  const sessionStore = new Sessions({ ourUuid });
  const identityKeyStore = new IdentityKeys({ ourUuid });

  await Promise.all(
    response.devices.map(async device => {
      const { deviceId, registrationId, pqPreKey, preKey, signedPreKey } =
        device;
      if (
        devicesToUpdate !== undefined &&
        !devicesToUpdate.includes(deviceId)
      ) {
        return;
      }

      if (device.registrationId === 0) {
        log.info(
          `handleServerKeys/${identifier}: Got device registrationId zero!`
        );
      }
      if (!signedPreKey) {
        throw new Error(
          `getKeysForIdentifier/${identifier}: Missing signed prekey for deviceId ${deviceId}`
        );
      }
      const theirUuid = UUID.checkedLookup(identifier);
      const protocolAddress = ProtocolAddress.new(
        theirUuid.toString(),
        deviceId
      );
      const preKeyId = preKey?.keyId || null;
      const preKeyObject = preKey
        ? PublicKey.deserialize(Buffer.from(preKey.publicKey))
        : null;
      const signedPreKeyObject = PublicKey.deserialize(
        Buffer.from(signedPreKey.publicKey)
      );
      const identityKey = PublicKey.deserialize(
        Buffer.from(response.identityKey)
      );

      const pqPreKeyId = pqPreKey?.keyId || null;
      const pqPreKeyPublic = pqPreKey
        ? KEMPublicKey.deserialize(Buffer.from(pqPreKey.publicKey))
        : null;
      const pqPreKeySignature = pqPreKey
        ? Buffer.from(pqPreKey.signature)
        : null;

      const preKeyBundle = PreKeyBundle.new(
        registrationId,
        deviceId,
        preKeyId,
        preKeyObject,
        signedPreKey.keyId,
        signedPreKeyObject,
        Buffer.from(signedPreKey.signature),
        identityKey,
        pqPreKeyId,
        pqPreKeyPublic,
        pqPreKeySignature
      );

      const address = new QualifiedAddress(
        ourUuid,
        new Address(theirUuid, deviceId)
      );

      try {
        await window.textsecure.storage.protocol.enqueueSessionJob(
          address,
          `handleServerKeys(${identifier})`,
          () =>
            processPreKeyBundle(
              preKeyBundle,
              protocolAddress,
              sessionStore,
              identityKeyStore
            )
        );
      } catch (error) {
        if (
          error instanceof LibSignalErrorBase &&
          error.code === ErrorCode.UntrustedIdentity
        ) {
          throw new OutgoingIdentityKeyError(identifier, error);
        }
        throw error;
      }
    })
  );
}
