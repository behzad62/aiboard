import assert from "node:assert/strict";
import test from "node:test";

import { redactSensitiveText, redactSensitiveValue } from "../src/sensitive-redaction.js";

test("redacts common credential keys across nested objects, arrays, argv, and env forms", () => {
  const redacted = redactSensitiveValue({
    access_token: "object-access-secret",
    refreshToken: "object-refresh-secret",
    "id-token": "object-id-secret",
    clientSecret: "object-client-secret",
    api_token: "object-api-token-secret",
    apiKey: "object-api-key-secret",
    private_key: "object-private-secret",
    privateKey: "object-private-camel-secret",
    password: "object-password-secret",
    passwd: "object-passwd-secret",
    passphrase: "object-passphrase-secret",
    authorization: "object-authorization-secret",
    auth_credentials: "object-auth-secret",
    nested: [{ ACCESS_TOKEN: "nested-access-secret", CLIENT_SECRET: "nested-client-secret" }],
    argv: [
      "--access-token", "argv-access-secret",
      "--client-secret=argv-client-secret",
      "--apiKey", "argv-api-key-secret",
      "--safe", "visible",
    ],
    env: { ACCESS_TOKEN: "env-access-secret", CLIENT_SECRET: "env-client-secret", SAFE: "visible" },
    secretary: "visible-secretary",
    tokenizer: "visible-tokenizer",
  });
  const encoded = JSON.stringify(redacted);
  for (const secret of [
    "object-access-secret", "object-refresh-secret", "object-id-secret", "object-client-secret",
    "object-api-token-secret", "object-api-key-secret", "object-private-secret",
    "object-private-camel-secret", "object-password-secret", "object-passwd-secret",
    "object-passphrase-secret", "object-authorization-secret", "object-auth-secret",
    "nested-access-secret", "nested-client-secret", "argv-access-secret", "argv-client-secret",
    "argv-api-key-secret", "env-access-secret", "env-client-secret",
  ]) assert.doesNotMatch(encoded, new RegExp(secret));
  assert.match(encoded, /visible-secretary/);
  assert.match(encoded, /visible-tokenizer/);
  assert.match(encoded, /visible/);
});

test("redacts assignments, URL query keys, URL credentials, bearer values, and changed paths", () => {
  const input = [
    "access_token=text-access-secret",
    "client-secret: text-client-secret",
    "refreshToken text-refresh-secret",
    "private_key=text-private-secret",
    "Authorization: Bearer header-secret",
    "https://url-user:url-password@example.test/run?access_token=query-access-secret&client_secret=query-client-secret&safe=visible",
    "access_token=changed-path-secret.txt",
    "secretary=visible-secretary",
    "tokenizer=visible-tokenizer",
  ].join(" ");
  const redacted = redactSensitiveText(input);
  for (const secret of [
    "text-access-secret", "text-client-secret", "text-refresh-secret", "text-private-secret",
    "header-secret", "url-user", "url-password", "query-access-secret", "query-client-secret",
    "changed-path-secret",
  ]) assert.doesNotMatch(redacted, new RegExp(secret));
  assert.match(redacted, /access_token=\[REDACTED\]/);
  assert.match(redacted, /client-secret=\[REDACTED\]/);
  assert.match(redacted, /refreshToken=\[REDACTED\]/);
  assert.match(redacted, /private_key=\[REDACTED\]/);
  assert.match(redacted, /safe=visible/);
  assert.match(redacted, /secretary=visible-secretary/);
  assert.match(redacted, /tokenizer=visible-tokenizer/);
  assert.equal(redactSensitiveText(redacted), redacted);
});

