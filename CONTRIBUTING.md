# Contributing

Thanks for your interest in improving **Cloudflare DDNS UI**! Bug reports, feature ideas, and pull
requests are all welcome.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs & requesting features

Please use the issue templates (**New issue** → *Bug report* / *Feature request*). When filing a bug,
**redact any Cloudflare tokens, webhook URLs, and passwords** from logs and screenshots.

For anything more than a trivial fix, please open an issue to discuss it before starting work — it
saves everyone time.

## Development setup

Requires **Node.js 20+**.

```bash
git clone https://github.com/mansoor/cloudflare-ddns-ui.git
cd cloudflare-ddns-ui
npm install
npm run build:css      # compile Tailwind -> public/app.css
npm run dev            # starts on http://localhost:8080 (auto-reload + pretty logs)
```

Set an admin password so you don't have to fish it out of the logs each restart:

```bash
ADMIN_PASSWORD=dev npm run dev
```

While working on the UI, keep Tailwind rebuilding in a second terminal:

```bash
npm run watch:css
```

Prefer Docker? `docker compose up --build` builds and runs the container the same way CI does.

## Project layout

| Path | What's there |
|---|---|
| `src/` | Fastify server, updater engine, Cloudflare/IP/notify clients, scheduler, routes |
| `web/` | Tailwind UI — `index.html`, `login.html`, `js/app.js`, `css/tailwind.src.css` |
| `.github/workflows/` | CI that builds and publishes the Docker image to GHCR on `v*` tags |

See the **How it works** section of the [README](README.md) for a fuller map.

## Pull request workflow

`main` is protected — all changes land through a pull request.

1. **Fork** the repo (external contributors) or create a **branch** (collaborators):
   `git checkout -b my-change`
2. Make your change. If you touched anything under `web/`, **rebuild the CSS**: `npm run build:css`.
3. **Verify it works** — run `npm run dev` (or `docker compose up --build`) and exercise the affected
   flow in the browser, not just a syntax check.
4. Keep the PR focused and reasonably small; unrelated changes belong in separate PRs.
5. Open the PR against `main` and fill out the PR template.

### Coding style

- Match the surrounding code — it's plain ESM JavaScript, 2-space indent, no build step for the
  front-end (vanilla JS + `fetch`).
- No secrets in the diff. `data/`, `.env`, `node_modules/`, and `public/app.css` are gitignored;
  keep it that way.
- Commit messages: short imperative subject (e.g. `Fix WAF list pagination`), details in the body if
  needed.

## Questions

Not sure about something? Open an issue and ask — happy to help.
