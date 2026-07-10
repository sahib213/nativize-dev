# Supabase Billing Setup

This folder replaces the old license-key flow with GitHub sign-in, Supabase billing state, and Stripe Checkout using Stripe Managed Payments.

## 1. Database

Run `supabase/migrations/202606270001_billing.sql` in the Supabase SQL editor.

It creates:

- `billing_customers`: Supabase user to Stripe customer mapping.
- `billing_entitlements`: the current paid plan, populated by Stripe webhooks.
- `app_activations`: one row per GitHub repo a user has activated.
- `get_billing_status()`: client-readable plan status.
- `activate_app(repo)`: server-side app-limit enforcement.

## 2. Edge Function Secrets

Set these Supabase edge function secrets:

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_live_...
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
supabase secrets set STRIPE_PRICE_STARTER=price_...
supabase secrets set STRIPE_PRICE_PRO=price_...
supabase secrets set STRIPE_PRICE_MAX=price_...
supabase secrets set SITE_URL=https://nativize.dev
supabase secrets set STRIPE_BRANDING_LOGO_FILE=file_... # optional
supabase secrets set STRIPE_BRANDING_ICON_FILE=file_... # optional
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically by Supabase in hosted edge functions. If you run locally, set them too.

For support auto-replies and owner escalations, create a Resend API key and set:

```bash
supabase secrets set RESEND_API_KEY=re_...
supabase secrets set SUPPORT_FROM_EMAIL="Nativize Support <support@nativize.dev>"
supabase secrets set SUPPORT_TO_EMAIL=you@example.com
supabase secrets set SUPPORT_REPLY_TO_EMAIL=you@example.com # optional
```

If these email secrets are missing, `feedback-submit` still saves the request and
stores the bot's suggested reply in Supabase, but it will not send email yet.

The current Stripe sandbox setup uses CAD prices:

- Starter: $12 CAD one-time
- Pro: $29 CAD/month
- Max: $79 CAD/month

Products use Stripe tax code `txcd_10103001` for SaaS/software business use.

Create matching CAD products/prices in Stripe, then set these Supabase secrets to
the new live price IDs:

- Starter: `STRIPE_PRICE_STARTER`
- Pro: `STRIPE_PRICE_PRO`
- Max: `STRIPE_PRICE_MAX`

Live webhook destination:

```text
https://gaaxcbarmiwtojblkkyh.supabase.co/functions/v1/stripe-webhook
```

Endpoint ID: `we_1TmrFZLmsun3ElyeUzLEoshP`

## 3. Deploy Functions

```bash
supabase functions deploy create-checkout-session
supabase functions deploy cancel-subscription
supabase functions deploy stripe-webhook
supabase functions deploy feedback-submit
supabase functions deploy artifact-download
```

In Stripe, add a webhook endpoint pointing to:

```text
https://<project-ref>.supabase.co/functions/v1/stripe-webhook
```

Subscribe it to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

The extension and website use the publishable Supabase anon key only. Stripe secret keys and webhook secrets stay in Supabase.
