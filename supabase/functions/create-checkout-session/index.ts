import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const plans = {
  starter: { priceEnv: "STRIPE_PRICE_STARTER", mode: "payment" as const },
  pro: { priceEnv: "STRIPE_PRICE_PRO", mode: "subscription" as const },
  max: { priceEnv: "STRIPE_PRICE_MAX", mode: "subscription" as const }
};
const MAX_BODY_BYTES = 4096;
const MAX_AUTH_HEADER = 5000;
const MAX_URL_LENGTH = 2048;

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function cleanSiteUrl(): string {
  return (Deno.env.get("SITE_URL") || "https://nativize.dev").replace(/\/+$/, "");
}

function requestIp(req: Request): string {
  return (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown")
    .split(",")[0]
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, "-")
    .slice(0, 80) || "unknown";
}

function rateLimitError(message = "Too many requests. Please try again later."): Error & { status?: number } {
  const err = new Error(message) as Error & { status?: number };
  err.status = 429;
  return err;
}

async function checkRateLimit(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  maxHits = 5,
  windowSeconds = 900
) {
  const { error } = await supabase.rpc("nativize_check_rate_limit", {
    bucket,
    max_hits: maxHits,
    window_seconds: windowSeconds
  });
  if (error) {
    if (/too many requests/i.test(error.message || "")) throw rateLimitError();
    throw new Error("Rate limit check failed.");
  }
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
    const err = new Error("Request body is too large.") as Error & { status?: number };
    err.status = 413;
    throw err;
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    const err = new Error("Request body is too large.") as Error & { status?: number };
    err.status = 413;
    throw err;
  }
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad shape");
    return parsed as Record<string, unknown>;
  } catch {
    const err = new Error("Malformed JSON body.") as Error & { status?: number };
    err.status = 400;
    throw err;
  }
}

function checkoutBrandingSettings(): Record<string, unknown> {
  const logoFile = Deno.env.get("STRIPE_BRANDING_LOGO_FILE");
  const iconFile = Deno.env.get("STRIPE_BRANDING_ICON_FILE");
  const settings: Record<string, unknown> = {
    display_name: "Nativize",
    button_color: "#7c3aed",
    background_color: "#ffffff",
    border_style: "rounded"
  };
  if (logoFile) settings.logo = { type: "file", file: logoFile };
  if (iconFile) settings.icon = { type: "file", file: iconFile };
  return settings;
}

function safeReturnUrl(raw: unknown, fallback: string, siteUrl: string): string {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  if (raw.length > MAX_URL_LENGTH) return fallback;
  try {
    const candidate = new URL(raw);
    const allowed = new URL(siteUrl);
    if (candidate.protocol !== "https:" && candidate.protocol !== "http:") return fallback;
    return candidate.origin === allowed.origin ? candidate.toString() : fallback;
  } catch {
    return fallback;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false }
    });

    const authHeader = req.headers.get("Authorization") || "";
    if (authHeader.length > MAX_AUTH_HEADER) return json({ error: "Invalid authorization header." }, 400);
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!jwt) {
      await checkRateLimit(supabase, `checkout-anon:${requestIp(req)}`, 10, 900);
      return json({ error: "Sign in is required." }, 401);
    }

    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data.user) {
      await checkRateLimit(supabase, `checkout-invalid:${requestIp(req)}`, 10, 900);
      return json({ error: "Invalid Supabase session." }, 401);
    }
    await checkRateLimit(supabase, `checkout-user:${data.user.id}`, 5, 900);

    const body = await readJsonBody(req);
    const planId = String(body.planId || "");
    const plan = plans[planId as keyof typeof plans];
    if (!plan) return json({ error: "Unknown plan." }, 400);

    const price = env(plan.priceEnv);
    const stripe = new Stripe(env("STRIPE_SECRET_KEY"), {
      apiVersion: "2025-03-31.basil" as Stripe.LatestApiVersion,
      httpClient: Stripe.createFetchHttpClient()
    });

    const siteUrl = cleanSiteUrl();
    const successUrl = safeReturnUrl(
      body.successUrl,
      `${siteUrl}/app.html?checkout=success`,
      siteUrl
    );
    const cancelUrl = safeReturnUrl(
      body.cancelUrl,
      `${siteUrl}/app.html?checkout=cancelled`,
      siteUrl
    );

    const user = data.user;
    let customerId: string | null = null;
    const { data: existing } = await supabase
      .from("billing_customers")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();
    customerId = existing?.stripe_customer_id || null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email || undefined,
        metadata: { supabase_user_id: user.id }
      });
      customerId = customer.id;
      await supabase.from("billing_customers").upsert({
        user_id: user.id,
        stripe_customer_id: customerId,
        email: user.email || null
      });
    }

    const metadata = { user_id: user.id, plan_id: planId };
    const session = await stripe.checkout.sessions.create({
      mode: plan.mode,
      customer: customerId,
      client_reference_id: user.id,
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      line_items: [{ price, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      branding_settings: checkoutBrandingSettings(),
      managed_payments: { enabled: true },
      metadata,
      subscription_data: plan.mode === "subscription" ? { metadata } : undefined
    } as Stripe.Checkout.SessionCreateParams & { managed_payments: { enabled: boolean } });

    return json({ id: session.id, url: session.url });
  } catch (err) {
    console.error(err);
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    if (status === 400 || status === 413 || status === 429) {
      return json({ error: err instanceof Error ? err.message : "Request failed." }, status);
    }
    return json({ error: "Checkout failed." }, 500);
  }
});
