/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Parent-process half of the ImageResource actor.
 *
 * Responsibilities:
 *  - Aggregate the enumeration of every frame in the tab's browsing context
 *    subtree into a single list (each frame has its own child actor).
 *  - Provide the byte size of a resource that cannot be measured from the
 *    parent side: the in-memory cache, the network, and blob: payloads that
 *    only the content process can read.
 *  - Tell the panel when the page's image set changed, so the list stays in
 *    sync with lazy-loaded and re-inserted images.
 *
 * The panel is a non-remote chrome page in this same process, so it calls
 * collectAll()/measure() directly; the only message that travels is the
 * child's "something changed" notification, which is re-broadcast as a DOM
 * event on the browser window for the panel to listen to.
 */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
});

// Refuse to hand a whole image through structured cloning past this size; the
// panel falls back to "save this one separately". Mirrors the limit documented
// for blob: images in the design notes.
const MAX_BLOB_BYTES = 32 * 1024 * 1024;

export const IMAGE_RESOURCE_EVENT = "ImageResource:Changed";

export class ImageResourceParent extends JSWindowActorParent {
  get #topBrowsingContext() {
    return this.browsingContext?.top ?? null;
  }

  /**
   * The chrome window hosting the tab this actor belongs to, or null when the
   * browsing context is not embedded in a browser window (e.g. during teardown).
   */
  get #browserWindow() {
    try {
      return this.#topBrowsingContext?.embedderElement?.documentGlobal ?? null;
    } catch (e) {
      return null;
    }
  }

  get browserWindow() {
    return this.#browserWindow;
  }

  receiveMessage(message) {
    if (message.name === "ImageResource:changed") {
      this.#broadcast();
      return undefined;
    }
    return undefined;
  }

  didDestroy() {
    // Nothing to release: the listeners live on the panel side.
  }

  #broadcast() {
    let win = this.#browserWindow;
    if (!win) {
      return;
    }
    try {
      win.dispatchEvent(new win.CustomEvent(IMAGE_RESOURCE_EVENT));
    } catch (e) {
      // The window went away between the check and the dispatch.
    }
  }

  /**
   * Enumerate the image resources of the whole tab, merged across frames.
   *
   * @returns {Promise<{items: object[], truncated: boolean, doc: object}>}
   */
  async collectAll() {
    let bcs = [];
    try {
      bcs = this.browsingContext.getAllBrowsingContextsInSubtree();
    } catch (e) {
      bcs = [];
    }

    let results = await Promise.all(
      bcs.map(async bc => {
        let global = bc.currentWindowGlobal;
        if (!global) {
          return null;
        }
        let actor;
        try {
          // The WindowGlobalParent of each frame; sendQuery on it is delivered
          // to that frame's child actor, which does the actual enumeration.
          actor = global.getActor("ImageResource");
        } catch (e) {
          return null;
        }
        try {
          return await actor.sendQuery("ImageResource:collect");
        } catch (e) {
          // A frame can be torn down mid-collection (navigation, removal).
          return null;
        }
      })
    );

    let seen = new Set();
    let items = [];
    let truncated = false;
    let doc = null;

    // getAllBrowsingContextsInSubtree() yields this context first, so results[0]
    // is the top frame. Its document descriptor is the one the save path needs:
    // the cookie jar and principal of the page itself, not of some subframe.
    let top = results[0];
    if (top) {
      doc = {
        documentURI: top.documentURI ?? "",
        cookieJarSettings: top.cookieJarSettings ?? null,
        principal: top.principal ?? null,
        originAttributes: top.originAttributes ?? {},
        partitionKey: top.partitionKey ?? "",
        isPrivate: !!top.isPrivate,
      };
    }

    for (let result of results) {
      if (!result) {
        continue;
      }
      truncated ||= !!result.truncated;
      for (let item of result.items ?? []) {
        if (seen.has(item.url)) {
          continue;
        }
        seen.add(item.url);
        items.push(item);
      }
    }

    return { items, truncated, doc };
  }

  /**
   * Resolve the byte size of an image URL.
   *
   * Order matters: the disk cache is authoritative for "what the page actually
   * received" (which is what the acceptance criteria hash against), so it is
   * consulted first and only a miss falls back to a HEAD request.
   *
   * @param {string} url
   * @param {object} doc The document descriptor returned by collectAll().
   * @returns {Promise<{bytes: number, source: string}>}
   */
  async measure(url, doc) {
    let uri;
    try {
      uri = Services.io.newURI(url);
    } catch (e) {
      return { bytes: -1, source: "unparseable" };
    }

    if (uri.schemeIs("data")) {
      return { bytes: dataURLByteLength(url), source: "data" };
    }

    if (uri.schemeIs("blob")) {
      return this.#measureBlob(uri);
    }

    let cached = await this.#cachedSize(uri, doc);
    if (cached >= 0) {
      return { bytes: cached, source: "cache" };
    }

    let remote = await this.#remoteSize(uri, doc);
    if (remote >= 0) {
      return { bytes: remote, source: "network" };
    }

    return { bytes: -1, source: "unknown" };
  }

  /**
   * Read the payload of a blob: URL from the content process that owns it.
   * Returns the bytes as an ArrayBuffer so the caller can write them verbatim.
   *
   * @param {string} url
   * @returns {Promise<{ok: boolean, bytes?: ArrayBuffer, mimeType?: string, error?: string, tooLarge?: boolean}>}
   */
  async readBlob(url) {
    let bcs = [];
    try {
      bcs = this.browsingContext.getAllBrowsingContextsInSubtree();
    } catch (e) {
      return { ok: false, error: "no browsing context" };
    }

    for (let bc of bcs) {
      let global = bc.currentWindowGlobal;
      if (!global) {
        continue;
      }
      try {
        let actor = global.getActor("ImageResource");
        let result = await actor.sendQuery("ImageResource:readBytes", { url });
        if (!result?.ok || !result.bytes) {
          continue;
        }
        if (result.bytes.byteLength > MAX_BLOB_BYTES) {
          return { ok: false, tooLarge: true };
        }
        return {
          ok: true,
          bytes: result.bytes,
          mimeType: result.mimeType ?? "",
        };
      } catch (e) {
        // Try the next frame.
      }
    }
    return { ok: false, error: "blob not found" };
  }

  // ------------------------------------------------------------------ sizes

  async #cachedSize(uri, doc) {
    let storage = this.#cacheStorage(doc);
    if (!storage) {
      return -1;
    }
    return new Promise(resolve => {
      let settled = false;
      let finish = value => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      try {
        storage.asyncOpenURI(uri, "", Ci.nsICacheStorage.OPEN_READONLY, {
          onCacheEntryCheck() {
            return Ci.nsICacheEntryOpenCallback.ENTRY_WANTED;
          },
          onCacheEntryAvailable(entry) {
            if (!entry) {
              finish(-1);
              return;
            }
            let size = -1;
            try {
              size = entry.dataSize;
            } catch (e) {
              // NS_ERROR_IN_PROGRESS while the entry is still being written.
              size = -1;
            }
            // -1 is the "size not known" sentinel on nsICacheEntry, not a
            // real byte count.
            finish(typeof size === "number" && size >= 0 ? size : -1);
          },
        });
      } catch (e) {
        finish(-1);
      }
    });
  }

  #cacheStorage(doc) {
    try {
      let oa = { ...(doc?.originAttributes ?? {}) };
      if (doc?.partitionKey !== undefined) {
        oa.partitionKey = doc.partitionKey;
      }
      // Private and non-private browsing use separate caches. The document's
      // own originAttributes carry privateBrowsingId, so building the context
      // from them gets the right one without a separate private/not branch.
      let loadContextInfo = Services.loadContextInfo.custom(false, oa);
      return Services.cache2.diskCacheStorage(loadContextInfo);
    } catch (e) {
      return null;
    }
  }

  async #remoteSize(uri, doc) {
    let principal = doc?.principal ?? null;
    if (!principal) {
      return -1;
    }
    let cookieJarSettings = null;
    try {
      cookieJarSettings = doc?.cookieJarSettings
        ? lazy.E10SUtils.deserializeCookieJarSettings(doc.cookieJarSettings)
        : null;
    } catch (e) {
      cookieJarSettings = null;
    }

    return new Promise(resolve => {
      let settled = false;
      let finish = value => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      let channel;
      try {
        channel = lazy.NetUtil.newChannel({
          uri,
          loadingPrincipal: principal,
          triggeringPrincipal: principal,
          securityFlags:
            Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_INHERITS_SEC_CONTEXT,
          contentPolicyType: Ci.nsIContentPolicy.TYPE_IMAGE,
        });
      } catch (e) {
        finish(-1);
        return;
      }

      if (cookieJarSettings) {
        try {
          channel.loadInfo.cookieJarSettings = cookieJarSettings;
        } catch (e) {
          // Older/newer signature mismatch: proceed without it.
        }
      }

      try {
        channel.QueryInterface(Ci.nsIHttpChannel);
        channel.requestMethod = "HEAD";
      } catch (e) {
        finish(-1);
        return;
      }

      channel.asyncOpen({
        onStartRequest(request) {
          let length = -1;
          try {
            length = request.QueryInterface(Ci.nsIChannel).contentLength;
          } catch (e) {
            length = -1;
          }
          finish(typeof length === "number" && length >= 0 ? length : -1);
          try {
            request.cancel(Cr.NS_BINDING_ABORTED);
          } catch (e) {
            // Already finishing.
          }
        },
        onStopRequest() {
          finish(-1);
        },
      });
    });
  }

  async #measureBlob(uri) {
    let result = await this.readBlob(uri.spec);
    if (result.ok) {
      return { bytes: result.bytes.byteLength, source: "blob" };
    }
    return {
      bytes: -1,
      source: result.tooLarge ? "blob-too-large" : "unknown",
    };
  }
}

/**
 * Byte length of the payload behind a data: URL.
 *
 * @param {string} url
 * @returns {number}
 */
function dataURLByteLength(url) {
  let comma = url.indexOf(",");
  if (comma < 0) {
    return -1;
  }
  let meta = url.slice(0, comma);
  let payload = url.slice(comma + 1);
  if (!/;base64/i.test(meta)) {
    try {
      return new TextEncoder().encode(decodeURIComponent(payload)).length;
    } catch (e) {
      return payload.length;
    }
  }
  let clean = payload.replace(/\s/g, "");
  let padding = 0;
  if (clean.endsWith("==")) {
    padding = 2;
  } else if (clean.endsWith("=")) {
    padding = 1;
  }
  return Math.floor((clean.length * 3) / 4) - padding;
}
