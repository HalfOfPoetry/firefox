/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Filtering rules for the images panel, kept free of chrome imports so the
 * thresholds can be exercised directly.
 *
 * Semantics, fixed by the acceptance criteria:
 *  - the enabled dimensions are combined with AND, never OR;
 *  - the bounds are inclusive, so an image exactly at the threshold passes;
 *  - a disabled or empty dimension does not participate at all -- it is not
 *    treated as 0 or as infinity;
 *  - no dimension other than these three exists.
 */

export const DEFAULT_FILTERS = Object.freeze({
  sizeEnabled: true,
  width: 200,
  height: 200,
  bytesEnabled: true,
  bytes: 10240,
});

/**
 * Coerce a persisted filter object into the shape the predicate expects.
 * Anything unusable falls back to the default for that field rather than
 * failing, so a pref edited by hand cannot break the panel.
 *
 * @param {unknown} raw
 * @returns {{sizeEnabled: boolean, width: number|null, height: number|null,
 *            bytesEnabled: boolean, bytes: number|null}}
 */
export function normalizeFilters(raw) {
  let source = raw && typeof raw === "object" ? raw : {};
  return {
    sizeEnabled: source.sizeEnabled !== false,
    width: toThreshold(source.width, DEFAULT_FILTERS.width),
    height: toThreshold(source.height, DEFAULT_FILTERS.height),
    bytesEnabled: source.bytesEnabled !== false,
    bytes: toThreshold(source.bytes, DEFAULT_FILTERS.bytes),
  };
}

/**
 * Whether a resource satisfies every enabled threshold.
 *
 * A resource whose byte size could not be determined never passes the byte
 * threshold; the panel reports those separately instead of dropping them
 * without a trace.
 *
 * @param {{width: number, height: number, bytes: number, error?: boolean}} item
 * @param {object} filters
 * @returns {boolean}
 */
export function matchesFilters(item, filters) {
  if (!item || item.error) {
    return false;
  }
  if (filters.sizeEnabled) {
    if (filters.width != null && item.width < filters.width) {
      return false;
    }
    if (filters.height != null && item.height < filters.height) {
      return false;
    }
  }
  if (
    filters.bytesEnabled &&
    filters.bytes != null &&
    item.bytes < filters.bytes
  ) {
    return false;
  }
  return true;
}

/**
 * Keep selected URLs that still exist in the refreshed image set.
 *
 * @param {{url: string}[]} items
 * @param {Iterable<string>} selectedUrls
 * @returns {Set<string>}
 */
export function reconcileImageSelection(items, selectedUrls) {
  let urls = new Set(items.map(item => item.url));
  return new Set([...selectedUrls].filter(url => urls.has(url)));
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number|null}
 */
function toThreshold(value, fallback) {
  if (value === null || value === "") {
    return null;
  }
  if (value === undefined) {
    return fallback;
  }
  let parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
