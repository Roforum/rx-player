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

export interface IMetaDashOverlayData {
  start : number;
  end : number;
  version : number;
  element : {
    url : string;
    format : string;
    xAxis : string;
    yAxis : string;
    height : string;
    width : string;
  };
}

export interface IHTMLOverlay {
  start : number;
  end: number;
  element : HTMLElement;
}

export default function parseMetaDASHOverlay(
  data : IMetaDashOverlayData[],
  timeOffset : number
) : IHTMLOverlay[] {
  return data.map(overlayData => {
    return {
      start: overlayData.start + timeOffset,
      end: overlayData.end + timeOffset,
      element: document.createElement("div"),
    };
  });
}
