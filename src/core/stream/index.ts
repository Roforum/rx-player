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

import { BehaviorSubject } from "rxjs/BehaviorSubject";
import { Observable } from "rxjs/Observable";
import { ReplaySubject } from "rxjs/ReplaySubject";
import { Subject } from "rxjs/Subject";
import config from "../../config";
import arrayIncludes from "../../utils/array-includes";
import InitializationSegmentCache from "../../utils/initialization_segment_cache";
import log from "../../utils/log";
import { retryableFuncWithBackoff } from "../../utils/retry";
import throttle from "../../utils/rx-throttle";

import { onSourceOpen$ } from "../../compat/events";
import {
  CustomError,
  isKnownError,
  MediaError,
  OtherError,
} from "../../errors";
import Manifest, {
  ISupplementaryImageTrack,
  ISupplementaryTextTrack,
} from "../../manifest";
import Adaptation from "../../manifest/adaptation";
import Period from "../../manifest/period";
import { ITransportPipelines } from "../../net";
import ABRManager, {
  IABRMetric,
  IABRRequest,
} from "../abr";
import AdaptationBufferFactory from "../buffer/adaptation_buffer";
import {
  IAdaptationBufferEvent,
  IBufferFilledEvent,
  IBufferFinishedEvent,
} from "../buffer/types";
import { IKeySystemOption } from "../eme";
import {
  createManifestPipeline,
  IPipelineOptions,
  SegmentPipelinesManager,
} from "../pipelines";
import {
  addNativeSourceBuffer,
  createSourceBuffer,
  disposeSourceBuffer,
  ISourceBufferMemory,
  shouldHaveNativeSourceBuffer,
  SourceBufferOptions,
} from "../source_buffers";
import BufferGarbageCollector from "../source_buffers/buffer_garbage_collector";
import SegmentBookkeeper from "../source_buffers/segment_bookkeeper";
import { SupportedBufferTypes } from "../types";
import EMEManager from "./eme_manager";
import getInitialTime, {
  IInitialTimeOptions
} from "./get_initial_time";
import liveEventsHandler from "./live_events_handler";
import createMediaErrorHandler from "./media_error_handler";
import {
  createAndPlugMediaSource,
  setDurationToMediaSource,
} from "./media_source";
import SpeedManager from "./speed_manager";
import StallingManager from "./stalling_manager";
import createTimings from "./timings";
import {
  AdaptationsSubjects,
  IAdaptationChangeEvent,
  IManifestUpdateEvent,
  IStreamClockTick,
  StreamEvent,
} from "./types";
import createVideoEventsObservables from "./video_events";

const { END_OF_PLAY } = config;

/**
 * Keep memory of a single SegmentBookeeper by type of buffer.
 * Allows to lazily create SegmentBookeepers as they are needed.
 * @returns {Function}
 */
function initializeSegmentBookkeepersHandler() {
  const segmentBookkeepers : Partial<
    Record<SupportedBufferTypes, SegmentBookkeeper>
  > = {};

  /**
   * @param {string} bufferType
   * @returns {Object}
   */
  return function getSegmentBookkeeper(
    bufferType : SupportedBufferTypes
  ) : SegmentBookkeeper {
    const fromMemory = segmentBookkeepers[bufferType];
    if (!fromMemory) {
      const segmentBookkeeper = new SegmentBookkeeper();
      segmentBookkeepers[bufferType] = segmentBookkeeper;
      return segmentBookkeeper;
    } else {
      return fromMemory;
    }
  };
}

/**
 * Returns the pipeline options depending on the type of pipeline concerned.
 * @param {string} bufferType - e.g. "audio"|"text"...
 * @returns {Object} - Options to give to the Pipeline
 */
function getPipelineOptions(bufferType : string) : IPipelineOptions<any, any> {
  const downloaderOptions : IPipelineOptions<any, any> = {};
  if (arrayIncludes(["audio", "video"], bufferType)) {
    downloaderOptions.cache = new InitializationSegmentCache();
  } else if (bufferType === "image") {
    downloaderOptions.maxRetry = 0; // Deactivate BIF fetching if it fails
  }
  return downloaderOptions;
}

interface IStreamOptions {
  adaptiveOptions: {
    initialBitrates : Partial<Record<SupportedBufferTypes, number>>;
    manualBitrates : Partial<Record<SupportedBufferTypes, number>>;
    maxAutoBitrates : Partial<Record<SupportedBufferTypes, number>>;
    throttle : Partial<Record<SupportedBufferTypes, Observable<number>>>;
    limitWidth : Partial<Record<SupportedBufferTypes, Observable<number>>>;
  };
  autoPlay : boolean;
  bufferOptions : {
    wantedBufferAhead$ : Observable<number>;
    maxBufferAhead$ : Observable<number>;
    maxBufferBehind$ : Observable<number>;
  };
  errorStream : Subject<Error| CustomError>;
  speed$ : BehaviorSubject<number>;
  startAt? : IInitialTimeOptions;
  textTrackOptions : SourceBufferOptions;
  url : string;
  videoElement : HTMLMediaElement;
  withMediaSource : boolean;
  timings$ : Observable<IStreamClockTick>;
  supplementaryTextTracks : ISupplementaryTextTrack[];
  supplementaryImageTracks : ISupplementaryImageTrack[];
  keySystems : IKeySystemOption[];
  transport : ITransportPipelines<any, any, any, any, any>;
}

