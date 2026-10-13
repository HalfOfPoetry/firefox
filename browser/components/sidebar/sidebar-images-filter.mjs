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
 * Reconcile an enumeration against the rows that are already displayed.
 *
 * A URL is the stable row identity. Items whose resource signature has not
 * changed keep the exact same object, so the keyed list can reuse its row and
 * unchanged measurement state instead of treating every DOM mutation as a
 * full-list replacement.
 *
 * @param {{url: string}[]} previousItems
 * @param {object[]} nextItems
 * @returns {{items: object[], added: string[], removed: string[],
 *            updated: string[]}}
 */
export function reconcileImageItems(previousItems, nextItems) {
  let previousByUrl = new Map(
    (previousItems ?? []).map(item => [item.url, item])
  );
  let nextUrls = new Set();
  let added = [];
  let updated = [];

  let items = (nextItems ?? []).map(next => {
    nextUrls.add(next.url);
    let previous = previousByUrl.get(next.url);
    if (!previous) {
      added.push(next.url);
      return { ...next };
    }
    if (hasSameResourceSignature(previous, next)) {
      return previous;
    }

    updated.push(next.url);
    let bytes = next.bytes;
    let sizeSource = next.sizeSource;
    if (
      !(Number.isFinite(bytes) && bytes >= 0) &&
      !next.error &&
      !previous.error
    ) {
      bytes = previous.bytes;
      sizeSource = previous.sizeSource;
    }
    return {
      ...next,
      bytes: Number.isFinite(bytes) ? bytes : -1,
      sizeSource: sizeSource ?? "",
    };
  });

  let removed = [...previousByUrl.keys()].filter(url => !nextUrls.has(url));
  return { items, added, removed, updated };
}

/**
 * Whether two enumerations describe the same displayed resource. Measurement
 * fields are deliberately excluded: a repeated enumeration does not change
 * them and must not make an unchanged row appear dirty.
 *
 * @param {object} previous
 * @param {object} next
 * @returns {boolean}
 */
function hasSameResourceSignature(previous, next) {
  return (
    previous.type === next.type &&
    previous.alt === next.alt &&
    previous.baseURI === next.baseURI &&
    previous.isBg === next.isBg &&
    previous.width === next.width &&
    previous.height === next.height &&
    previous.error === next.error &&
    previous.mimeType === next.mimeType
  );
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
