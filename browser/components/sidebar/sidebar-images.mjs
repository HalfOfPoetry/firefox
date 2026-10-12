/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Images panel: lists the image resources of the current page, filters them by
 * intrinsic size and byte size, previews them, and saves the checked ones as
 * original bytes into a directory the user picks.
 *
 * Two things this panel deliberately does NOT do:
 *
 *  - It does not report or save rendered dimensions. PageInfoChild's image list
 *    uses item.width/height, i.e. the size the CSS gave the element; here every
 *    dimension comes from naturalWidth/naturalHeight, so an 800x600 image with
 *    width="200" is listed, filtered and saved as 800x600.
 *  - It does not use moz-remote-image: for anything but the on-screen thumbnail.
 *    That protocol re-encodes to PNG, so a file saved through it would not be
 *    the original bytes.
 */

const lazy = {};

import {
  html,
  nothing,
  repeat,
} from "chrome://global/content/vendor/lit.all.mjs";
import { SidebarPage } from "./sidebar-page.mjs";
import {
  DEFAULT_FILTERS,
  matchesFilters,
  normalizeFilters,
} from "./sidebar-images-filter.mjs";

ChromeUtils.defineESModuleGetters(lazy, {
  DownloadPaths: "resource://gre/modules/DownloadPaths.sys.mjs",
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
  FaviconUtils: "moz-src:///toolkit/modules/FaviconUtils.sys.mjs",
});

const ReferrerInfo = Components.Constructor(
  "@mozilla.org/referrer-info;1",
  "nsIReferrerInfo",
  "init"
);

const FILTERS_PREF = "browser.imagesPanel.filters";
const DISCOVERED_PREF = "browser.imagesPanel.showFilteredOut";

// Bounds concurrent size measurement: each miss can open a network request, and
// a page with a hundred images should not fire a hundred at once.
const MEASURE_CONCURRENCY = 6;
// A save that has not completed in this long is reported as failed rather than
// leaving the panel stuck on "saving" forever (e.g. the network went away).
const SAVE_TIMEOUT_MS = 60000;
const THUMBNAIL_SIZE = 96;

export class SidebarImages extends SidebarPage {
  static properties = {
    items: { state: true },
    filters: { state: true },
    selected: { state: true },
    measuring: { state: true },
    truncated: { state: true },
    emptyKind: { state: true },
    saveState: { state: true },
    showFilteredOut: { state: true },
    docInfo: { state: true },
  };

  constructor() {
    super();
    this.items = [];
    this.selected = new Set();
    this.filters = this.#readFilters();
    this.measuring = false;
    this.truncated = false;
    this.emptyKind = "";
    this.saveState = null;
    this.showFilteredOut = Services.prefs.getBoolPref(DISCOVERED_PREF, false);
    this.docInfo = null;
    this._refreshToken = 0;
    this._onImageResourceChanged = () => this.refresh();
    this._onLocationChange = () => this.refresh();
  }

  connectedCallback() {
    super.connectedCallback();
    let win = this.topWindow;
    win.addEventListener("TabSelect", this._onLocationChange);
    win.addEventListener("ImageResource:Changed", this._onImageResourceChanged);
    this.#attachProgressListener();
    this.refresh();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    let win = this.topWindow;
    win.removeEventListener("TabSelect", this._onLocationChange);
    win.removeEventListener(
      "ImageResource:Changed",
      this._onImageResourceChanged
    );
    this.#detachProgressListener();
  }

