# IFSO website handoff

This is the IFSO adaptation of the supplied Kumo Next.js template. The homepage retains the template's intro, pinned frame sequences, cloud wipes, ticker and rotating ring. The former schoolgirl sequence retains the original moving city footage, cropped above the person for every frame. The uncropped original frames are excluded. IFSO colours, seal and product copy replace the template branding.

## Run

Use Node 20.19 or newer. Run `npm install`, then `npm run dev`, and open the local URL printed by Next.js. Use `npm run build` for a production build and `npm start` to serve it. Set `NEXT_PUBLIC_SITE_URL` to the final canonical origin when it is known.

## Routes

`/` (template-based landing page), `/how-it-works`, `/conditions`, `/technology`, `/pricing`, `/dashboard`, `/privacy-policy`, `/terms`, and `/risks`. Content and motion for the homepage are in `src/data/home` and `src/views/home`; additional pages are in `src/views/ifso/editorial.tsx` and `editorial.css`. The new pages use React Spring and the shared CRT finishing from the template.

## Integration status

The website is a frontend handoff. The supplied IFSO backend archive contains contracts and a Bun/Hono/tRPC service, but no deployed addresses, production API origin, credentials or configured infrastructure. The dashboard contains payment input, review, browser-local draft storage and browser-wallet connection; it can search, reopen and remove local drafts. It does not build, sign or submit an escrow. Do not treat it as a live payment flow. The claim page, payment history, challenge acceptance, decisions and refunds are not wired.

The backend team should connect the exact tRPC `parse`, `build`, `submit`, `escrow`, `claim`, `accept`, `decide`, `redirectRefund` and `mine` operations from `services/src/api/router.ts`. Replace free-text fields with service-backed validation and unambiguous canonical previews. Read the fee and typed data returned by `build`, verify chain and contracts, then sign and submit. Never sign the locally calculated review. Enforce the specified stock-token region gate and expiry rules.

For claim links, use `services/src/client/claimPage.ts` and the link utilities in the supplied backend. Keep the secret in the URL fragment/client only, wipe the fragment immediately with history.replaceState, use no third-party scripts on the claim route, read the amount and condition from chain, and bind the recipient in the claim signature. Configure the passkey provider, chain ID, USDG and escrow addresses, relayer and CSP. Run the backend's testnet, fork, security and audit gates before launch.

The privacy policy and terms are clearly marked as drafts because the operator, support contact, jurisdiction, retention periods and actual deployment practices were not supplied. Legal counsel must complete and review them. Product claims and fees should be checked against final contract configuration. No support email, claims of licensing, or completed audit have been invented.

## Image credits

- IFSO seal and banner: supplied by the user.
- Shoji scene: Paolo Sanchez, [Pexels](https://www.pexels.com/photo/sunlight-on-traditional-japanese-interior-scene-32911574/).
- Shoji room: Kaiya Inouye, [Pexels](https://www.pexels.com/photo/serene-japanese-room-with-shoji-screens-and-light-35449989/).
- Calligraphy: Liuuu _61, [Pexels](https://www.pexels.com/photo/artistic-japanese-calligraphy-creation-close-up-31144525/).
- Bamboo water feature: Alex Bian, [Pexels](https://www.pexels.com/photo/traditional-japanese-water-feature-in-garden-38275469/).
- Clockwork: Олександр К, [Pexels](https://www.pexels.com/photo/close-up-of-intricate-clockwork-mechanism-28390781/).
- Brushes: Feng Zou, [Pexels](https://www.pexels.com/photo/ink-brushes-on-a-tabletop-6315614/).
- Red calligraphy: Kevin Malik, [Pexels](https://www.pexels.com/photo/a-person-writing-on-a-piece-of-paper-using-a-brush-and-black-ink-9016471/).
- Garden: Leongsan Tung, [Pexels](https://www.pexels.com/photo/tranquil-zen-garden-with-stone-arrangements-35145768/).
- The photographs above are offered under the Pexels License. Original Kumo source and remaining sequence artwork: provided template, with an Unlicense dedication in `LICENSE.md`. The Allura font is provided in the Brewns reference template.

Confirm final commercial usage, applicable releases and license terms before publication.

## Loading and performance

The homepage preloader fetches every frame of the current viewport's three sequences and its cloud artwork before opening. This avoids late scene downloads but increases first-load time and data usage. Frames are kept compressed during preload to avoid decoding hundreds of full-size images at once. The editorial pages preload and decode their own unique imagery and font before revealing content. The loading screen offers a retry on a failed asset. Test on real target devices and network conditions before deployment, and tune asset resolution or use a versioned CDN cache as needed.

## Recording-inspired revision

The general content pages use the notebook and stamped-ink treatment; `/conditions` uses an interactive folder index; `/dashboard` provides an activity workspace with local drafts and separate empty states for unavailable live history. The how-it-works page contains the looping samurai scene, while the technology page contains the oscilloscope-inspired IFSO sequence; both are drawn in JavaScript canvas. The animations pause when offscreen and respect reduced-motion preferences. The three social buttons display a coming-soon pop-up until real destinations are supplied. No user account, live payment or balance is inferred from the interface.

The former `/create` URL redirects to the dashboard composer, including old draft links. Expiry inputs and displays use fixed Eastern Standard Time (UTC−05:00), not seasonal Eastern Daylight Time. New drafts store expiry as an ISO UTC instant.

## Responsive and page transitions

The dashboard and content layouts reflow for narrow screens, with larger mobile touch targets and phone-friendly artwork placement. Links between interior pages use the calligraphic logo transition; reduced-motion visitors navigate without it. The animation canvases only run when visible and limit pixel density; the samurai uses fewer particles on smaller canvases. Test on actual iOS and Android devices, including rotation and slow networks, before release. The recording-inspired designs are adaptations from video references, not verified frame-for-frame reproductions.

## Visual interaction updates

The condition folders expand within the stack, and the legal page index follows scrolling. The transparent seal is at `public/ifso-seal-transparent.png`; `public/ifso-logo-original.png` retains the supplied original. The seal's transparent version was generated from the supplied image, so its texture is not a pixel-identical extraction. The samurai is a procedural JavaScript interpretation, not a frame-for-frame copy of the supplied recording.

Condition files animate their measured height in both directions. The landing sequence only repaints when the visible frame is decoded, avoiding redundant work while the background frames load. The samurai loop includes revised stances and cuts while remaining JavaScript-drawn; it is not frame-identical to the supplied recording.

Between interior pages the transition draws a calligraphic IFSO mark before resolving into the supplied seal; it waits for destination loaders and visible images before fading away. Home links bypass this transition and open the original landing-page loader directly. A timeout and the page's retry control prevent a failed asset from trapping navigation. The responsive layouts have been inspected at selected viewport sizes; production device and network testing is still needed.

The frame canvas caches its measured size with ResizeObserver, avoiding a layout read on each scroll frame. Portrait frame decoding, the original scene timing, and the image preload remain in place. Validate actual scrolling performance on representative devices before release.
