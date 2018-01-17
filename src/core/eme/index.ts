/**
 * Copyright 2015 CANAL+ Group
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Observable } from "rxjs/Observable";
import { shouldUnsetMediaKeys } from "../../compat/";
import { onEncrypted$ } from "../../compat/events";
import { EncryptedMediaError } from "../../errors";
import assert from "../../utils/assert";
import castToObservable from "../../utils/castToObservable";
import log from "../../utils/log";
import noop from "../../utils/noop";
import {
  $loadedSessions,
  $storedSessions,
} from "./globals";
import findCompatibleKeySystem, {
  getKeySystem,
  IInstanceInfo,
  IKeySystemOption,
  IKeySystemPackage,
 } from "./key_system";
import { trySettingServerCertificate } from "./server_certificate";
import manageSessionCreation, {
  compareMksConfigurations,
  ErrorStream,
  ISessionEvent,
 } from "./session";
import setMediaKeysObs, { disposeMediaKeys } from "./set_media_keys";

// Persisted singleton instance of MediaKeys. We do not allow multiple
// CDM instances.
const instanceInfos: IInstanceInfo = {
  $mediaKeys: null,  // MediaKeys instance
  $mediaKeySystemConfiguration: null, // active MediaKeySystemConfiguration
  $keySystem: null,
  $videoElement: null,
};

/**
 * Call the createMediaKeys API and cast it to an observable.
 * @param {MediaKeySystemAccess} keySystemAccess
 * @returns {Observable}
 */
function createMediaKeysObs(
  keySystemAccess : MediaKeySystemAccess
) : Observable<MediaKeys> {
  // MediaKeySystemAccess.prototype.createMediaKeys returns a promise
  return castToObservable<MediaKeys>(keySystemAccess.createMediaKeys());
}

/**
 * Store licence if persistent
 * @param {Object} keySystem
 */
function handleSessionStorage(
  keySystem: IKeySystemOption
){
  if (keySystem.persistentLicense) {
    if (keySystem.licenseStorage) {
      $storedSessions.setStorage(keySystem.licenseStorage);
    } else {
      const error = new Error("no license storage found for persistent license.");
      throw new EncryptedMediaError("INVALID_KEY_SYSTEM", error, true);
    }
  }
}

/**
 * Triggers server certificate setting
 * @param {ArrayBuffer} serverCertificate
 * @param {MediaKeys} mediaKeys
 * @param {ErrorStream} errorStream
 */
function setCertificate$(
  serverCertificate: ArrayBuffer|ArrayBufferView|undefined,
  mediaKeys: MediaKeys,
  errorStream: ErrorStream
) {
  return (serverCertificate &&
    typeof mediaKeys.setServerCertificate === "function" ?
      trySettingServerCertificate(
        mediaKeys, serverCertificate, errorStream) :
    Observable.empty()) as Observable<never>; // Typescript hack
}

/**
 * Function triggered when both:
 *   - the first ``encrypted`` event has been received.
 *   - a compatible key system configuration has been found.
 *
 * Manage first session creation through all subsequent EME APIs.
 * @param {MediaEncryptedEvent} encryptedEvent
 * @param {Object} compatibleKeySystem
 * @param {MediaKeySystemAccess} compatibleKeySystem.keySystemAccess
 * @param {Object} compatibleKeySystem.keySystem - config given by the user
 * @returns {Observable}
 */
function handleInitEncryptedEvent(
  encryptedEvent : MediaEncryptedEvent,
  keySystemInfo: IKeySystemPackage,
  video : HTMLMediaElement,
  errorStream: ErrorStream
): Observable<MediaKeys|ISessionEvent|Event> {
  log.info("eme: first encrypted event from current content", encryptedEvent);
  if(encryptedEvent.initData == null){
    const error = new Error("no init data found on media encrypted event.");
    throw new EncryptedMediaError("INVALID_ENCRYPTED_EVENT", error, true);
  }

  const { keySystem, keySystemAccess } = keySystemInfo;
  const { serverCertificate } = keySystem;
  handleSessionStorage(keySystem);
  const initData = new Uint8Array(encryptedEvent.initData);

  return createMediaKeysObs(keySystemAccess).mergeMap((mediaKeys) => {
    const mksConfig = keySystemAccess.getConfiguration();
    const setMediaKeys$ =
      setMediaKeysObs(mediaKeys, mksConfig, video, keySystem, instanceInfos);
    const manageSessionCreation$ = manageSessionCreation(
      mediaKeys, mksConfig, keySystem, encryptedEvent.initDataType,
      initData, errorStream);
    return setCertificate$(serverCertificate, mediaKeys, errorStream)
      .concat(Observable.merge(setMediaKeys$, manageSessionCreation$));
  });
}

/**
 * Function triggered when both:
 *   - events from current encrypted content has been received.
 *   - a compatible key system configuration has been found.
 *
 * Manage session creation for current mediaKeys, through all subsequent EME APIs.
 */