  get #progressListener() {
    if (!this._progressListener) {
      this._progressListener = {
        onLocationChange: () => this.refresh(),
        onStateChange: () => {},
        onProgressChange: () => {},
        onStatusChange: () => {},
        onSecurityChange: () => {},
        onContentBlockingEvent: () => {},
        QueryInterface: ChromeUtils.generateQI([
          "nsIWebProgressListener",
          "nsISupportsWeakReference",
        ]),
      };
    }
    return this._progressListener;
  }

  #attachProgressListener() {
    let browser = this.#browser;
    if (!browser || browser === this._listeningBrowser) {
      return;
    }
    this.#detachProgressListener();
    try {
      browser.addProgressListener(
        this.#progressListener,
        Ci.nsIWebProgress.NOTIFY_LOCATION
      );
      this._listeningBrowser = browser;
    } catch (e) {
      // The browser is mid-teardown; the next TabSelect retries.
    }
  }

  #detachProgressListener() {
    if (!this._listeningBrowser) {
      return;
    }
    try {
      this._listeningBrowser.removeProgressListener(this.#progressListener);
    } catch (e) {
      // Already gone.
    }
    this._listeningBrowser = null;
  }

  // ------------------------------------------------------------- collection

  get #browser() {
    return this.topWindow.gBrowser?.selectedBrowser ?? null;
  }

  get #actor() {
    let global = this.#browser?.browsingContext?.currentWindowGlobal;
    if (!global) {
      return null;
    }
    try {
      // Returns the ImageResourceParent actor registered for this tab.
      return global.getActor("ImageResource");
    } catch (e) {
      return null;
    }
  }

  async refresh() {
    let token = ++this._refreshToken;
    this.#attachProgressListener();
    let actor = this.#actor;
    if (!actor) {
      this.items = [];
      this.measuring = false;
      this.emptyKind = "no-page";
      return;
    }

    this.measuring = true;
    let result;
    try {
      result = await actor.collectAll();
    } catch (e) {
      result = null;
    }
    if (token !== this._refreshToken) {
      return;
    }
    if (!result) {
      this.items = [];
      this.measuring = false;
      this.emptyKind = "error";
      return;
    }

    this.truncated = !!result.truncated;
    this.docInfo = result.doc;

    // Widths and heights arrive with the enumeration; byte sizes need a second
    // pass because they involve the cache and, on a miss, the network.
    let items = result.items.map(item => ({
      ...item,
      checked: false,
      bytes: item.bytes ?? -1,
      sizeSource: "",
    }));
    this.items = items;
    this.selected = new Set();
    this.#updateEmptyKind();
    this.measuring = items.some(item => item.bytes < 0 && !item.error);

    await this.#measureAll(actor, items, token);
  }

  async #measureAll(actor, items, token) {
    let queue = items.filter(item => item.bytes < 0 && !item.error);
    let index = 0;

    let worker = async () => {
      while (index < queue.length) {
        if (token !== this._refreshToken) {
          return;
        }
        let item = queue[index++];
        let measured;
        try {
          measured = await actor.measure(item.url, this.docInfo);
        } catch (e) {
          measured = { bytes: -1, source: "error" };
        }
        if (token !== this._refreshToken) {
          return;
        }
        item.bytes = measured.bytes;
        item.sizeSource = measured.source;
        if (index % MEASURE_CONCURRENCY === 0 || index === queue.length) {
          // Re-render in batches: the panel stays usable while a large page
          // is still being measured.
          this.items = [...this.items];
          this.#updateEmptyKind();
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(MEASURE_CONCURRENCY, queue.length) },
        worker
      )
    );
    if (token !== this._refreshToken) {
      return;
    }
    this.measuring = false;
    this.items = [...this.items];
    this.#updateEmptyKind();
  }

  #updateEmptyKind() {
    if (this.items.length) {
      this.emptyKind = "";
      return;
    }
    // "No images on this page" and "the enumeration itself could not run" are
    // different empty states and read very differently to the user.
    this.emptyKind = this.#actor ? "no-images" : "no-page";
  }

  // --------------------------------------------------------------- filtering

  #readFilters() {
    try {
      let raw = Services.prefs.getStringPref(FILTERS_PREF, "");
      if (raw) {
        return normalizeFilters(JSON.parse(raw));
      }
    } catch (e) {
      // A hand-edited pref falls back to the defaults rather than breaking the
      // panel.
    }
    return normalizeFilters(DEFAULT_FILTERS);
  }

  #writeFilters() {
    Services.prefs.setStringPref(FILTERS_PREF, JSON.stringify(this.filters));
  }

  get matchingItems() {
    return this.items.filter(item => matchesFilters(item, this.filters));
  }

  get excludedItems() {
    return this.items.filter(item => !matchesFilters(item, this.filters));
  }

  get unknownSizeItems() {
    return this.items.filter(item => item.bytes < 0 && !item.error);
  }

  get visibleItems() {
    return this.showFilteredOut
      ? [...this.matchingItems, ...this.excludedItems]
      : this.matchingItems;
  }

  #setFilter(key, value) {
    this.filters = { ...this.filters, [key]: value };
    this.#writeFilters();
    // Selection follows the filter: an item that no longer passes is dropped
    // from the pending save rather than silently saved anyway.
    let stillMatching = new Set(this.matchingItems.map(item => item.url));
    this.selected = new Set(
      [...this.selected].filter(url => stillMatching.has(url))
    );
    this.#updateEmptyKind();
  }

  onFilterInput(key, event) {
    let raw = event.target.value ?? "";
    let parsed = raw === "" ? null : Number.parseInt(raw, 10);
    this.#setFilter(key, Number.isFinite(parsed) ? parsed : null);
  }

  onShowFilteredOutChange(event) {
    this.showFilteredOut = !!event.target.checked;
    Services.prefs.setBoolPref(DISCOVERED_PREF, this.showFilteredOut);
  }

  resetFilters() {
    this.filters = normalizeFilters(DEFAULT_FILTERS);
    this.#writeFilters();
    this.#updateEmptyKind();
  }

  // --------------------------------------------------------------- selection

  toggleItem(item, checked) {
    let next = new Set(this.selected);
    if (checked) {
      next.add(item.url);
    } else {
      next.delete(item.url);
    }
    this.selected = next;
  }

  selectAll() {
    this.selected = new Set(this.matchingItems.map(item => item.url));
  }

  selectNone() {
    this.selected = new Set();
  }

  invertSelection() {
    let next = new Set();
    for (let item of this.matchingItems) {
      if (!this.selected.has(item.url)) {
        next.add(item.url);
      }
    }
    this.selected = next;
  }

  // ------------------------------------------------------------------ saving

  formatBytes(bytes) {
    if (bytes == null || bytes < 0) {
      return null;
    }
    let units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    let rounded = unit === 0 ? value : Math.round(value * 100) / 100;
    return `${rounded} ${units[unit]}`;
  }

  async chooseFolder() {
    let { nsIFile, nsIFilePicker } = Ci;
    let title = await document.l10n.formatValue("sidebar-images-choose-folder");
    let fp = Cc["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
    fp.init(window.browsingContext, title, nsIFilePicker.modeGetFolder);
    fp.appendFilters(nsIFilePicker.filterAll);
    try {
      let initialDir = Services.prefs.getComplexValue(
        "browser.download.dir",
        nsIFile
      );
      if (initialDir) {
        fp.displayDirectory = initialDir;
      }
    } catch (e) {
      // No remembered directory: the picker opens wherever the OS defaults to.
    }
    let result = await new Promise(resolve => fp.open(resolve));
    if (result !== nsIFilePicker.returnOK || !fp.file) {
      return null;
    }
    let dir = fp.file.QueryInterface(nsIFile);
    Services.prefs.setComplexValue("browser.download.dir", nsIFile, dir);
    return dir;
  }

  async save() {
    let targets = this.matchingItems.filter(item =>
      this.selected.has(item.url)
    );
    if (!targets.length) {
      return;
    }

    let dir = await this.chooseFolder();
    if (!dir) {
      return;
    }

    this.saveState = {
      running: true,
      done: 0,
      total: targets.length,
      succeeded: 0,
      failures: [],
    };

    for (let item of targets) {
      let outcome = await this.#saveOne(item, dir);
      if (outcome.ok) {
        this.saveState.succeeded++;
      } else {
        this.saveState.failures.push({
          name: outcome.name,
          url: item.url,
          reason: outcome.reason,
        });
      }
      this.saveState.done++;
      this.saveState = {
        ...this.saveState,
        failures: [...this.saveState.failures],
      };
    }

    this.saveState = { ...this.saveState, running: false };
  }

  /**
   * Save one item as its original bytes.
   *
   * http(s): through internalSave with the page's referrer, cookie jar and
   * principal. That is what makes the saved bytes identical to what the page
   * received -- in particular aShouldBypassCache stays false, because a fresh
   * request can be answered differently by a CDN that keys on UA or DPR.
   *
   * data:/blob:: written directly, byte for byte. blob: payloads only exist in
   * the content process, so the bytes are fetched through the actor.
   *
   * @param {object} item
   * @param {nsIFile} dir
   * @returns {Promise<{ok: boolean, name: string, reason?: string}>}
   */
  async #saveOne(item, dir) {
    let leafName = this.#fileNameFor(item);
    let file = dir.clone();
    file.append(leafName);

    // Never overwrite silently: the persist layer passes
    // PERSIST_FLAGS_REPLACE_EXISTING_FILES unconditionally, so the unique name
    // has to be established here. createNiceUniqueFile also fails early with
    // NS_ERROR_FILE_ACCESS_DENIED on a read-only target, which is how a
    // permission problem is distinguished from a network problem.
    try {
      file = lazy.DownloadPaths.createNiceUniqueFile(file);
      file.remove(false);
    } catch (e) {
      return { ok: false, name: leafName, reason: "access-denied" };
    }
    leafName = file.leafName;

    if (item.url.startsWith("data:") || item.url.startsWith("blob:")) {
      return this.#saveInline(item, file, leafName);
    }
    return this.#saveViaPersist(item, file, leafName);
  }

  async #saveInline(item, file, leafName) {
    let bytes;
    if (item.url.startsWith("blob:")) {
      let actor = this.#actor;
      let result = actor ? await actor.readBlob(item.url) : { ok: false };
      if (!result?.ok) {
        return {
          ok: false,
          name: leafName,
          reason: result?.tooLarge ? "too-large" : "read-failed",
        };
      }
      bytes = new Uint8Array(result.bytes);
    } else {
      try {
        bytes = dataURLToBytes(item.url);
      } catch (e) {
        return { ok: false, name: leafName, reason: "read-failed" };
      }
    }

    try {
      await IOUtils.write(file.path, bytes, { mode: "overwrite" });
    } catch (e) {
      return {
        ok: false,
        name: leafName,
        reason:
          e?.name === "NoModificationAllowedError"
            ? "access-denied"
            : "write-failed",
      };
    }
    return { ok: true, name: leafName };
  }

  async #saveViaPersist(item, file, leafName) {
    let topWindow = this.topWindow;
    let internalSave = topWindow.internalSave;
    if (typeof internalSave !== "function") {
      return { ok: false, name: leafName, reason: "internal-error" };
    }

    let referrerInfo;
    try {
      referrerInfo = new ReferrerInfo(
        Ci.nsIReferrerInfo.EMPTY,
        true,
        Services.io.newURI(
          item.baseURI || this.docInfo?.documentURI || item.url
        )
      );
    } catch (e) {
      referrerInfo = null;
    }

    let cookieJarSettings = null;
    try {
      cookieJarSettings = this.docInfo?.cookieJarSettings
        ? lazy.E10SUtils.deserializeCookieJarSettings(
            this.docInfo.cookieJarSettings
          )
        : null;
    } catch (e) {
      cookieJarSettings = null;
    }

    let uri;
    try {
      uri = Services.io.newURI(item.url);
    } catch (e) {
      return { ok: false, name: leafName, reason: "bad-url" };
    }

    let done = Promise.withResolvers();
    let timer = setTimeout(() => done.resolve("timeout"), SAVE_TIMEOUT_MS);

    try {
      internalSave(
        item.url, // aURL
        null, // aOriginalURL
        null, // aDocument
        null, // aDefaultFileName
        null, // aContentDisposition
        null, // aContentType
        false, // aShouldBypassCache -- see the comment above
        "SaveImageTitle", // aFilePickerTitleKey
        new topWindow.AutoChosen(file, uri), // aChosenData
        referrerInfo, // aReferrerInfo
        cookieJarSettings, // aCookieJarSettings
        null, // aInitiatingDocument
        true, // aSkipPrompt -- write straight to the chosen path
        null, // aCacheKey
        !!this.docInfo?.isPrivate, // aIsContentWindowPrivate
        this.docInfo?.principal ?? null, // aPrincipal
        () => done.resolve("complete") // aSaveCompleteCallback
      );
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, name: leafName, reason: "save-failed" };
    }

    let how = await done.promise;
    clearTimeout(timer);
    if (how === "timeout") {
      return { ok: false, name: leafName, reason: "timeout" };
    }

    // internalSave does not report per-file success, so confirm on disk. This
    // is also what keeps the reported success count equal to the file count.
    let exists = false;
    try {
      exists = (await IOUtils.exists(file.path)) && file.fileSize > 0;
    } catch (e) {
      exists = false;
    }
    if (exists) {
      return { ok: true, name: leafName };
    }
    return { ok: false, name: leafName, reason: "save-failed" };
  }

  #fileNameFor(item) {
    let leafName = "";
    try {
      let uri = Services.io.newURI(item.url);
      if (uri instanceof Ci.nsIURL && uri.fileName) {
        leafName = decodeURIComponent(uri.fileName);
      }
    } catch (e) {
      leafName = "";
    }
    if (!leafName) {
      leafName = `image${extensionForMime(item.mimeType)}`;
    }
    try {
      leafName = lazy.DownloadPaths.sanitize(leafName, {
        compressWhitespaces: false,
        allowInvalidFilenames: true,
      });
    } catch (e) {
      // Keep the unsanitized name; createNiceUniqueFile rejects what the OS
      // cannot take.
    }
    return leafName || "image";
  }

  // --------------------------------------------------------------- rendering

  #thumbnailFor(item) {
    if (item.error) {
      return null;
    }
    // moz-remote-image: re-encodes the image in a content process, which makes
    // it safe to render here and cheap enough to decode many of. It is only
    // ever used for this thumbnail; the bytes that get SAVED come from the
    // original URL.
    try {
      return lazy.FaviconUtils.getMozRemoteImageURL(item.url, {
        size: THUMBNAIL_SIZE,
        // Treat the size as a bound and keep the aspect ratio, so wide images
        // are not squashed into a square.
        stretch: false,
        contentParentId:
          this.#browser?.browsingContext?.currentWindowGlobal?.contentParentId,
      });
    } catch (e) {
      return null;
    }
  }

  render() {
    return html`
      ${this.stylesheet()}
      <link
        rel="stylesheet"
        href="chrome://browser/content/sidebar/sidebar-images.css"
      />
      <div class="sidebar-panel">
        <sidebar-panel-header
          data-l10n-id="sidebar-menu-images-header"
          data-l10n-attrs="heading"
          view="viewImagesSidebar"
        >
          <div class="options-container">
            <moz-button
              class="select-all-button"
              data-l10n-id="sidebar-images-select-all"
              ?disabled=${!this.matchingItems.length}
              @click=${this.selectAll}
            ></moz-button>
            <moz-button
              class="clear-selection-button"
              data-l10n-id="sidebar-images-select-none"
              ?disabled=${!this.selected.size}
              @click=${this.selectNone}
            ></moz-button>
            <moz-button
              class="invert-selection-button"
              data-l10n-id="sidebar-images-invert-selection"
              ?disabled=${!this.matchingItems.length}
              @click=${this.invertSelection}
            ></moz-button>
          </div>
        </sidebar-panel-header>
        <div class="sidebar-panel-scrollable-content" tabindex="-1">
          ${this.#filtersTemplate()} ${this.#statusTemplate()}
          ${this.#saveResultTemplate()} ${this.#listTemplate()}
        </div>
        ${this.#footerTemplate()}
      </div>
    `;
  }

  #filtersTemplate() {
    let f = this.filters;
    return html`
      <moz-card data-l10n-id="sidebar-images-filters-heading">
        <div class="filters">
          <div class="filter-row">
            <moz-checkbox
              class="filter-enable"
              data-l10n-id="sidebar-images-filter-size"
              ?checked=${f.sizeEnabled}
              @change=${e => this.#setFilter("sizeEnabled", e.target.checked)}
            ></moz-checkbox>
            <moz-input-number
              class="filter-input"
              data-l10n-id="sidebar-images-filter-min-width"
              data-l10n-attrs="label"
              ?disabled=${!f.sizeEnabled}
              .value=${f.width == null ? "" : String(f.width)}
              @change=${e => this.onFilterInput("width", e)}
            ></moz-input-number>
            <moz-input-number
              class="filter-input"
              data-l10n-id="sidebar-images-filter-min-height"
              data-l10n-attrs="label"
              ?disabled=${!f.sizeEnabled}
              .value=${f.height == null ? "" : String(f.height)}
              @change=${e => this.onFilterInput("height", e)}
            ></moz-input-number>
          </div>
          <div class="filter-row">
            <moz-checkbox
              class="filter-enable"
              data-l10n-id="sidebar-images-filter-bytes"
              ?checked=${f.bytesEnabled}
              @change=${e => this.#setFilter("bytesEnabled", e.target.checked)}
            ></moz-checkbox>
            <moz-input-number
              class="filter-input"
              data-l10n-id="sidebar-images-filter-min-bytes"
              data-l10n-attrs="label"
              ?disabled=${!f.bytesEnabled}
              .value=${f.bytes == null ? "" : String(f.bytes)}
              @change=${e => this.onFilterInput("bytes", e)}
            ></moz-input-number>
            <moz-button
              class="reset-button"
              data-l10n-id="sidebar-images-filter-reset"
              @click=${this.resetFilters}
            ></moz-button>
          </div>
          <moz-checkbox
            class="show-excluded"
            data-l10n-id="sidebar-images-show-excluded"
            ?checked=${this.showFilteredOut}
            @change=${e => this.onShowFilteredOutChange(e)}
          ></moz-checkbox>
        </div>
      </moz-card>
    `;
  }

  #statusTemplate() {
    let unknown = this.unknownSizeItems.length;
    return html`
      <div class="status">
        <span
          data-l10n-id="sidebar-images-count"
          data-l10n-args=${JSON.stringify({
            matching: this.matchingItems.length,
            total: this.items.length,
          })}
        ></span>
        ${this.measuring
          ? html`<span
              class="measuring"
              data-l10n-id="sidebar-images-measuring"
            ></span>`
          : nothing}
        ${unknown
          ? html`<span
              class="unknown-size"
              data-l10n-id="sidebar-images-unknown-size"
              data-l10n-args=${JSON.stringify({ count: unknown })}
            ></span>`
          : nothing}
        ${this.truncated
          ? html`<span
              class="truncated"
              data-l10n-id="sidebar-images-truncated"
            ></span>`
          : nothing}
      </div>
    `;
  }

  #saveResultTemplate() {
    let state = this.saveState;
    if (!state) {
      return nothing;
    }
    return html`
      <div class="save-result" role="status">
        ${state.running
          ? html`<span
              data-l10n-id="sidebar-images-saving-progress"
              data-l10n-args=${JSON.stringify({
                done: state.done,
                total: state.total,
              })}
            ></span>`
          : html`<span
              data-l10n-id="sidebar-images-save-result"
              data-l10n-args=${JSON.stringify({
                succeeded: state.succeeded,
                failed: state.failures.length,
              })}
            ></span>`}
        ${state.failures.length
          ? html`<ul class="failures">
              ${state.failures.slice(0, 10).map(
                failure =>
                  html`<li class="failure">
                    <span class="failure-name">${failure.name}</span>
                    <span
                      class="failure-reason"
                      data-l10n-id=${reasonLabelId(failure.reason)}
                    ></span>
                  </li>`
              )}
              ${state.failures.length > 10
                ? html`<li
                    data-l10n-id="sidebar-images-save-failure-more"
                    data-l10n-args=${JSON.stringify({
                      count: state.failures.length - 10,
                    })}
                  ></li>`
                : nothing}
            </ul>`
          : nothing}
      </div>
    `;
  }

  #listTemplate() {
    let items = this.visibleItems;
    if (!items.length) {
      return this.#emptyTemplate();
    }
    return html`
      <ul class="image-list">
        ${repeat(
          items,
          item => item.url,
          item => this.#itemTemplate(item)
        )}
      </ul>
    `;
  }

  #emptyTemplate() {
    let id = "sidebar-images-empty-idle";
    if (this.emptyKind === "no-images") {
      id = "sidebar-images-empty-no-images";
    } else if (this.emptyKind === "error") {
      id = "sidebar-images-empty-error";
    }
    return html`<fxview-empty-state
      class="empty-state"
      .headerLabel=${id}
      .descriptionLabels=${[id + "-description"]}
      isSelectedTab
    ></fxview-empty-state>`;
  }

  #itemTemplate(item) {
    let matches = matchesFilters(item, this.filters);
    let thumb = this.#thumbnailFor(item);
    let bytes = this.formatBytes(item.bytes);
    return html`
      <li class="image-item ${matches ? "" : "excluded"}">
        <moz-checkbox
          class="image-check"
          ?disabled=${!matches}
          ?checked=${this.selected.has(item.url)}
          aria-label=${item.url}
          @change=${e => this.toggleItem(item, e.target.checked)}
        ></moz-checkbox>
        <div class="thumb">
          ${thumb
            ? html`<img src=${thumb} alt="" loading="lazy" />`
            : html`<div
                class="thumb-missing"
                data-l10n-id="sidebar-images-thumb-unavailable"
              ></div>`}
        </div>
        <div class="meta">
          <div class="dimensions">
            ${item.width && item.height
              ? `${item.width}x${item.height}`
              : html`<span data-l10n-id="sidebar-images-size-unknown"></span>`}
          </div>
          <div class="bytes">
            ${bytes ??
            html`<span
              class="unknown"
              data-l10n-id="sidebar-images-bytes-unknown"
            ></span>`}
          </div>
          <div class="url" title=${item.url}>${displayURL(item.url)}</div>
          ${item.error
            ? html`<div
                class="error"
                data-l10n-id="sidebar-images-load-failed"
              ></div>`
            : nothing}
          ${!matches && !item.error
            ? html`<div
                class="excluded-note"
                data-l10n-id="sidebar-images-excluded-note"
              ></div>`
            : nothing}
        </div>
      </li>
    `;
  }

  #footerTemplate() {
    let count = this.selected.size;
    return html`
      <div class="save-footer">
        <span
          class="selection-count"
          data-l10n-id="sidebar-images-selected-count"
          data-l10n-args=${JSON.stringify({ count })}
        ></span>
        <moz-button
          class="save-button"
          type="primary"
          data-l10n-id="sidebar-images-save-originals"
          ?disabled=${!count || this.saveState?.running}
          @click=${this.save}
        ></moz-button>
      </div>
    `;
  }
}