test("redacts complete JSON objects and arrays without producing malformed JSON", () => {
  const objectInput = JSON.stringify({
    access_token: "JSON_ACCESS_SECRET",
    clientSecret: "JSON_CLIENT_SECRET",
    nested: [{ refresh_token: "JSON_REFRESH_SECRET", privateKey: 42 }],
    escaped: { api_token: "quote-\"slash-\\-secret" },
    safe: { secretary: "visible-secretary", tokenizer: "visible-tokenizer" },
  });
  const objectText = redactSensitiveText(objectInput);
  const object = JSON.parse(objectText) as Record<string, unknown>;
  assert.equal(object.access_token, "[REDACTED]");
  assert.equal(object.clientSecret, "[REDACTED]");
  assert.doesNotMatch(objectText, /JSON_ACCESS_SECRET|JSON_CLIENT_SECRET|JSON_REFRESH_SECRET|slash-/);
  assert.match(objectText, /visible-secretary/);
  assert.match(objectText, /visible-tokenizer/);

  const arrayInput = JSON.stringify([
    { id_token: "JSON_ID_SECRET" },
    ["--client-secret", "JSON_ARGV_SECRET"],
    { safe: "visible" },
  ]);
  const arrayText = redactSensitiveText(arrayInput);
  assert.deepEqual(JSON.parse(arrayText), [
    { id_token: "[REDACTED]" },
    ["--client-secret", "[REDACTED]"],
    { safe: "visible" },
  ]);
  assert.doesNotMatch(arrayText, /JSON_ID_SECRET|JSON_ARGV_SECRET/);
  assert.equal(redactSensitiveText(objectText), objectText);
  assert.ok(redactSensitiveText(objectInput, 48).length <= 48);
});

