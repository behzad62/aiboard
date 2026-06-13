# AI Board

A local-first web app where multiple AI models (OpenAI, Anthropic, Google Gemini) discuss a topic you provide, critique each other in structured rounds, and deliver a synthesized final answer—with live streaming and browser notifications when complete.

## Features

- **Multi-model discussions** — Select 2+ models to collaborate on your question
- **Discussion modes** — Collaborative Panel, Debate, Specialist + Reviewers
- **Effort levels** — Low (2 rounds), Medium (4 rounds), High (6+ rounds)
- **Live streaming** — Watch each model's response stream in real time via SSE
- **Convergence detection** — Consensus voting and stagnation detection stop early when ready
- **Judge synthesis** — A chosen model produces the final best answer with confidence score
- **Encrypted API keys** — Keys stored encrypted locally in JSON file store (AES-256-GCM)
- **Extensible providers** — Plugin architecture for adding more AI providers

## Prerequisites

- Node.js 20+ and npm
- API keys from at least two providers (OpenAI, Anthropic, Google Gemini, and/or OpenRouter)

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure encryption secret**

   Copy `.env.example` to `.env.local` and set a long random `ENCRYPTION_SECRET`:

   ```bash
   cp .env.example .env.local
   ```

   The template also sets `NEXT_TELEMETRY_DISABLED=1`, which opts this app out of Next.js telemetry.

3. **Run the dev server**

   ```bash
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000)

5. Go to **Settings** and add your API keys (OpenAI, Anthropic, Google Gemini, OpenRouter).

6. Return to the dashboard, enter a topic, select models and effort level, and click **Start Discussion**.

## Usage Example

**Topic:** "What are the BHPH math formulas used in Texas DMS systems?"

1. Select **Collaborative Panel** mode and **High** effort
2. Choose GPT-5.5, Claude Sonnet 4.6, and Gemini 3.5 Flash
3. Watch the live discussion across multiple rounds
4. Receive a browser notification when the judge delivers the final answer

## Project Structure

```
app/                  # Next.js pages and API routes
components/           # UI components
lib/
  db/                 # Local JSON file store and types
  crypto/             # API key encryption
  providers/          # OpenAI, Anthropic, Google, OpenRouter plugins
  orchestrator/       # Discussion engine, prompts, events
data/                 # Local data store (created at runtime)
```

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/discussions` | GET/POST | List or create discussions |
| `/api/discussions/[id]` | GET | Get discussion details |
| `/api/discussions/[id]/stream` | GET | SSE live event stream |
| `/api/discussions/[id]/start` | POST | Start orchestration |
| `/api/keys` | GET/POST | Manage encrypted API keys and defaults |
| `/api/providers/validate` | POST | Test an API key |

## Adding a New Provider

1. Create `lib/providers/your-provider.ts` implementing the `AIProvider` interface
2. Register it in `lib/providers/index.ts`
3. Add the provider ID to validation schemas in API routes

## Security Notes

- API keys are encrypted at rest and never returned to the browser after saving
- Set a strong `ENCRYPTION_SECRET` in production
- The app runs locally by default; your keys stay on your machine

## Telemetry

- Next.js telemetry is disabled for this project via `NEXT_TELEMETRY_DISABLED=1`

## License

MIT
