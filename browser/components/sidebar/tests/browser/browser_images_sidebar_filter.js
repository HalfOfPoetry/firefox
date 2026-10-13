/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { matchesFilters, normalizeFilters, DEFAULT_FILTERS } =
  ChromeUtils.importESModule(
    "chrome://browser/content/sidebar/sidebar-images-filter.mjs"
  );
const { reconcileImageSelection } = ChromeUtils.importESModule(
  "chrome://browser/content/sidebar/sidebar-images-filter.mjs"
);
const { reconcileImageItems } = ChromeUtils.importESModule(
  "chrome://browser/content/sidebar/sidebar-images-filter.mjs"
);

// The fixtures below are the same shape the panel's item objects have: the
// intrinsic (natural) pixel size and the byte size of the response body.
const PASS_BOTH = { width: 800, height: 600, bytes: 1440778 };
const PASS_SIZE_ONLY = { width: 400, height: 400, bytes: 1059 };
const PASS_BYTES_ONLY = { width: 100, height: 100, bytes: 30168 };
const EDGE_DIMENSION = { width: 200, height: 200, bytes: 120278 };
const EDGE_DIMENSION_UNDER = { width: 199, height: 200, bytes: 119678 };
const EDGE_BYTES = { width: 300, height: 300, bytes: 10240 };
const EDGE_BYTES_UNDER = { width: 300, height: 300, bytes: 10239 };
const UNKNOWN_BYTES = { width: 800, height: 600, bytes: -1 };
const FAILED_LOAD = { width: 0, height: 0, bytes: -1, error: true };

const defaults = normalizeFilters(DEFAULT_FILTERS);

add_task(function test_defaults_are_the_agreed_thresholds() {
  Assert.deepEqual(defaults, {
    sizeEnabled: true,
    width: 200,
    height: 200,
    bytesEnabled: true,
    bytes: 10240,
  });
});

add_task(function test_thresholds_combine_with_and() {
  Assert.ok(matchesFilters(PASS_BOTH, defaults), "both dimensions pass");
  Assert.ok(
    !matchesFilters(PASS_SIZE_ONLY, defaults),
    "size passes, bytes does not: must be excluded, not accepted"
  );
  Assert.ok(
    !matchesFilters(PASS_BYTES_ONLY, defaults),
    "bytes pass, size does not: must be excluded, not accepted"
  );
});

add_task(function test_bounds_are_inclusive() {
  Assert.ok(
    matchesFilters(EDGE_DIMENSION, defaults),
    "exactly 200x200 passes a 200 minimum"
  );
  Assert.ok(
    !matchesFilters(EDGE_DIMENSION_UNDER, defaults),
    "199 wide does not pass a 200 minimum"
  );
  Assert.ok(
    matchesFilters(EDGE_BYTES, defaults),
    "exactly 10240 bytes passes a 10240 minimum"
  );
  Assert.ok(
    !matchesFilters(EDGE_BYTES_UNDER, defaults),
    "10239 bytes does not pass a 10240 minimum"
  );
});

add_task(function test_unknown_byte_size_never_passes_the_byte_filter() {
  Assert.ok(
    !matchesFilters(UNKNOWN_BYTES, defaults),
    "an unmeasurable size is not silently treated as satisfying the threshold"
  );
});

add_task(function test_failed_load_is_never_listed_as_matching() {
  Assert.ok(!matchesFilters(FAILED_LOAD, defaults));
  Assert.ok(
    !matchesFilters(
      FAILED_LOAD,
      normalizeFilters({ width: null, height: null, bytes: null })
    ),
    "even with every threshold cleared, a resource that failed to load is not a match"
  );
});

add_task(function test_clearing_a_dimension_removes_it_from_the_decision() {
  let noSize = normalizeFilters({ ...defaults, sizeEnabled: false });
  Assert.ok(
    matchesFilters(PASS_BYTES_ONLY, noSize),
    "with the size dimension off, a 100x100 image still passes on bytes"
  );
  Assert.ok(
    !matchesFilters(PASS_SIZE_ONLY, noSize),
    "the byte threshold is still applied"
  );

  let noBytes = normalizeFilters({ ...defaults, bytesEnabled: false });
  Assert.ok(
    matchesFilters(PASS_SIZE_ONLY, noBytes),
    "with the byte dimension off, a 1059-byte image passes on size"
  );
  Assert.ok(
    matchesFilters(UNKNOWN_BYTES, noBytes),
    "byte size is not consulted at all once that dimension is off"
  );
  Assert.ok(
    !matchesFilters(PASS_BYTES_ONLY, noBytes),
    "the size thresholds are still applied"
  );
});

add_task(function test_an_empty_field_disables_only_that_field() {
  // Clearing the width box leaves the height and byte thresholds in force.
  let noWidth = normalizeFilters({ ...defaults, width: null });
  Assert.ok(matchesFilters({ width: 10, height: 600, bytes: 50000 }, noWidth));
  Assert.ok(
    !matchesFilters({ width: 800, height: 100, bytes: 50000 }, noWidth)
  );
  Assert.ok(!matchesFilters({ width: 800, height: 600, bytes: 10 }, noWidth));
});

