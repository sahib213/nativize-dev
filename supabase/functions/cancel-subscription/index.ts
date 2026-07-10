import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

const MAX_AUTH_HEADER = 5000;
const ONE_DAY_SECONDS = 24 * 60 * 60;

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

function customerIdOf(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  if (!customer) return null;
  return typeof customer === "string" ? customer : customer.id;
}

function unixToIso(value?: number | null): string | null {
  return value ? new Date(value * 1000).toISOString() : null;
}

function stripeId(value: unknown): string | null {
  return typeof value === "string" && value.length < 140 ? value : null;
}

function cancellationPayload(
  entitlement: Record<string, unknown>,
  subscription: Stripe.Subscription,
  extra: Record<string, unknown> = {}
) {
  const effectiveCancelAt = subscription.cancel_at ||
    (subscription.cancel_at_period_end ? subscription.current_period_end : null);
  return {
    ok: true,
    planId: entitlement.plan_id,
    status: subscription.status,
    cancelAt: unixToIso(effectiveCancelAt),
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    currentPeriodEnd: unixToIso(subscription.current_period_end),
    ...extra
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false }
    });

    const authHeader = req.headers.get("Authorization") || "";
    if (authHeader.length > MAX_AUTH_HEADER) return json({ error: "Invalid authorization header." }, 400);
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!jwt) {
      await checkRateLimit(supabase, `cancel-subscription-anon:${requestIp(req)}`, 10, 900);
      return json({ error: "Sign in is required." }, 401);
    }

    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data.user) {
      await checkRateLimit(supabase, `cancel-subscription-invalid:${requestIp(req)}`, 10, 900);
      return json({ error: "Invalid Supabase session." }, 401);
    }
    if (req.method === "GET") {
      await checkRateLimit(supabase, `cancel-subscription-status-user:${data.user.id}`, 60, 900);
    } else {
      await checkRateLimit(supabase, `cancel-subscription-schedule-user:${data.user.id}`, 10, 900);
    }

    const { data: entitlement, error: entitlementError } = await supabase
      .from("billing_entitlements")
      .select("user_id,plan_id,billing,status,stripe_customer_id,stripe_subscription_id,current_period_end,cancel_at,cancel_at_period_end,cancellation_requested_at")
      .eq("user_id", data.user.id)
      .eq("billing", "subscription")
      .in("status", ["active", "trialing", "past_due"])
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (entitlementError) throw new Error("Could not load subscription.");
    if (!entitlement || !stripeId(entitlement.stripe_subscription_id)) {
      return json({ error: "No active subscription was found for this account." }, 404);
    }

    const stripe = new Stripe(env("STRIPE_SECRET_KEY"), {
      apiVersion: "2025-03-31.basil" as Stripe.LatestApiVersion,
      httpClient: Stripe.createFetchHttpClient()
    });

    const subscription = await stripe.subscriptions.retrieve(String(entitlement.stripe_subscription_id));
    const stripeCustomerId = customerIdOf(subscription.customer);
    if (stripeCustomerId && entitlement.stripe_customer_id && stripeCustomerId !== entitlement.stripe_customer_id) {
      return json({ error: "Subscription customer mismatch." }, 409);
    }

    if (req.method === "GET") {
      return json(cancellationPayload(entitlement, subscription));
    }

    if (subscription.status === "canceled" || subscription.status === "incomplete_expired") {
      await supabase.from("billing_entitlements").update({
        status: subscription.status,
        cancel_at: unixToIso(subscription.cancel_at),
        cancel_at_period_end: subscription.cancel_at_period_end === true,
        cancellation_effective_at: unixToIso(subscription.ended_at || subscription.canceled_at)
      }).eq("user_id", data.user.id);
      return json({ error: "This subscription is already canceled." }, 409);
    }

    if (subscription.cancel_at || subscription.cancel_at_period_end) {
      await supabase.from("billing_entitlements").update({
        cancel_at: unixToIso(subscription.cancel_at),
        cancel_at_period_end: subscription.cancel_at_period_end === true,
        cancellation_requested_at: entitlement.cancellation_requested_at || new Date().toISOString()
      }).eq("user_id", data.user.id);
      return json(cancellationPayload(entitlement, subscription, { alreadyScheduled: true }));
    }

    if (!subscription.current_period_end) {
      return json({ error: "Could not find the next renewal date for this subscription." }, 409);
    }

    const now = Math.floor(Date.now() / 1000);
    let cancelAt = subscription.current_period_end - ONE_DAY_SECONDS;
    let scheduleNote: string | null = null;
    if (cancelAt <= now + 300) {
      cancelAt = subscription.current_period_end;
      scheduleNote = "Renewal is within 24 hours, so cancellation was scheduled for the period end instead of immediately.";
    }
    if (cancelAt <= now) {
      return json({ error: "This subscription is too close to renewal to schedule safely. Please contact support." }, 409);
    }

    const requestedAt = new Date().toISOString();
    const updated = await stripe.subscriptions.update(subscription.id, {
      cancel_at: cancelAt,
      metadata: {
        ...subscription.metadata,
        nativize_cancel_requested_by: data.user.id,
        nativize_cancel_requested_at: requestedAt
      }
    });

    const cancelAtIso = unixToIso(updated.cancel_at);
    const currentPeriodEndIso = unixToIso(updated.current_period_end);
    await supabase.from("billing_entitlements").update({
      cancel_at: cancelAtIso,
      cancel_at_period_end: updated.cancel_at_period_end === true,
      cancellation_requested_at: requestedAt,
      cancellation_effective_at: null
    }).eq("user_id", data.user.id);

    await supabase.from("subscription_cancellation_requests").insert({
      user_id: data.user.id,
      stripe_subscription_id: updated.id,
      stripe_customer_id: stripeCustomerId,
      plan_id: entitlement.plan_id,
      requested_at: requestedAt,
      cancel_at: cancelAtIso,
      current_period_end: currentPeriodEndIso,
      status: "scheduled"
    });

    return json(cancellationPayload(entitlement, updated, {
      scheduled: true,
      scheduleNote,
      cancelAt: cancelAtIso,
      currentPeriodEnd: currentPeriodEndIso
    }));
  } catch (err) {
    console.error(err);
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    if (status === 400 || status === 401 || status === 404 || status === 409 || status === 429) {
      return json({ error: err instanceof Error ? err.message : "Request failed." }, status);
    }
    return json({ error: "Could not schedule subscription cancellation." }, 500);
  }
});
