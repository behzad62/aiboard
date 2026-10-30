# R4e — Relay signing-key rotation (design, architect 2026-10-30)

## Today
- The relay holds two Ed25519 keys: the **root key** (signs pairing session envelopes; its public key is pinned in the Runner, `runner-v2/src/remote-relay-roots.ts`) and the **signing key** (signs every device challenge and every per-request authorization).
- At pairing the Runner stores a root-signed session whose `relayKeys` lists the signing key. From then on `RemoteAuthenticator.answerChallenge` and the authorization check accept only keys in `session.relayKeys`.
- Changing the signing key on the relay therefore locks out every paired device until it pairs again. That is the gap.

## Design: a root-signed key set in every challenge
The relay attaches a key-set statement, signed by the root key, to every `challenge` frame:

```json
{ "type": "challenge", "challenge": { ... }, "keyId": "<signing key id>", "signature": "<challenge sig>",
  "keySet": { "statement": { "relayOrigin": "https://mcp.aiboard.me", "keys": [{ "keyId": "...", "publicKey": "<SPKI base64url>" }],
                             "issuedAt": "<ISO>", "expiresAt": "<ISO>" },
              "rootKeyId": "<root key id>", "signature": "<Ed25519 over canonicalJson(statement)>" } }
```

**Relay side:**
- The statement lists the active signing key, and optionally a previous key while an operator overlaps two.
- It is re-signed when it is older than 1 hour, and is valid for 24 hours.

**Runner side, in `answerChallenge`, when `keySet` is present:**
1. Verify the statement against the pinned roots for `session.relayOrigin`.
2. Validate it:
   - `relayOrigin` equals `session.relayOrigin`;
   - `issuedAt` is at most 5 minutes in the future and `expiresAt` is after now;
   - `expiresAt - issuedAt` is at most 7 days;
   - there are 1–8 keys with unique ids, each a valid Ed25519 SPKI;
   - **monotonic:** `issuedAt` is no earlier than the stored `relayKeysIssuedAt`, which defaults to `session.issuedAt`.
3. Verify the challenge signature against the statement's keys.
4. Once both signatures verify, persist the statement's keys and `issuedAt` as the session's `relayKeys` / `relayKeysIssuedAt`. Per-request authorizations then verify against the new key too.

**Failure handling:**
- A `keySet` that is present but invalid fails closed: the device answers no proof, and the attempt counts as `authentication_failed`.
- A challenge with no `keySet` keeps today's behaviour (older relays).

## Properties
- **Offline devices:** a device that was offline during a rotation recovers on its next connect, because the new statement arrives with the challenge it has to verify.
- **Leaked old signing key:** it stays usable only against a Runner that has not connected since the rotation, and only until the newest statement listing that key expires (≤24 h). After one connect, monotonic `issuedAt` locks the old set out.
- **Root key:** this protects against a leak of the signing key only, not of the root key. The root key is already online in the relay for pairing, so a full relay compromise is still the root-rotation case (a new Runner release with new pins). That procedure is out of scope here and stays documented in Q1.
- **What the Runner stores:** never anything that was not root-signed.

## Operator procedure (staging, then production)
1. On the VPS, generate a new signing key file. `deploy/setup-host.sh` already generates keys, so reuse its function.
2. Set the new key file and `RELAY_SIGNING_KEY_ID` in the env file, and redeploy the same image digest.
3. Devices reconnect, verify the new statement, and persist the new key.
4. Remove the old key file.

No device re-pairing is needed.

## Tests (must exist before DoD)
**Runner:**
- A rotated key with a valid statement is accepted and persisted, and later authorizations signed by the new key verify.
- An invalid statement fails closed; the cases are:
  - signed by a non-root key;
  - wrong origin;
  - expired;
  - lifetime over 7 days;
  - duplicate key ids;
  - older than the stored statement (replay of the pre-rotation set);
  - challenge signed by a key that is not in the statement.
- Without `keySet`, the old path still works.

**Relay:**
- The statement is attached and verifies under the root public key.
- It is re-signed once it is older than 1 hour.
- The configuration refuses a root key equal to a signing key (this already exists for the single key).

**Interop:** a Runner paired under key A connects after the relay restarts with key B, without re-pairing, and a stale statement replay is refused.