add_task(function test_normalize_falls_back_on_unusable_values() {
  Assert.deepEqual(normalizeFilters(null), defaults);
  Assert.deepEqual(normalizeFilters("not an object"), defaults);
  Assert.deepEqual(normalizeFilters({ width: "abc" }), defaults);
  Assert.deepEqual(normalizeFilters({ width: "" }), {
    ...defaults,
    width: null,
  });
  Assert.deepEqual(normalizeFilters({ width: 0 }), { ...defaults, width: 0 });
});

add_task(
  function test_a_refresh_preserves_selection_when_items_are_reordered() {
    let selected = reconcileImageSelection(
      [{ url: "second" }, { url: "first" }],
      new Set(["first"])
    );
    Assert.deepEqual([...selected], ["first"]);
  }
);

add_task(function test_a_refresh_removes_only_images_no_longer_present() {
  let selected = reconcileImageSelection(
    [{ url: "kept" }, { url: "replacement" }],
    new Set(["kept", "removed"])
  );
  Assert.deepEqual([...selected], ["kept"]);
});

add_task(function test_a_refresh_does_not_restore_stale_urls() {
  let selected = reconcileImageSelection(
    [{ url: "current" }],
    new Set(["stale", "current"])
  );
  Assert.deepEqual([...selected], ["current"]);
});

add_task(function test_unrelated_refreshes_reuse_exact_image_rows() {
  let first = reconcileImageItems(
    [],
    [
      { url: "kept", width: 100, height: 50, bytes: -1, sizeSource: "" },
      {
        url: "also-kept",
        width: 20,
        height: 20,
        bytes: 12,
        sizeSource: "cache",
      },
    ]
  );
  Assert.deepEqual(first.added, ["kept", "also-kept"]);

  let second = reconcileImageItems(first.items, [
    { url: "also-kept", width: 20, height: 20, bytes: -1 },
    { url: "kept", width: 100, height: 50, bytes: -1 },
  ]);
  Assert.deepEqual(second.added, []);
  Assert.deepEqual(second.removed, []);
  Assert.deepEqual(second.updated, []);
  Assert.strictEqual(second.items[0], first.items[1]);
  Assert.strictEqual(second.items[1], first.items[0]);
  Assert.strictEqual(second.items[0].bytes, 12);
  Assert.strictEqual(second.items[0].sizeSource, "cache");
});

add_task(function test_a_metadata_change_updates_only_its_own_row() {
  let initial = reconcileImageItems(
    [],
    [
      {
        url: "first",
        width: 100,
        height: 100,
        bytes: 100,
        sizeSource: "cache",
      },
      {
        url: "second",
        width: 20,
        height: 20,
        bytes: 20,
        sizeSource: "cache",
      },
    ]
  );
  let changed = reconcileImageItems(initial.items, [
    initial.items[0],
    { url: "second", width: 25, height: 20, bytes: -1 },
  ]);

  Assert.deepEqual(changed.updated, ["second"]);
  Assert.strictEqual(changed.items[0], initial.items[0]);
  Assert.notStrictEqual(changed.items[1], initial.items[1]);
  Assert.strictEqual(changed.items[1].bytes, 20);
  Assert.strictEqual(changed.items[1].sizeSource, "cache");
});

add_task(function test_add_remove_and_measurement_recovery_are_incremental() {
  let initial = reconcileImageItems(
    [],
    [
      {
        url: "kept",
        width: 100,
        height: 100,
        bytes: 100,
        sizeSource: "cache",
      },
      {
        url: "removed",
        width: 20,
        height: 20,
        bytes: 20,
        sizeSource: "cache",
      },
    ]
  );
  initial.items[1].bytes = -1;
  initial.items[1].sizeSource = "";

  let changed = reconcileImageItems(initial.items, [
    initial.items[0],
    { url: "added", width: 30, height: 30, bytes: -1 },
  ]);

  Assert.deepEqual(changed.added, ["added"]);
  Assert.deepEqual(changed.removed, ["removed"]);
  Assert.deepEqual(changed.updated, []);
  Assert.strictEqual(changed.items[0], initial.items[0]);
  Assert.strictEqual(changed.items[1].bytes, -1);
  Assert.deepEqual(
    changed.items.filter(item => item.bytes < 0).map(item => item.url),
    ["added"]
  );
});

add_task(function test_a_large_list_touches_only_the_changed_resource() {
  let makeItem = index => ({
    url: `image-${index}`,
    width: index + 1,
    height: index + 2,
    bytes: index,
    sizeSource: "cache",
  });
  let initial = reconcileImageItems(
    [],
    Array.from({ length: 1000 }, (_, index) => makeItem(index))
  );
  let next = initial.items.map((item, index) =>
    index === 999 ? { ...item, width: item.width + 1, bytes: -1 } : item
  );
  let changed = reconcileImageItems(initial.items, next);

  Assert.deepEqual(changed.added, []);
  Assert.deepEqual(changed.removed, []);
  Assert.deepEqual(changed.updated, ["image-999"]);
  Assert.strictEqual(
    changed.items.filter((item, index) => item === initial.items[index]).length,
    999
  );
  Assert.notStrictEqual(changed.items[999], initial.items[999]);
});
