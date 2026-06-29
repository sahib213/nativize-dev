import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4?target=deno";

const planMeta = {
  starter: { billing: "one-time", appsLimit: 1 },
  pro: { billing: "subscription", appsLimit: 3 },
  max: { billing: "subscription", appsLimit: 10 }
};
const MAX_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024;
const MAX_SIGNATURE_HEADER = 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function envOptional(name: string): string | null {
  return Deno.env.get(name) || null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function readWebhookBody(req: Request): Promise<string> {
  const len = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(len) && len > MAX_WEBHOOK_BODY_BYTES) {
    throw Object.assign(new Error("Webhook payload is too large."), { status: 413 });
  }
  const body = await req.text();
  if (new TextEncoder().encode(body).length > MAX_WEBHOOK_BODY_BYTES) {
    throw Object.assign(new Error("Webhook payload is too large."), { status: 413 });
  }
  return body;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const out = value.trim();
  return out && out.length <= max ? out : null;
}

function assertUuid(value: string, label: string): string {
  if (!UUID_RE.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function assertStripeId(value: string | null | undefined, prefix: string, label: string): string | null {
  if (!value) return null;
  if (value.length > 120 || !value.startsWith(prefix)) throw new Error(`Invalid ${label}.`);
  return value;
}

function planFromPrice(priceId?: string | null): keyof typeof planMeta | null {
  if (!priceId) return null;
  const prices: Record<string, keyof typeof planMeta> = {};
  const starter = envOptional("STRIPE_PRICE_STARTER");
  const pro = envOptional("STRIPE_PRICE_PRO");
  const max = envOptional("STRIPE_PRICE_MAX");
  if (starter) prices[starter] = "starter";
  if (pro) prices[pro] = "pro";
  if (max) prices[max] = "max";
  return prices[priceId] || null;
}

function customerIdOf(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  if (!customer) return null;
  return typeof customer === "string" ? customer : customer.id;
}

function unixToIso(value?: number | null): string | null {
  return value ? new Date(value * 1000).toISOString() : null;
}

const stripe = new Stripe(env("STRIPE_SECRET_KEY"), {
  apiVersion: "2025-03-31.basil" as Stripe.LatestApiVersion,
  httpClient: Stripe.createFetchHttpClient()
});

const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false }
});

async function upsertCustomer(userId: string, stripeCustomerId: string, email?: string | null) {
  assertUuid(userId, "user id");
  assertStripeId(stripeCustomerId, "cus_", "Stripe customer");
  await supabase.from("billing_customers").upsert({
    user_id: userId,
    stripe_customer_id: stripeCustomerId,
    email: cleanText(email, 254)
  });
}

async function userIdForCustomer(stripeCustomerId: string): Promise<string | null> {
  const { data } = await supabase
    .from("billing_customers")
    .select("user_id")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();
  return data?.user_id || null;
}

async function upsertEntitlement(params: {
  userId: string;
  planId: keyof typeof planMeta;
  status: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId?: string | null;
  stripePriceId?: string | null;
  checkoutSessionId?: string | null;
  currentPeriodEnd?: string | null;
}) {
  const meta = planMeta[params.planId];
  assertUuid(params.userId, "user id");
  assertStripeId(params.stripeCustomerId, "cus_", "Stripe customer");
  assertStripeId(params.stripeSubscriptionId || null, "sub_", "Stripe subscription");
  assertStripeId(params.stripePriceId || null, "price_", "Stripe price");
  assertStripeId(params.checkoutSessionId || null, "cs_", "checkout session");
  if (!/^[a-z_]{1,40}$/.test(params.status)) throw new Error("Invalid entitlement status.");
  await supabase.from("billing_entitlements").upsert({
    user_id: params.userId,
    plan_id: params.planId,
    billing: meta.billing,
    status: params.status,
    stripe_customer_id: params.stripeCustomerId,
    stripe_subscription_id: params.stripeSubscriptionId || null,
    stripe_price_id: params.stripePriceId || null,
    checkout_session_id: params.checkoutSessionId || null,
    current_period_end: params.currentPeriodEnd || null,
    apps_limit: meta.appsLimit
  });
}

async function syncSubscription(subscription: Stripe.Subscription, explicit?: { userId?: string | null; planId?: string | null; checkoutSessionId?: string | null }) {
  const priceId = subscription.items.data[0]?.price?.id || null;
  const planId = (explicit?.planId as keyof typeof planMeta) || planFromPrice(priceId) || (subscription.metadata.plan_id as keyof typeof planMeta);
  if (!planId || !planMeta[planId]) return;

  const stripeCustomerId = customerIdOf(subscription.customer);
  if (!stripeCustomerId) return;

  const userId = explicit?.userId || subscription.metadata.user_id || await userIdForCustomer(stripeCustomerId);
  if (!userId) return;

  if (!["active", "trialing"].includes(subscription.status)) {
    const { data: current } = await supabase
      .from("billing_entitlements")
      .select("billing,status,stripe_subscription_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (current?.billing === "one-time" && current.status === "active") return;
    if (
      current?.stripe_subscription_id &&
      current.stripe_subscription_id !== subscription.id &&
      ["active", "trialing"].includes(current.status)
    ) return;
  }

  await upsertEntitlement({
    userId,
    planId,
    status: subscription.status,
    stripeCustomerId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: priceId,
    checkoutSessionId: explicit?.checkoutSessionId || null,
    currentPeriodEnd: unixToIso(subscription.current_period_end)
  });
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.user_id || null;
  const planId = session.metadata?.plan_id || null;
  const stripeCustomerId = customerIdOf(session.customer);
  if (!userId || !planId || !stripeCustomerId) return;
  if (!UUID_RE.test(userId) || !planMeta[planId as keyof typeof planMeta]) return;

  await upsertCustomer(userId, stripeCustomerId, session.customer_details?.email || null);

  if (session.mode === "subscription" && session.subscription) {
    const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    await syncSubscription(subscription, { userId, planId, checkoutSessionId: session.id });
    return;
  }

  if (session.mode === "payment") {
    const expanded = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ["line_items.data.price"]
    });
    const priceId = expanded.line_items?.data[0]?.price?.id || null;
    const resolvedPlanId = planFromPrice(priceId) || (planId as keyof typeof planMeta);
    if (!resolvedPlanId || !planMeta[resolvedPlanId]) return;
    await upsertEntitlement({
      userId,
      planId: resolvedPlanId,
      status: "active",
      stripeCustomerId,
      stripePriceId: priceId,
      checkoutSessionId: session.id
    });
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const signature = req.headers.get("stripe-signature");
  if (!signature) return json({ error: "Missing Stripe signature" }, 400);
  if (signature.length > MAX_SIGNATURE_HEADER) return json({ error: "Invalid Stripe signature" }, 400);

  let body: string;
  try {
    body = await readWebhookBody(req);
  } catch (err) {
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 400;
    return json({ error: err instanceof Error ? err.message : "Invalid webhook payload." }, status);
  }
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      env("STRIPE_WEBHOOK_SECRET"),
      undefined,
      Stripe.createSubtleCryptoProvider()
    );
  } catch (err) {
    return json({ error: "Invalid signature" }, 400);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await syncSubscription(event.data.object as Stripe.Subscription);
        break;
      default:
        break;
    }
    return json({ received: true });
  } catch (err) {
    console.error(err);
    return json({ error: "Webhook failed" }, 500);
  }
});