test("redacts safely parseable JSON containers and quoted properties embedded in diagnostic text", () => {
  const input = [
    "prefix",
    'payload={"access_token":"EMBEDDED_ACCESS_SECRET","nested":[{"client_secret":false}],"safe":"visible"}',
    'fragment "api_token":"EMBEDDED_API_SECRET" after',
    'escaped "private_key":"quote-\\\"secret" tail',
    'invalid-json {"safe":"unchanged"',
    'secretary="visible-secretary" tokenizer="visible-tokenizer"',
  ].join(" | ");
  const redacted = redactSensitiveText(input);
  assert.doesNotMatch(redacted, /EMBEDDED_ACCESS_SECRET|EMBEDDED_API_SECRET|quote-/);
  assert.match(redacted, /payload=\{"access_token":"\[REDACTED\]","nested":\[\{"client_secret":"\[REDACTED\]"\}\],"safe":"visible"\}/);
  assert.match(redacted, /"api_token":"\[REDACTED\]"/);
  assert.match(redacted, /invalid-json \{"safe":"unchanged"/);
  assert.match(redacted, /visible-secretary/);
  assert.match(redacted, /visible-tokenizer/);
  assert.equal(redactSensitiveText(redacted), redacted);
});

test("redacts an embedded sensitive JSON object value without corrupting surrounding text", () => {
  const input = 'before "clientSecret":{"nested":{"value":"OBJECT_SECRET","escaped":"quote-\\\"secret"}} after';
  const redacted = redactSensitiveText(input);
  assert.equal(redacted, 'before "clientSecret":"[REDACTED]" after');
  assert.doesNotMatch(redacted, /OBJECT_SECRET|quote-/);
  assert.equal(redactSensitiveText(redacted), redacted);
});

test("redacts an embedded sensitive JSON array value including nested containers", () => {
  const input = 'before "access_token":["ARRAY_SECRET",{"nested":["NESTED_ARRAY_SECRET"]}] after';
  const redacted = redactSensitiveText(input);
  assert.equal(redacted, 'before "access_token":"[REDACTED]" after');
  assert.doesNotMatch(redacted, /ARRAY_SECRET|NESTED_ARRAY_SECRET/);
  assert.equal(redactSensitiveText(redacted), redacted);
});

test("unrelated malformed container prefixes cannot exhaust later sensitive-property redaction", () => {
  const input = `${"{".repeat(65)} diagnostic "access_token":{"value":"LATE_SECRET"} tail`;
  const redacted = redactSensitiveText(input);
  assert.doesNotMatch(redacted, /LATE_SECRET/);
  assert.match(redacted, /"access_token":"\[REDACTED\]" tail$/);
  assert.equal(redactSensitiveText(redacted), redacted);
});

test("an unmatched quote prefix cannot hide a later sensitive property", () => {
  const input = 'prefix "noise diagnostic "access_token":{"value":"ODD_QUOTE_SECRET"} tail';
  const redacted = redactSensitiveText(input);
  assert.equal(redacted, 'prefix "noise diagnostic "access_token":"[REDACTED]" tail');
  assert.doesNotMatch(redacted, /ODD_QUOTE_SECRET/);
  assert.equal(redactSensitiveText(redacted), redacted);
});

test("redacts a JSON-encoded object string with scalar, object, array, and multiple sensitive keys", () => {
  const literal = JSON.stringify(JSON.stringify({
    access_token: "ENCODED_ACCESS_SECRET",
    clientSecret: { value: "ENCODED_OBJECT_SECRET" },
    refresh_token: ["ENCODED_ARRAY_SECRET", { nested: "ENCODED_NESTED_SECRET" }],
    safe: { secretary: "visible-secretary", tokenizer: "visible-tokenizer" },
  }));
  const redacted = redactSensitiveText(`payload=${literal} tail`);
  const encoded = redacted.slice("payload=".length, -" tail".length);
  const decoded = JSON.parse(JSON.parse(encoded) as string) as Record<string, unknown>;
  assert.equal(decoded.access_token, "[REDACTED]");
  assert.equal(decoded.clientSecret, "[REDACTED]");
  assert.equal(decoded.refresh_token, "[REDACTED]");
  assert.doesNotMatch(redacted, /ENCODED_(?:ACCESS|OBJECT|ARRAY|NESTED)_SECRET/);
  assert.match(redacted, /visible-secretary/);
  assert.match(redacted, /visible-tokenizer/);
  assert.equal(redactSensitiveText(redacted), redacted);
});

test("recursively redacts nested JSON string literals and preserves valid encoding", () => {
  const objectText = JSON.stringify({ id_token: "NESTED_ENCODED_SECRET", safe: "visible" });
  const nestedLiteral = JSON.stringify(JSON.stringify(JSON.stringify(objectText)));
  const redacted = redactSensitiveText(`payload=${nestedLiteral} tail`);
  const outer = redacted.slice("payload=".length, -" tail".length);
  const decodedObject = JSON.parse(JSON.parse(JSON.parse(JSON.parse(outer) as string) as string) as string) as Record<string, unknown>;
  assert.equal(decodedObject.id_token, "[REDACTED]");
  assert.equal(decodedObject.safe, "visible");
  assert.doesNotMatch(redacted, /NESTED_ENCODED_SECRET/);
  assert.equal(redactSensitiveText(redacted), redacted);
});

test("deep JSON string encoding fails closed at the recursion bound", () => {
  let encoded = JSON.stringify({ access_token: "DEPTH_BOUND_SECRET" });
  for (let depth = 0; depth < 12; depth += 1) encoded = JSON.stringify(encoded);
  const redacted = redactSensitiveText(encoded);
  assert.doesNotMatch(redacted, /DEPTH_BOUND_SECRET/);
  assert.match(redacted, /\[REDACTED\]/);
  assert.equal(redactSensitiveText(redacted), redacted);
});

test("deep JSON string inspection preserves documented non-sensitive keys", () => {
  let encoded = JSON.stringify({ secretary: "visible-secretary", tokenizer: "visible-tokenizer" });
  for (let depth = 0; depth < 12; depth += 1) encoded = JSON.stringify(encoded);
  const redacted = redactSensitiveText(encoded);
  assert.match(redacted, /visible-secretary/);
  assert.match(redacted, /visible-tokenizer/);
  assert.equal(redactSensitiveText(redacted), redacted);
});

test("an unmatched quote prefix cannot hide a later JSON-encoded literal", () => {
  const literal = JSON.stringify(JSON.stringify({ access_token: "ODD_ENCODED_SECRET" }));
  const redacted = redactSensitiveText(`prefix "noise payload=${literal} tail`);
  assert.doesNotMatch(redacted, /ODD_ENCODED_SECRET/);
  assert.match(redacted, /\[REDACTED\]/);
  assert.equal(redactSensitiveText(redacted), redacted);
});

test("redacts a raw one-layer JSON-string-content fragment", () => {
  const input = String.raw`payload={\"access_token\":\"SLASH_SECRET\"} tail`;
  const redacted = redactSensitiveText(input);
  assert.equal(redacted, String.raw`payload={\"access_token\":\"[REDACTED]\"} tail`);
  assert.doesNotMatch(redacted, /SLASH_SECRET/);
  assert.equal(redactSensitiveText(redacted), redacted);
});

test("redacts raw escaped fragments inside a single-quote wrapper", () => {
  const input = String.raw`'payload={\"clientSecret\":{\"value\":\"SINGLE_RAW_SECRET\"}}' tail`;
  const redacted = redactSensitiveText(input);
  assert.doesNotMatch(redacted, /SINGLE_RAW_SECRET/);
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /^'payload=/);
  assert.match(redacted, /' tail$/);
  assert.equal(redactSensitiveText(redacted), redacted);
});

test("redacts raw escaped object, array, argv, and multiple-key values", () => {
  const input = String.raw`payload=[{\"access_token\":\"RAW_OBJECT_SECRET\",\"clientSecret\":{\"value\":\"RAW_NESTED_SECRET\"}},[\"--private-key\",\"RAW_ARGV_SECRET\"],{\"refresh_token\":[\"RAW_ARRAY_SECRET\"]}] tail`;
  const redacted = redactSensitiveText(input);
  assert.doesNotMatch(redacted, /RAW_(?:OBJECT|NESTED|ARGV|ARRAY)_SECRET/);
  assert.match(redacted, /\[REDACTED\]/);
  assert.equal(redactSensitiveText(redacted), redacted);
});

test("redacts even and odd nested backslash escape layers", () => {
  const variants = [
    [String.raw`payload={\\\"access_token\\\":\\\"ODD_SLASH_SECRET\\\"}`, "ODD_SLASH_SECRET"],
    [String.raw`payload={\\"access_token\\":\\"EVEN_SLASH_SECRET\\"}`, "EVEN_SLASH_SECRET"],
  ] as const;
  for (const [input, secret] of variants) {
    const redacted = redactSensitiveText(input);
    assert.doesNotMatch(redacted, new RegExp(secret));
    assert.match(redacted, /\[REDACTED\]/);
    assert.equal(redactSensitiveText(redacted), redacted);
  }
});

test("an unmatched quote cannot hide a later raw escaped fragment", () => {
  const input = String.raw`prefix "noise payload={\"access_token\":\"ODD_QUOTE_RAW_SECRET\"} tail`;
  const redacted = redactSensitiveText(input);
  assert.doesNotMatch(redacted, /ODD_QUOTE_RAW_SECRET/);
  assert.match(redacted, /\[REDACTED\]/);
  assert.equal(redactSensitiveText(redacted), redacted);
});

test("malformed brace prefixes cannot exhaust later raw escaped redaction", () => {
  const input = `${"{".repeat(65)} ${String.raw`payload={\"access_token\":\"LATE_RAW_SECRET\"} tail`}`;
  const redacted = redactSensitiveText(input);
  assert.doesNotMatch(redacted, /LATE_RAW_SECRET/);
  assert.match(redacted, /\[REDACTED\]/);
  assert.equal(redactSensitiveText(redacted), redacted);
});

test("an indeterminate malformed raw fragment fails closed", () => {
  const input = String.raw`prefix \q payload={\"access_token\":BROKEN_RAW_SECRET tail`;
  const redacted = redactSensitiveText(input);
  assert.equal(redacted, "[REDACTED]");
  assert.doesNotMatch(redacted, /BROKEN_RAW_SECRET/);
  assert.equal(redactSensitiveText(redacted), redacted);
});
