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
