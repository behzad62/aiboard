# Account-backed providers

AI Board can use ChatGPT Plus/Pro and GitHub Copilot through the optional local account-provider bridge.

Start it with:

```bash
node lib/account-provider-runner.mjs
```

It prints a local URL and a local runner token. Paste those values into the ChatGPT Plus/Pro or GitHub Copilot provider settings, save, then use the login button in that provider tab.

The browser stores only the runner URL and runner token. Account authorization data is kept by the local bridge in the user's home folder.

Current limits:

- Text-only in the first release.
- Responses are returned as one chunk rather than true token streaming.
- Availability depends on the user's account entitlements and upstream account-provider behavior.
