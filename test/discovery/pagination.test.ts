import test from "node:test";
import assert from "node:assert/strict";

import type { DiscoveryPaginationConfig } from "../../src/config/types.js";
import { appendPaginationCursor, readPaginationState } from "../../src/discovery/pagination.js";

const pagination: DiscoveryPaginationConfig = {
  enabled: true,
  cursorParam: "after",
  nextCursorField: "meta.next.cursor",
  hasMoreField: "meta.has_more",
};

test("pagination state treats non-boolean has_more as cursor-driven", () => {
  assert.deepEqual(
    readPaginationState(
      {
        meta: {
          has_more: "true",
          next: { cursor: "page-2" },
        },
      },
      pagination,
    ),
    { hasMore: true, nextCursor: "page-2" },
  );
});

test("pagination state ignores non-string nested cursors", () => {
  assert.deepEqual(
    readPaginationState(
      {
        meta: {
          has_more: true,
          next: { cursor: { value: "page-2" } },
        },
      },
      pagination,
    ),
    { hasMore: true, nextCursor: undefined },
  );
});

test("pagination cursor appending preserves reserved cursor characters", () => {
  assert.equal(
    appendPaginationCursor("https://api.example.invalid/v1/models?limit=10", "after", "next/page+1?x=1&y=2"),
    "https://api.example.invalid/v1/models?limit=10&after=next%2Fpage%2B1%3Fx%3D1%26y%3D2",
  );
});

test("readPaginationState rejects __proto__ path segments to prevent prototype pollution", () => {
  const protoPagination: DiscoveryPaginationConfig = {
    enabled: true,
    cursorParam: "after",
    nextCursorField: "__proto__.polluted",
    hasMoreField: "meta.has_more",
  };
  const beforePolluted = ({} as { polluted?: string }).polluted;
  assert.equal(beforePolluted, undefined, "baseline: Object.prototype not yet polluted");

  const state = readPaginationState({}, protoPagination);

  // Hardening: __proto__ segments must not traverse the prototype chain.
  assert.equal(state.nextCursor, undefined, "__proto__ segment must not yield a cursor");
  assert.equal(({} as { polluted?: string }).polluted, undefined, "Object.prototype must remain unmodified");
});

test("readPaginationState rejects constructor.prototype path segments", () => {
  const ctorPagination: DiscoveryPaginationConfig = {
    enabled: true,
    cursorParam: "after",
    nextCursorField: "constructor.prototype.polluted",
    hasMoreField: "meta.has_more",
  };

  const state = readPaginationState({}, ctorPagination);

  assert.equal(state.nextCursor, undefined, "constructor.prototype segment must not yield a cursor");
  assert.equal(({} as { polluted?: string }).polluted, undefined, "Object.prototype must remain unmodified via constructor");
});

test("readPaginationState rejects prototype path segments", () => {
  const protoSegmentPagination: DiscoveryPaginationConfig = {
    enabled: true,
    cursorParam: "after",
    nextCursorField: "prototype.value",
    hasMoreField: "meta.has_more",
  };

  const state = readPaginationState({ prototype: { value: "leak" } }, protoSegmentPagination);

  assert.equal(state.nextCursor, undefined, "prototype segment must not yield a cursor even if a property exists");
});

test("readPaginationState preserves normal nested pagination paths after hardening", () => {
  assert.deepEqual(
    readPaginationState(
      {
        meta: {
          has_more: false,
          next: { cursor: "page-9" },
        },
      },
      pagination,
    ),
    { hasMore: false, nextCursor: "page-9" },
  );
});
