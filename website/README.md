# Nativize — website (marketing + web app)

Dependency-free static site. No build step, no framework, no tracking. The
support and feature-request forms submit user-entered text to Supabase.

```
website/
  /     # landing page (hero, how-it-works, features, pricing, support, FAQ)
  /how-it-works/
  /features/
  /pricing/
  /compare/
  /security/
  /get-started/
  /app/       # "Studio" — the full tool, in the browser (generate/push/update)
  /privacy/   # public privacy policy URL for store listings
  /terms/     # public terms page
  /support/   # public support URL for store listings
  /chrome-web-store-disclosures/
  styles.css     # shared styles (dark, glassy, violet→blue brand + animations)
  app.css        # Studio-only styles
  script.js      # landing: scroll reveal, nav, FAQ, glyphs, pricing render, CTAs
                 #          + Supabase support/feature-request submissions
  app.js         # Studio: mounts the builder, wires GitHub + Supabase billing
  lib/           # COPIES of ../src runtime modules (so the site deploys standalone)
  sync-lib.sh    # re-copies ../src/* into lib/ — run after changing the core
```

## The web app (`/app/`)

The Studio runs the **same engine as the extension** (it reuses `lib/*`, which are
copies of `../src`). Auth runs through Supabase GitHub OAuth and stores the GitHub
provider token locally for GitHub API calls. Users can:
- enter any GitHub repo (Lovable or any Vite/React project),
- generate/download the kit, push it, and build in the cloud,
- **update**: if the repo is already Nativized, a "Just rebuild" bar appears so they
  rebuild after a change without redoing setup,
- choose Starter, Pro, or Max and pay through Stripe Checkout.

> After changing anything in `../src`, run `bash website/sync-lib.sh` so the site
> picks it up.

## Before you launch — fill these in

**`script.js`** (top):
| Constant | What to set |
|----------|-------------|
| `CHROME_STORE_URL` | Chrome Web Store URL. Empty -> "Add to Chrome" points to the get-started page. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Supabase project used for feedback, Auth, billing RPCs, and edge functions. |

**Supabase feedback forms** — run `website/supabase-feedback.sql` in the Supabase
SQL editor. It creates `feature_requests` and `support_requests`, enables RLS, and
allows anonymous inserts without allowing public reads.

**Supabase billing** — run `../supabase/migrations/202606270001_billing.sql`, deploy
the two edge functions in `../supabase/functions`, and set the Stripe price IDs in
Supabase secrets. The app uses `../src/billing.js` to read plan status and enforce
app activations through Supabase RPCs.

**`../src/plans.js`** — set each plan's real `price`/`priceNote`, then re-run
`sync-lib.sh`.

## Plans & gating (where the money logic lives)

`../src/plans.js` is the single source of truth. `gateConfig()` runs inside the kit
generator, so the extension and website are gated identically:
- **Free** — iOS only, "Built with Nativize" watermark, no push / sign-in / store
  upload, 1 app.
- **Starter** ($12 CAD one-time) — 1 app, all platforms + features, no watermark, one launch.
- **Pro** ($29 CAD/month) — 3 apps, everything, unlimited updates.
- **Max** ($79 CAD/month) — 10 apps, everything, unlimited updates.

`../src/billing.js` talks to Supabase RPCs and the `create-checkout-session` edge
function. Supabase stores paid entitlements from Stripe webhooks and enforces the
per-plan app cap in `activate_app(repo)`.

## Deploy

Fully static — deploy the whole `website/` folder (it includes `lib/`):
Vercel/Netlify (publish dir = `website`), GitHub Pages, Cloudflare Pages, S3, any CDN.

## Notes

- Respects `prefers-reduced-motion`. Platform icons + favicon are inline SVG.
- Fully responsive (desktop / tablet / mobile slide-down menu).
- Privacy copy is honest (generation stays local, tokens are stored locally and
  sent to Supabase only for secure download checks, feedback forms go to
  Supabase only on submit) — keep it accurate.
