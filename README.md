# Nativize — website (marketing + web app)

Dependency-free static site. No build step, no framework, no tracking. The
support and feature-request forms submit user-entered text to Supabase.

```
website/
  index.html     # landing page (hero, how-it-works, features, pricing, support, FAQ)
  app.html       # "Studio" — the full tool, in the browser (generate/push/update)
  privacy.html   # public privacy policy URL for store listings
  terms.html     # public terms page
  support.html   # public support URL for store listings
  chrome-web-store-disclosures.html
  styles.css     # shared styles (dark, glassy, violet→blue brand + animations)
  app.css        # Studio-only styles
  script.js      # landing: scroll reveal, nav, FAQ, glyphs, pricing render, CTAs
                 #          + Supabase support/feature-request submissions
  app.js         # Studio: mounts the builder, wires GitHub + plan gating + license
  lib/           # COPIES of ../src runtime modules (so the site deploys standalone)
  sync-lib.sh    # re-copies ../src/* into lib/ — run after changing the core
```

## The web app (`app.html`)

The Studio runs the **same engine as the extension** (it reuses `lib/*`, which are
copies of `../src`). Auth is a GitHub token (PAT with `repo` + `workflow` scopes) —
there's no extension here, so no `chrome.identity`. Users can:
- enter any GitHub repo (Lovable or any Vite/React project) + token,
- generate/download the kit, push it, and build in the cloud,
- **update**: if the repo is already Nativized, a "Just rebuild" bar appears so they
  rebuild after a change without redoing setup,
- paste a **license key** to unlock paid features.

> After changing anything in `../src`, run `bash website/sync-lib.sh` so the site
> picks it up.

## Before you launch — fill these in

**`script.js`** (top):
| Constant | What to set |
|----------|-------------|
| `CHROME_STORE_URL` | Chrome Web Store URL. Empty → "Add to Chrome" scrolls to install steps. |
| `GITHUB_URL` | Public Nativize repo URL. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Supabase project used for support and feature-request inserts. |
| `CHECKOUT_URLS` | Per-plan checkout links (Lemon Squeezy). Empty paid plans show "Coming soon". |

**Supabase feedback forms** — run `website/supabase-feedback.sql` in the Supabase
SQL editor. It creates `feature_requests` and `support_requests`, enables RLS, and
allows anonymous inserts without allowing public reads.

**`../src/plans.js`** — set each plan's real `price`/`priceNote` and the Lemon
Squeezy `variantId` (so a purchased key maps to the right plan), then re-run
`sync-lib.sh`. Set each variant's **activation limit** in Lemon Squeezy to the
plan's app count (1 / 1 / 3 / 10) — that's what enforces the per-plan app cap.

## Plans & gating (where the money logic lives)

`../src/plans.js` is the single source of truth. `gateConfig()` runs inside the kit
generator, so the extension and website are gated identically:
- **Free** — iOS only, "Built with Nativize" watermark, no push / sign-in / store
  upload, 1 app.
- **Starter** (one-time) — 1 app, all platforms + features, no watermark, no updates.
- **Pro** (monthly) — 3 apps, everything, unlimited updates.
- **Max** (monthly) — 10 apps, everything, unlimited updates.

`../src/license.js` validates keys against Lemon Squeezy's CORS-friendly license API
(no Nativize backend). Note: client-side gating is the right model for this product,
but a determined user could bypass it locally — the license key is the real friction,
and the cloud build/store-upload (which need your secrets) are the genuine value.

## Deploy

Fully static — deploy the whole `website/` folder (it includes `lib/`):
Vercel/Netlify (publish dir = `website`), GitHub Pages, Cloudflare Pages, S3, any CDN.

## Notes

- Respects `prefers-reduced-motion`. Platform icons + favicon are inline SVG.
- Fully responsive (desktop / tablet / mobile slide-down menu).
- Privacy copy is honest (generation stays local, token stays local, feedback
  forms go to Supabase only on submit) — keep it accurate.
