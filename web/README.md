# IFSO website

Next.js 16 (App Router, Turbopack), React 19 and Tailwind 4. The landing pages, the editorial pages and the motion are the
website team's design; the dashboard, the claim page and the wallet-link page are wired to the IFSO API.

## Run

```bash
cd web
bun install            # Node 20.19 or newer
cp .env.example .env   # set NEXT_PUBLIC_API_URL to a running API
bun run dev            # http://localhost:3000
bun run build && bun run test
```

`bun run sync:client` copies `app/src/client` and the core modules it imports into `src/vendor/ifso`, so `web/` builds on
its own (Vercel uses `web/` as the project root). CI fails if the copy is behind.

## Routes

| Route | What it is |
|---|---|
| `/`, `/how-it-works`, `/conditions`, `/technology`, `/pricing`, `/privacy-policy`, `/terms`, `/risks` | Content pages |
| `/dashboard` | Create a payment, drafts (browser only), sent and received, approvals and referee decisions, refunds and refund redirects, settings |
| `/c/<id>#1.<secret>` | Claim page. Strict CSP, no third-party code, the secret never leaves the browser |
| `/link#<token>` | Links a wallet to a Telegram account (the bot's `/link` button). Same rules as the claim page |
| `/create` | Redirects to the dashboard composer |

## How it is wired

- One API client (`src/lib/ifso/api.ts`) over the tRPC HTTP protocol, called from the visitor's browser (the country comes from
  the request's edge headers). Shapes are in `FRONTEND.md` at the repository root.
- Create: the secret is made in the browser, `build` returns the exact terms and typed data, `verifyBuildAnswer` checks them,
  the wallet signs what `build` returned (one signature), `submit` relays it, then the share sheet shows the claim link.
  Questions the parser asks (direction, weekend close, team, deadline) are answered with buttons; nothing is built while one is open.
- Claim: the link fragment is moved out of the address bar by a script in `<head>` before the app starts, and the page reads
  amount, status and condition from the chain through the API. The recipient is a wallet the visitor picks or a passkey
  smart account (ZeroDev Kernel v3.1 with the passkey validator 0.0.3) made on the device without any hosted passkey server.
  Challenge invites are joined from the same page.
- Gas: every transaction the site sends sets gas = estimate x 1.3 (`src/lib/ifso/gas.ts`).
- Region: `/geo` decides whether stock price conditions are offered; the API enforces the same rule.
- Wallet picker: Reown AppKit when `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set, otherwise one button per wallet the browser
  announces (EIP-6963). It is not loaded on `/c/*` or `/link`.

## Configuration

Only environment variables and the deployments file of the chosen chain (`src/config/deployments/<chain id>.json`, the file the
deploy script writes). See `.env.example`. The escrow address is also read from the API's `/healthz`; if it differs from the
deployments file, the site refuses to sign.

## Security headers

`src/proxy.ts` gives `/c/*` and `/link` a per-request Content-Security-Policy (scripts only from this site, `connect-src`
limited to the API and the RPC, no framing), `Cache-Control: no-store` and `Referrer-Policy: no-referrer`; `next.config.ts`
repeats the fixed headers. Tests check the headers and that the JavaScript of both routes carries no AppKit, WalletConnect,
analytics or remote font code.

## Deploying on Vercel

Project root `web`, framework Next.js. Set the variables from `.env.example` for Production. Pin Bun in `vercel.json` if the
platform's Bun is older than the lockfile. Use an ignored-build-step so commits outside `web/` do not redeploy.

## Image credits

- IFSO seal and banner: supplied by the project.
- Shoji scene: Paolo Sanchez, [Pexels](https://www.pexels.com/photo/sunlight-on-traditional-japanese-interior-scene-32911574/).
- Shoji room: Kaiya Inouye, [Pexels](https://www.pexels.com/photo/serene-japanese-room-with-shoji-screens-and-light-35449989/).
- Calligraphy: Liuuu _61, [Pexels](https://www.pexels.com/photo/artistic-japanese-calligraphy-creation-close-up-31144525/).
- Bamboo water feature: Alex Bian, [Pexels](https://www.pexels.com/photo/traditional-japanese-water-feature-in-garden-38275469/).
- Clockwork: Олександр К, [Pexels](https://www.pexels.com/photo/close-up-of-intricate-clockwork-mechanism-28390781/).
- Brushes: Feng Zou, [Pexels](https://www.pexels.com/photo/ink-brushes-on-a-tabletop-6315614/).
- Red calligraphy: Kevin Malik, [Pexels](https://www.pexels.com/photo/a-person-writing-on-a-piece-of-paper-using-a-brush-and-black-ink-9016471/).
- Garden: Leongsan Tung, [Pexels](https://www.pexels.com/photo/tranquil-zen-garden-with-stone-arrangements-35145768/).

The photographs are offered under the Pexels License. The template's remaining artwork and code are released under the
Unlicense (`LICENSE.md`). The Allura font is provided in the Brewns reference template.

## Pages still marked as drafts

The privacy policy and the terms are drafts for legal review: the operator, contact details, jurisdiction and retention
periods are not filled in, and no support address or audit claim has been invented.