customElements.define("sidebar-images", SidebarImages);

/**
 * Decode the payload of a data: URL to its exact bytes.
 *
 * @param {string} url
 * @returns {Uint8Array}
 */
function dataURLToBytes(url) {
  let comma = url.indexOf(",");
  if (comma < 0) {
    throw new Error("malformed data URL");
  }
  let meta = url.slice(0, comma);
  let payload = url.slice(comma + 1);
  if (!/;base64/i.test(meta)) {
    return new TextEncoder().encode(decodeURIComponent(payload));
  }
  return Uint8Array.from(atob(payload.replace(/\s/g, "")), c =>
    c.charCodeAt(0)
  );
}

/**
 * Shorten a URL for display without hiding which resource it is. The panel
 * never renders a URL as markup, only as text.
 *
 * @param {string} url
 * @returns {string}
 */
function displayURL(url) {
  if (url.startsWith("data:")) {
    return url.slice(0, 40) + "…";
  }
  try {
    let parsed = new URL(url);
    let tail = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
    return parsed.search ? `${tail}${parsed.search}` : tail || parsed.host;
  } catch (e) {
    return url.slice(0, 60);
  }
}

/**
 * @param {string} mimeType
 * @returns {string}
 */
function extensionForMime(mimeType) {
  switch ((mimeType || "").toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/svg+xml":
      return ".svg";
    case "image/avif":
      return ".avif";
    case "image/bmp":
      return ".bmp";
    default:
      return ".png";
  }
}

/**
 * Map an internal failure reason to the l10n id the panel shows for it.
 *
 * @param {string} reason
 * @returns {string}
 */
function reasonLabelId(reason) {
  switch (reason) {
    case "access-denied":
      return "sidebar-images-reason-access";
    case "timeout":
      return "sidebar-images-reason-timeout";
    case "too-large":
      return "sidebar-images-reason-too-large";
    case "bad-url":
      return "sidebar-images-reason-bad-url";
    default:
      return "sidebar-images-reason-write";
  }
}