/**
 * Central part of the player. Play a given stream described by the given
 * manifest with given options.
 *
 * On subscription:
 *  - Creates the MediaSource and attached sourceBuffers instances.
 *  - download the content's manifest
 *  - Perform EME management if needed
 *  - create Buffer instances for each adaptation to manage buffers.
 *  - give adaptation control to the caller (e.g. to choose a language)
 *  - perform ABR Management
 *  - returns Observable emitting notifications about the stream lifecycle.
 *
 * TODO TOO MANY PARAMETERS something is wrong here.
 * @param {Object} args
 * @returns {Observable}
 */
export default function Stream({
  adaptiveOptions,
  autoPlay,
  bufferOptions,
  keySystems,
  speed$,
  startAt,
  url,
  videoElement,

  supplementaryImageTracks, // eventual manually added images
  supplementaryTextTracks, // eventual manually added subtitles

  errorStream, // subject through which minor errors are emitted TODO Remove?
  textTrackOptions,
  timings$,

  withMediaSource = true,

  transport,
} : IStreamOptions) : Observable<StreamEvent> {
  /**
   * Fetch and parse the manifest from the URL given.
   * Throttled to avoid doing multiple simultaneous requests.
   * @param {string} url - the manifest url
   * @returns {Observable} - the parsed manifest
   */
  const fetchManifest = throttle(createManifestPipeline(
    transport,
    errorStream,
    supplementaryTextTracks,
    supplementaryImageTracks
  ));

  /**
   * Map the "type" of a sourceBuffer (example "audio" or "video") to a
   * SourceBuffer.
   *
   * Allow to avoid creating multiple sourceBuffers for the same type.
   * TODO Is this compatible with codec switching?
   *
   * There is 2 "native" SourceBuffers: "audio" and "video" as they are the
   * only one added to the MediaSource.
   *
   * All other SourceBuffers are "custom"
   * @type Object
   */
  const sourceBufferMemory : ISourceBufferMemory = {
    native: {}, // SourceBuffers added to the MediaSource
    custom: {}, // custom SourceBuffers managed entirely in the Rx-PLayer
  };

  /**
   * Lazily create a SegmentBookkeeper for each buffer type.
   * @param {string}
   * @returns {Object}
   */
  const getSegmentBookkeeper = initializeSegmentBookkeepersHandler();

  /**
   * @see retryWithBackoff
   */
  const retryOptions = {
    totalRetry: 3,
    retryDelay: 250,
    resetDelay: 60 * 1000,

    shouldRetry: (error : Error) => {
      if (isKnownError(error)) {
        return !error.fatal;
      }
      return true;
    },

    errorSelector: (error : Error|CustomError) => {
      if (!isKnownError(error)) {
        return new OtherError("NONE", error, true);
      }
      error.fatal = true;
      return error;
    },

    onRetry: (error : Error|CustomError, tryCount : number) => {
      log.warn("stream retry", error, tryCount);
      errorStream.next(error);
    },
  };

  /**
   * End-Of-Play emit when the current timing is really close to the end.
   * @see END_OF_PLAY
   * @type {Observable}
   */
  const endOfPlay = timings$
    .filter(({ currentTime, duration }) => (
      duration > 0 && duration - currentTime < END_OF_PLAY
    ));

  /**
   * On subscription:
   *   - load the manifest (through its pipeline)
   *   - wiat for the given mediasource to be open
   * Once those are done, initialize the source duration and creates every
   * SourceBuffers and Buffers instances.
   *
   * This Observable can be retried on the basis of the retryOptions defined
   * here.
   * @param {Object} params
   * @param {string} params.url
   * @param {MediaSource|null} params.mediaSource
   * @returns {Observable}
   */
  const startStream = retryableFuncWithBackoff<any, StreamEvent>(
    function openStream({
      // TODO tslint bug? Document.
      /* tslint:disable no-use-before-declare */
      url: _url,
      /* tslint:enable no-use-before-declare */
      mediaSource,
    } : {
      url : string|null;
      mediaSource : MediaSource|null;
    }) {
      const sourceOpening$ = mediaSource
        ? onSourceOpen$(mediaSource)
        : Observable.of(null);

      return Observable.combineLatest(fetchManifest(url), sourceOpening$)
        .mergeMap(([manifest]) => createStream(mediaSource, manifest));
    }, retryOptions);

  return createAndPlugMediaSource(
    url,
    videoElement,
    withMediaSource,
    sourceBufferMemory
  )
    .mergeMap(startStream)
    .takeUntil(endOfPlay);

  /**
   * Creates a stream merging all observable that are required to make
   * the system cooperate.
   * @param {MediaSource} mediaSource
   * @param {Object} manifest
   * @returns {Observable}
   */
  function createStream(
    mediaSource : MediaSource|null,
    manifest : Manifest
  ): Observable<StreamEvent> {
    // TODO Find what to do with no media source.
    if (!mediaSource) {
      throw new MediaError("UNAVAILABLE_MEDIA_SOURCE", null, true);
    }

    setDurationToMediaSource(mediaSource, manifest.getDuration());

    // XXX TODO later with firstPeriod
    // Initialize all native source buffer at the same time. We cannot
    // lazily create native sourcebuffers since the spec does not
    // allow adding them during playback.
    //
    // From https://w3c.github.io/media-source/#methods
    //    For example, a user agent may throw a QuotaExceededError
    //    exception if the media element has reached the HAVE_METADATA
    //    readyState. This can occur if the user agent's media engine
    //    does not support adding more tracks during playback.
    Object.keys(manifest.adaptations).map(bufferType => {
      if (shouldHaveNativeSourceBuffer(bufferType)) {
        const firstPeriod : Period|undefined = manifest.periods[0];
        const adaptations = (firstPeriod && firstPeriod.adaptations[bufferType]) || [];
        const representations = adaptations ?
          adaptations[0].representations : [];
        if (representations.length) {
          const codec = representations[0].getMimeTypeString();
          addNativeSourceBuffer(mediaSource, bufferType, codec, sourceBufferMemory);
        }
      }
    });

    log.debug("calculating initial time");
    const startTime = getInitialTime(manifest, startAt);
    log.debug("initial time calculated:", startTime);

    const firstPlayedPeriod = manifest.getPeriodForTime(startTime);
    if (firstPlayedPeriod == null) {
      throw new MediaError("MEDIA_STARTING_TIME_NOT_FOUND", null, true);
    }

    const {
      timings: _timings,
      seekings,
    } = createTimings(manifest, timings$);

    // XXX TODO avoid this second step
    const {
      loaded$: loadedEvent$,
      clock$,
    } = createVideoEventsObservables(videoElement, startTime, autoPlay, _timings);

    const {
      wantedBufferAhead$,
      maxBufferAhead$,
      maxBufferBehind$,
    } = bufferOptions;

    /**
     * Subject through which network metrics will be sent to the ABR manager.
     * @type {Subject}
     */
    const network$ = new Subject<IABRMetric>();

    /**
     * Subject through which each request progression will be reported to the ABR
     * manager.
     * @type {Subject}
     */
    const requestsInfos$ = new Subject<Subject<IABRRequest>>();

    /**
     * Creates Pipelines for downloading segments.
     * @type {SegmentPipelinesManager}
     */
    const segmentPipelinesManager = new SegmentPipelinesManager(
      transport,
      requestsInfos$,
      network$,
      errorStream
    );

    const abrManager = new ABRManager(requestsInfos$, network$, adaptiveOptions);
    const createAdaptationBuffer = AdaptationBufferFactory(
      abrManager,
      timings$,
      speed$,
      seekings,
      wantedBufferAhead$,
      errorStream
    );

    const _adaptations$ : Partial<AdaptationsSubjects> = {};

    const _buffersArray = Object.keys(firstPlayedPeriod.adaptations)
      .map((adaptationType) => {
        // :/
        const bufferType = adaptationType as SupportedBufferTypes;

        const adaptation$ = new ReplaySubject<Adaptation|null>(1);

        // XXX TODO still makes sense?
        _adaptations$[bufferType] = adaptation$;

        return createPeriodBuffer(firstPlayedPeriod, adaptation$);

        function createPeriodBuffer(
          period : Period,
          _adaptation$ : Observable<Adaptation|null>
        ) : Observable<StreamEvent> {

          const periodBuffer$ = _adaptation$.switchMap((adaptation) => {
            if (mediaSource == null) {
              // should NEVER NEVER happen
              throw new MediaError("UNAVAILABLE_MEDIA_SOURCE", null, true);
            }

            if (adaptation == null) {
              log.info(`disposing ${bufferType} adaptation`);
              disposeSourceBuffer(
                videoElement,
                mediaSource,
                bufferType,
                sourceBufferMemory
              );

              return Observable.of({
                type: "adaptationChange" as "adaptationChange",
                value: {
                  type: bufferType,
                  adaptation: null,
                },
              }).concat(Observable.of({
                type: "representationChange" as "representationChange",
                value: {
                  type: bufferType,
                  representation: null,
                },
              })) as Observable<IAdaptationChangeEvent|IAdaptationBufferEvent>;
            }

            log.info(`updating ${bufferType} adaptation`, adaptation);
            const pipelineOptions = getPipelineOptions(bufferType);
            const segmentBookkeeper = getSegmentBookkeeper(bufferType);
            const { representations } = adaptation;
            const codec = (
              representations[0] && representations[0].getMimeTypeString()
            ) || "";

            const queuedSourceBuffer = createSourceBuffer(
              videoElement,
              mediaSource,
              bufferType,
              codec,
              sourceBufferMemory,
              bufferType === "text" ? textTrackOptions : {}
            );

            const pipeline =
              segmentPipelinesManager.createPipeline(bufferType, pipelineOptions);

            const adaptationBuffer$ = createAdaptationBuffer(
              clock$,
              queuedSourceBuffer,
              segmentBookkeeper,
              pipeline,
              { manifest, period, adaptation }
            );

            // XXX TODO One per SourceBuffer created as for SegmentBookkeepers
            const bufferGarbageCollector$ = BufferGarbageCollector({
              queuedSourceBuffer,
              clock$: clock$.map(tick => tick.currentTime),
              maxBufferBehind$,
              maxBufferAhead$,
            });

            return Observable.of({
              type: "adaptationChange",
              value: {
                type: bufferType,
                adaptation,
              },
            }).concat(Observable.merge(adaptationBuffer$, bufferGarbageCollector$));
          }).share();

          const bufferEnded$ : Observable<IBufferFilledEvent> = periodBuffer$
            .distinctUntilChanged((a, b) => a.type === b.type)
            .filter((message) : message is IBufferFilledEvent =>
              message.type === "filled"
            );

          const bufferFinished$ : Observable<IBufferFinishedEvent> = periodBuffer$
            .filter((message) : message is IBufferFinishedEvent =>
              message.type === "finished"
            );

          const bufferNeeds$ = periodBuffer$
            .filter(message => message.type === "segments-queued");

          const switchNextBuffer$ = Observable.merge(bufferEnded$, bufferFinished$)
            .take(1)
            .switchMap(({ value }) => {
              const _period = manifest.getPeriodForTime(value.wantedRange.end + 2);
              if (!_period) {
                // finished
                return Observable.empty();
              }

              const adaptationsArr = _period.adaptations[bufferType];
              const __adaptation$ = new BehaviorSubject<Adaptation|null>(adaptationsArr ?
                adaptationsArr[0] : null);

              log.warn("creating new Buffer for", bufferType, _period);
              return createPeriodBuffer(_period, __adaptation$);
                // .takeUntil(bufferNeeds$);
            });

          return Observable.merge(
            switchNextBuffer$,
            periodBuffer$.takeUntil(bufferFinished$)
          ) as Observable<StreamEvent>;
        }
      });

    const adaptations$ = _adaptations$ as AdaptationsSubjects;

    const buffers$ = (manifest.isLive ?
      Observable.merge(..._buffersArray)
        .mergeMap(liveEventsHandler(videoElement, manifest, refreshManifest)) :
      Observable.merge(..._buffersArray));

    const manifestEvent$ = Observable.of({
      type: "manifestChange",
      value: {
        manifest,
        period: firstPlayedPeriod,
        adaptations$,
        abrManager,
      },
    });

    const emeManager$ = EMEManager(videoElement, keySystems, errorStream);

    const speedManager$ = SpeedManager(videoElement, speed$, timings$, {
      pauseWhenStalled: withMediaSource,
    }).map(newSpeed => ({ type: "speed", value: newSpeed }));

    const stallingManager$ = StallingManager(videoElement, manifest, timings$)
      .map(stalledStatus => ({ type: "stalled", value: stalledStatus }));

    const mediaErrorHandler$ = createMediaErrorHandler(videoElement);

    return Observable.merge(
      buffers$,
      emeManager$,
      loadedEvent$,
      manifestEvent$,
      mediaErrorHandler$,
      speedManager$,
      stallingManager$
    );
  }

  /**
   * Re-fetch the manifest and merge it with the previous version.
   *
   * /!\ Mutates the given manifest
   * @param {Object} manifest
   * @returns {Observable}
   */
  function refreshManifest(
    manifest : Manifest
  ) : Observable<IManifestUpdateEvent> {
    const refreshURL = manifest.getUrl();
    if (!refreshURL) {
      log.warn("Cannot refresh the manifest: no url");
      return Observable.empty();
    }
    return fetchManifest(refreshURL)
      .map((parsed) => {
        manifest.update(parsed);
        return {
          type: "manifestUpdate" as "manifestUpdate",
          value: {
            manifest,
          },
        };
      });
  }
}
