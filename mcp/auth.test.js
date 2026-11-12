import test from "node:test";
import assert from "node:assert/strict";
import { validateBearerAuthorization } from "./auth.js";

test("bearer auth accepts the exact token", () => {
  assert.equal(validateBearerAuthorization("Bearer secret-token", "secret-token"), true);
  assert.equal(validateBearerAuthorization("bearer secret-token", "secret-token"), true);
});

test("bearer auth rejects missing, malformed, or wrong tokens", () => {
  assert.equal(validateBearerAuthorization(undefined, "secret-token"), false);
  assert.equal(validateBearerAuthorization("Basic secret-token", "secret-token"), false);
  assert.equal(validateBearerAuthorization("Bearer wrong-token", "secret-token"), false);
  assert.equal(validateBearerAuthorization("Bearer secret-token-extra", "secret-token"), false);
});

test("empty expected token keeps compatibility mode open", () => {
  assert.equal(validateBearerAuthorization(undefined, ""), true);
  assert.equal(validateBearerAuthorization("Bearer anything", ""), true);
});
