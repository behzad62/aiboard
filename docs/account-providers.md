# Account-backed providers

AI Board can use ChatGPT Plus/Pro and GitHub Copilot through the optional local account-provider bridge.

## Hosted app users

Open the ChatGPT Plus/Pro or GitHub Copilot provider tab in Settings and click **Download account runner**. Save the downloaded file, then run it locally:

```bash
node account-provider-runner.mjs
```

It prints a local URL and a local runner token. Paste those values into provider settings, save, then use the login button in that provider tab.

## Repository users

When working from a clone, you can also run the source copy directly:

```bash
node lib/account-provider-runner.mjs
```

`npm run dev` and `npm run build` copy this file to `public/account-provider-runner.mjs`, so static deployments can serve it at `/account-provider-runner.mjs`.

The browser stores only the runner URL and runner token. Account authorization data is kept by the local bridge in the user's home folder.

Current limits:

- Text-only in the first release.
- Responses are returned as one chunk rather than true token streaming.
- Availability depends on the user's account entitlements and upstream account-provider behavior.
