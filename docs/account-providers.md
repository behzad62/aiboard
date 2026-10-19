# Account-backed providers

AI Board can use ChatGPT Plus/Pro and GitHub Copilot through the optional local account-provider bridge.

Runner v28 preserves provider-reported input/output, cache, and reasoning usage,
including Copilot SDK calls made during a tool loop. Subscription price fields
show API-equivalent comparison rates, not charges against your subscription.

## Hosted app users

Open the ChatGPT subscription, GitHub Copilot, or NVIDIA NIM provider settings and
click **Download account runner v28 (ZIP)**. Every button downloads the same
package. Extract it, open a terminal in that directory, install once, then start:

```powershell
npm install
npm start
```

Extract the full package into its own directory, separate from Runner V2. Keep
the account runner and its Copilot helper together. Runner v28 pins the SDK and
CLI versions to the tested combination, so fresh installs cannot silently pick
an incompatible newer CLI. If an old folder reports a missing SDK or an outdated
helper, replace it with the full current Copilot package and install again.
Restarting creates a new runner session token: save that token in every provider
using the runner. This token is separate from the saved GitHub authorization.

It prints a local URL and a local runner token. Reuse that same URL and token in
each provider's settings and save. Only one runner process is needed. ChatGPT and
GitHub still have separate sign-in buttons and account permissions.

## Repository users

When working from a clone, you can also run the source copy directly:

```bash
node lib/account-provider-runner.mjs
```

`npm run dev` and `npm run build` publish both the compatibility source at
`/account-provider-runner.mjs` and the supported installable package at
`/aiboard-account-provider-runner.zip`.

The browser stores only the runner URL and runner token. Account authorization data is kept by the local bridge in the user's home folder.

## ChatGPT plan sign-in (runner v25+)

ChatGPT subscription mode uses OpenAI's public `https://api.openai.com/v1/models`
and `/responses` endpoints with an OAuth token authorized for ChatGPT plan usage.
It does not need an OpenAI API key or borrow a credential from API key mode.

1. Download and extract the updated account runner package, stop the previous runner, then run npm install and npm start in the package folder.
2. Save its URL and new local session token in AI Board.
3. Select **Continue with ChatGPT** and approve AI Board's ChatGPT plan usage permission.
4. Return to Settings, refresh the catalog, select a model, and test the connection.

Older Codex account credentials cannot be reused for the public API. They remain
preserved locally; the upgraded runner asks for a new sign-in instead of sending
them to the API or falling back to API billing.

The runner registers AI Board with OpenAI using `dynamic_agent_client`, persists
a stable host ID, and saves each issued client ID with its verified account
identity. Returning sign-ins reuse that registration. The account selector can
continue a saved account or add another account/workspace. ID tokens are verified
against the issuer's signing keys, audience, expiry, and sign-in nonce before
credentials become active. Rotating refreshes are serialized and saved atomically.
OAuth credentials remain in the local runner file, never in browser storage.

Identity sign-in alone does not enable inference: `chatgpt.tokens.use.direct`
must be granted. Users can manage app limits and access in
[ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).
See OpenAI's [registration guide](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
and [model/inference contract](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

Current limits:

- Availability depends on the user's account entitlements and upstream account-provider behavior.
- ChatGPT discovery uses the signed-in account's public API catalog, preserving upstream visibility. It is not a guarantee of access to every OpenAI API model. OpenAI checks each request; manually adding an id does not extend account permissions.
- ChatGPT plan mode supports model-compatible images/files, Responses streaming, structured output, reasoning effort, and native Build function calls grouped in a namespace. It omits temperature and max-token caps, which are unsupported on this subscription route. Success requires `response.completed`; failed, incomplete, or interrupted streams are errors.
- GitHub Copilot account mode uses the official Copilot SDK for discussion calls, including `web_search`/`web_fetch` through Copilot's Bing integration, reasoning effort, and model-owned limits. Structured output and attachments use the compatible raw account route; Build mode always uses that raw route so Runner V2 retains tool and permission ownership. GPT and Gemini 3.5 Flash advertise reasoning; Claude chat-completions does not.
