/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const MAX_ELEMENTS = 20000;
const YIELD_EVERY = 250;
const CHANGED_DEBOUNCE_MS = 250;

const NON_VISUAL_TAGS = new Set([
  "head",
  "meta",
  "link",
  "script",
  "style",
  "title",
  "base",
  "template",
  "br",
  "wbr",
  "source",
  "track",
]);

const CSS_IMAGE_PROPS = [
  "background-image",
  "border-image-source",
  "list-style-image",
  "cursor",
  "content",
];

/**
 * Enumerates and measures the image resources of one document. Sizes come from
 * naturalWidth/naturalHeight rather than the rendered width/height, and CSS
 * images are measured after `await img.decode()`.
 */
export class ImageResourceChild extends JSWindowActorChild {
  #mutationObserver = null;
  #changeTimer = null;

  actorCreated() {
    let doc = this.contentWindow?.document;
    if (!doc) {
      return;
    }
    this.#mutationObserver = new this.contentWindow.MutationObserver(() =>
      this.#scheduleChanged()
    );
    this.#mutationObserver.observe(doc, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "src",
        "srcset",
        "data-src",
        "data-srcset",
        "style",
        "class",
        "href",
        "poster",
      ],
    });
    this.contentWindow.addEventListener("load", this, true);
    this.contentWindow.addEventListener("error", this, true);
  }

  didDestroy() {
    if (this.#changeTimer) {
      lazy.clearTimeout(this.#changeTimer);
      this.#changeTimer = null;
    }
    this.#mutationObserver?.disconnect();
    this.#mutationObserver = null;
    try {
      this.contentWindow?.removeEventListener("load", this, true);
      this.contentWindow?.removeEventListener("error", this, true);
    } catch (e) {
      // The window is already gone during teardown.
    }
  }

  handleEvent() {
    this.#scheduleChanged();
  }

  #scheduleChanged() {
    if (this.#changeTimer) {
      lazy.clearTimeout(this.#changeTimer);
    }
    this.#changeTimer = lazy.setTimeout(() => {
      this.#changeTimer = null;
      try {
        this.sendAsyncMessage("ImageResource:changed", {});
      } catch (e) {
        // The actor may be torn down between the timer firing and delivery.
      }
    }, CHANGED_DEBOUNCE_MS);
  }

  receiveMessage(message) {
    switch (message.name) {
      case "ImageResource:collect":
        return this.#collect();
      case "ImageResource:readBytes":
        return this.#readBytes(message.data?.url);
      default:
        return undefined;
    }
  }

  async #collect() {
    let win = this.contentWindow;
    let doc = win?.document;
    if (!doc) {
      return { items: [], truncated: false };
    }

    let items = [];
    let seen = new Set();
    let nodeCount = 0;
    let truncated = false;

    let addItem = item => {
      if (!item.url || seen.has(item.url)) {
        return;
      }
      seen.add(item.url);
      items.push(item);
    };

    let iterator = doc.createTreeWalker(doc, win.NodeFilter.SHOW_ELEMENT);
    while (iterator.nextNode()) {
      let elem = iterator.currentNode;
      if (++nodeCount > MAX_ELEMENTS) {
        truncated = true;
        break;
      }
      if (nodeCount % YIELD_EVERY === 0) {
        await new Promise(resolve => lazy.setTimeout(resolve, 0));
      }
      this.#collectFromElement(win, doc, elem, addItem);
    }

    for (let item of items) {
      if (item.width || item.height || item.error) {
        continue;
      }
      await this.#measure(win, item);
    }

    let oa = {};
    let principal = null;
    let partitionKey = "";
    let cookieJarSettings = null;
    let isPrivate = false;
    try {
      principal = doc.nodePrincipal;
      oa = { ...(principal?.originAttributes ?? {}) };
      partitionKey = doc.cookieJarSettings?.partitionKey ?? "";
      cookieJarSettings = lazy.E10SUtils.serializeCookieJarSettings(
        doc.cookieJarSettings
      );
      isPrivate = lazy.PrivateBrowsingUtils.isContentWindowPrivate(
        doc.documentGlobal
      );
    } catch (e) {
      // Sandboxed or unusual principals: leave the descriptor minimal.
    }

    return {
      items,
      truncated,
      documentURI: doc.documentURIObject?.spec ?? "",
      cookieJarSettings,
      principal,
      originAttributes: oa,
      partitionKey,
      isPrivate,
    };
  }

  #collectFromElement(win, doc, elem, addItem) {
    let baseURI = "";
    try {
      baseURI = elem.baseURI ?? doc.baseURI ?? "";
    } catch (e) {
      baseURI = "";
    }

    if (!NON_VISUAL_TAGS.has(elem.localName)) {
      let style = null;
      try {
        style = win.getComputedStyle(elem);
      } catch (e) {
        style = null;
      }
      if (style) {
        for (let prop of CSS_IMAGE_PROPS) {
          let urls = [];
          try {
            urls = style.getCSSImageURLs(prop);
          } catch (e) {
            urls = [];
          }
          for (let url of urls) {
            addItem(this.#newItem(url, `css-${prop}`, { baseURI, isBg: true }));
          }
        }
      }
    }

    if (win.HTMLImageElement.isInstance(elem)) {
      let url = elem.currentSrc || elem.src || "";
      if (!url) {
        return;
      }
      let item = this.#newItem(url, "img", {
        alt: elem.getAttribute("alt") ?? "",
        baseURI,
      });
      let w = elem.naturalWidth;
      let h = elem.naturalHeight;
      if (w > 0 && h > 0) {
        item.width = w;
        item.height = h;
      } else if (elem.complete) {
        // Loaded without an intrinsic size: the URL failed (404, refused
        // connection, DNS failure). Listed and flagged, never fatal.
        item.error = true;
      }
      addItem(item);
      return;
    }

    if (win.SVGImageElement?.isInstance(elem)) {
      let href = "";
      try {
        href = URL.parse(elem.href.baseVal, elem.baseURI)?.href ?? "";
      } catch (e) {
        href = "";
      }
      if (href) {
        let item = this.#newItem(href, "svg-image", { baseURI });
        item.width = elem.width?.baseVal?.value ?? 0;
        item.height = elem.height?.baseVal?.value ?? 0;
        addItem(item);
      }
      return;
    }

    if (win.HTMLVideoElement.isInstance(elem) && elem.poster) {
      addItem(this.#newItem(elem.poster, "video-poster", { baseURI }));
      return;
    }

    if (
      win.HTMLInputElement.isInstance(elem) &&
      elem.type.toLowerCase() === "image" &&
      elem.src
    ) {
      addItem(
        this.#newItem(elem.src, "input-image", {
          alt: elem.getAttribute("alt") ?? "",
          baseURI,
        })
      );
    }
  }

  #newItem(url, type, { alt = "", baseURI = "", isBg = false } = {}) {
    return {
      url,
      type,
      alt,
      baseURI,
      isBg,
      width: 0,
      height: 0,
      bytes: -1,
      error: false,
      mimeType: "",
    };
  }

  async #measure(win, item) {
    if (item.url.startsWith("data:")) {
      item.bytes = dataURLByteLength(item.url);
      Object.assign(item, await imageSizeFromURL(win, item.url));
      return;
    }

    if (item.url.startsWith("blob:")) {
      try {
        let response = await win.fetch(item.url);
        let blob = await response.blob();
        item.bytes = blob.size;
        item.mimeType = blob.type || "";
      } catch (e) {
        item.error = true;
      }
      Object.assign(item, await imageSizeFromURL(win, item.url));
      return;
    }

    let size = await imageSizeFromURL(win, item.url);
    if (!size.width && !size.height) {
      item.error = true;
      return;
    }
    Object.assign(item, size);
  }

  async #readBytes(url) {
    let win = this.contentWindow;
    if (!win || !url?.startsWith("blob:")) {
      return null;
    }
    try {
      let response = await win.fetch(url);
      let bytes = await response.arrayBuffer();
      return {
        ok: true,
        bytes,
        mimeType: response.headers.get("content-type") ?? "",
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
}

/**
 * @param {Window} win
 * @param {string} url
 * @returns {Promise<{width: number, height: number}>}
 */
async function imageSizeFromURL(win, url) {
  let img = new win.Image();
  img.decoding = "async";
  try {
    img.src = url;
    await img.decode();
  } catch (e) {
    return { width: 0, height: 0 };
  }
  return { width: img.naturalWidth || 0, height: img.naturalHeight || 0 };
}

function decodeBase64Length(payload) {
  let clean = payload.replace(/\s/g, "");
  let padding = 0;
  if (clean.endsWith("==")) {
    padding = 2;
  } else if (clean.endsWith("=")) {
    padding = 1;
  }
  return Math.floor((clean.length * 3) / 4) - padding;
}

/**
 * @param {string} url
 * @returns {number} -1 when the URL cannot be parsed.
 */
function dataURLByteLength(url) {
  let comma = url.indexOf(",");
  if (comma < 0) {
    return -1;
  }
  let meta = url.slice(0, comma);
  let payload = url.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    return decodeBase64Length(payload);
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(payload)).length;
  } catch (e) {
    return payload.length;
  }
}