function handleOngoingPlaybackEncryptedEvents(
  encryptedEvent$ : Observable<[MediaEncryptedEvent, IKeySystemPackage]>,
  video : HTMLMediaElement,
  errorStream: ErrorStream
): Observable<MediaKeys|ISessionEvent|Event> {
  return encryptedEvent$
    .mergeMap(([encryptedEvent , keySystemInfo]) => {
      log.info("eme: encrypted event", encryptedEvent);
      if(video.mediaKeys == null){
        const error = new Error("Video Element should have attached MediaKeys.");
        throw new EncryptedMediaError("INVALID_ENCRYPTED_EVENT", error, true);
      }
      if(encryptedEvent.initData == null){
        const error = new Error("No init data found on media encrypted event.");
        throw new EncryptedMediaError("INVALID_ENCRYPTED_EVENT", error, true);
      }

      const { keySystem, keySystemAccess } = keySystemInfo;
      const { serverCertificate } = keySystem;
      handleSessionStorage(keySystem);
      const initData = new Uint8Array(encryptedEvent.initData);
      const mksConfig = keySystemAccess.getConfiguration();
      if(
        !compareMksConfigurations(
          mksConfig,
          instanceInfos.$mediaKeySystemConfiguration as MediaKeySystemConfiguration
        )
      ){
        const error = new Error("Can't have sev");
        throw new EncryptedMediaError("INVALID_ENCRYPTED_EVENT", error, true);
      }

      const setMediaKeys$ = Observable.of(video.mediaKeys);
      const manageSessionCreation$ = manageSessionCreation(
        video.mediaKeys, mksConfig, keySystem, encryptedEvent.initDataType,
        initData, errorStream);
      return setCertificate$(serverCertificate, video.mediaKeys, errorStream)
        .concat(Observable.merge(setMediaKeys$, manageSessionCreation$));
    });
}

/**
 * EME abstraction and event handler used to communicate with the Content-
 * Description-Module (CDM).
 *
 * The EME handler can be given one or multiple systems and will choose the
 * appropriate one supported by the user's browser.
 * @param {HTMLMediaElement} video
 * @param {Object} keySystems
 * @param {Subject} errorStream
 * @returns {Observable}
 */
function createEME(
  video : HTMLMediaElement,
  keySystems: IKeySystemOption[],
  errorStream: ErrorStream
) : Observable<MediaKeys|ISessionEvent|Event> {
  if (__DEV__) {
    keySystems.forEach((ks) => assert.iface(ks, "keySystem", {
      getLicense: "function",
      type: "string",
    }));
  }

  const encryptedEvents$ =
  onEncrypted$(video).skip(1)
    .combineLatest(findCompatibleKeySystem(keySystems, instanceInfos));

  return onEncrypted$(video).take(1)
      .combineLatest(findCompatibleKeySystem(keySystems, instanceInfos))
      .mergeMap(([evt, ks] : [MediaEncryptedEvent, IKeySystemPackage]) => {
        return handleInitEncryptedEvent(evt, ks, video, errorStream)
          .merge(
            handleOngoingPlaybackEncryptedEvents(encryptedEvents$, video, errorStream)
          );
      });
}

/**
 * Free up all ressources taken by the EME management.
 */
function dispose() : void {
  // Remove MediaKey before to prevent MediaKey error
  // if other instance is creating after dispose
  disposeMediaKeys(instanceInfos.$videoElement).subscribe(noop);
  instanceInfos.$mediaKeys = null;
  instanceInfos.$keySystem = null;
  instanceInfos.$videoElement = null;
  instanceInfos.$mediaKeySystemConfiguration = null;
  $loadedSessions.dispose();
}

/**
 * Clear EME ressources as the current content stops its playback.
 */
function clearEME(): Observable<MediaKeys> {
  return Observable.defer(() => {
    if (instanceInfos.$videoElement && shouldUnsetMediaKeys()) {
      return disposeMediaKeys(instanceInfos.$videoElement)
        .finally(() => {
          instanceInfos.$videoElement = null;
        });
    }
    return Observable.empty();
  });
}

/**
 * Returns the name of the current key system used.
 * @returns {string}
 */
function getCurrentKeySystem() : string|null {
  return getKeySystem(instanceInfos);
}

/**
 * Perform EME management if needed.
 * @param {HTMLMediaElement} videoElement
 * @param {Array.<Object>} keySystems
 * @param {Subject} errorStream
 * @returns {Observable}
 */
export default function EMEManager(
  videoElement : HTMLMediaElement,
  keySystems : IKeySystemOption[],
  errorStream : ErrorStream
) :  Observable<MediaKeys|ISessionEvent|Event> {
  if (keySystems && keySystems.length) {
    return createEME(videoElement, keySystems, errorStream);
  } else {
    return onEncrypted$(videoElement).map(() => {
      log.error("eme: ciphered media and no keySystem passed");
      throw new EncryptedMediaError("MEDIA_IS_ENCRYPTED_ERROR", null, true);
    });
  }
}

export {
  createEME,
  clearEME,
  getCurrentKeySystem,
  dispose,
  IKeySystemOption,
  ErrorStream
};
