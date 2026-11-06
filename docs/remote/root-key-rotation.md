# Rotating the relay root key

The root key signs pairing sessions and the list of signing keys in every device challenge. Its public half is pinned inside the Runner, in `runner-v2/src/remote-relay-roots.ts`, so changing it always takes a Runner release. To change only the signing key, use the shorter procedure in the aiboard-tunnel `deploy/README.md`; no release is needed.

Use the planned rotation unless the key may have leaked.

## What was drilled

On 2026-11-05 the real Runner connector and transport ran against the real relay device route on this PC, with the pins and relay keys of each step below. Every result matched this page, including devices keeping their pairing.

This has not been run on staging or production, or through a real Runner release. Do the first one on staging.

| Relay signs with | Runner pins | Result |
|---|---|---|
| old root | old | Connects |
| old root | old and new | Connects |
| new root and new signing key | old and new | Connects, no re-pair |
| new root | old only | Refused |
| new root | new only | Connects, no re-pair |
| **old root, leaked** | **old and new** | **Connects: the overlap trusts the attacker** |
| **old root, leaked** | **old only** | **Connects: an old Runner trusts the attacker** |
| old root, leaked | new only | Refused |

## Planned rotation

No outage for Runners that update in time. Runners that don't update are refused at step 4, and connect again after `aiboard update`.

1. Generate the new key offline, not on the VPS, from an aiboard-tunnel checkout:
   ```bash
   umask 077
   ```
   ```bash
   openssl genpkey -algorithm ED25519 -out relay-root-key.pem
   ```
   ```bash
   node packages/relay/dist/src/cli.js print-public-key --key-file relay-root-key.pem
   ```
2. Add the new key beside the old one in `remote-relay-roots.ts`, with a new key id. Merge and release the Runner through the normal signed release.
3. Give Runners time to update, and tell users to. Nothing shows Runner versions across accounts yet, so you can't count who has updated.
4. Put the new key at `/etc/aiboard/relay-root-key.pem` on the host, owned by root and mode `0600`, and copy it into the data volume with the same ownership and mode as the signing key. Set `RELAY_ROOT_KEY_FILE` and `RELAY_ROOT_KEY_ID` in the target's env file, then redeploy the same image digest with **Deploy relay**. Check `/readyz`, and that a Runner reconnects without pairing.
5. Pair a new device to confirm the pairing session verifies under the new root.
6. Release a Runner that pins only the new key, then remove the old key file and every copy of it.

Do this on staging first, using the `https://mcp-staging.aiboard.me` pins.

## After a leak

Treat this as a user-facing incident. Whoever holds the old root can sign key sets, so **any Runner that still pins it will trust them**, and the overlap above can't be used. The attacker also needs to reach those Runners as the relay, by compromising the relay or intercepting its traffic. An attacker who took the root key from the relay itself may already have that.

The relay can't take trust away from an installed Runner. Only an update removes the old pin, and nothing forces an update. Users have to be told.

1. If the relay itself may be compromised, use the emergency stop (`POST /admin/v2/disable` in `deploy/README.md`) first. It's held in memory, so **a restart or redeploy undoes it**. To stay stopped across one, block traffic outside the relay as well, at Nginx or Cloudflare.
2. Generate a new root key offline and a new signing key. Don't reuse anything that was on the host.
3. Pin **only the new key** in `remote-relay-roots.ts`, and publish a signed Runner release. Release signing uses separate keys, so it's unaffected unless those leaked too.
4. Move the relay to the new root and signing keys and redeploy, then lift any block. Existing Runners are refused from this point.
5. Tell every account: run `aiboard update`. Say what happened, what was at risk, and that a Runner which hasn't updated must not be started until it has. Devices keep their pairing after updating.
6. Remove every copy of the old keys, including backups of `/etc/aiboard/keys`.
7. If the relay was compromised, also rotate what lived beside the key: the admin credential, the OAuth keys, the sign-in provider secrets, and the Paddle and Azure credentials.

## Known limits

- Old Runners stay exposed until updated, as above. A Runner has no way to learn that a pinned key has been withdrawn.
- The root key is online in the relay for pairing, so a full relay compromise reaches it. Threat matrix row 11 records the owner's decision on this for the beta.
- Staging and production have separate root keys, but both are on one VPS.
