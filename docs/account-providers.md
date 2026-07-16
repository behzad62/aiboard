# Account-backed providers

AI Board can use ChatGPT Plus/Pro and GitHub Copilot through the optional local account-provider bridge.

## Hosted app users

Open the ChatGPT Plus/Pro, GitHub Copilot, or NVIDIA NIM provider tab in Settings and click **Download account runner**.

For ChatGPT and NVIDIA, the button downloads the standalone runner script. Run it with Node:

```powershell
node account-provider-runner.mjs
```

For GitHub Copilot, the button downloads the SDK runner package. Extract the ZIP, open a terminal in that directory, install its dependencies, then start it locally:

```powershell
npm install
npm start
```

It prints a local URL and a local runner token. Paste those values into provider settings, save, then use the login button in that provider tab.

## Repository users

When working from a clone, you can also run the source copy directly:

```bash
node lib/account-provider-runner.mjs
```

`npm run dev` and `npm run build` publish both the compatibility source at
`/account-provider-runner.mjs` and the supported installable package at
`/aiboard-account-provider-runner.zip`.

The browser stores only the runner URL and runner token. Account authorization data is kept by the local bridge in the user's home folder.

Current limits:

- Availability depends on the user's account entitlements and upstream account-provider behavior.
- ChatGPT account mode supports image attachments, text-readable documents, raw document files, Responses streaming, structured output, reasoning effort, and native Build tool calls through the runner. It intentionally does not send max-token caps because the ChatGPT Codex account backend rejects `max_output_tokens`.
- GitHub Copilot account mode uses the official Copilot SDK for discussion calls, including `web_search`/`web_fetch` through Copilot's Bing integration, reasoning effort, and model-owned limits. Structured output and attachments use the compatible raw account route; Build mode always uses that raw route so Runner V2 retains tool and permission ownership. GPT and Gemini 3.5 Flash advertise reasoning; Claude chat-completions does not.
