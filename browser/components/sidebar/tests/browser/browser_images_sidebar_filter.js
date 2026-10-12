/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { matchesFilters, normalizeFilters, DEFAULT_FILTERS } =
  ChromeUtils.importESModule(
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
