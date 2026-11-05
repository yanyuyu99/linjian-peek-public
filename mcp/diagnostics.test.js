import test from "node:test";
import assert from "node:assert/strict";
import { diagnosticResponseHeaders } from "./diagnostics.js";

test("diagnostic headers contain only the approved response header allowlist", () => {
  const headers = new Headers({
    server: "cloudflare",
    "cf-ray": "abc123",
    "rndr-id": "req-123",
    "retry-after": "30",
    "content-type": "application/json",
    "set-cookie": "secret=session",
    authorization: "Bearer secret",
    "x-auth-token": "secret"
  });

  const result = diagnosticResponseHeaders(headers);
  assert.deepEqual(Object.keys(result), ["server", "cf-ray", "rndr-id", "retry-after", "content-type"]);
  assert.deepEqual(result, {
    server: "cloudflare",
    "cf-ray": "abc123",
    "rndr-id": "req-123",
    "retry-after": "30",
    "content-type": "application/json"
  });
});

test("diagnostic headers tolerate missing response headers", () => {
  assert.deepEqual(diagnosticResponseHeaders(undefined), {
    server: null,
    "cf-ray": null,
    "rndr-id": null,
    "retry-after": null,
    "content-type": null
  });
});
