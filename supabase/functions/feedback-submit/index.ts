import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const MAX_BODY_BYTES = 4096;
const SUPPORT_TOPICS = new Set(["github-auth", "generated-project", "github-actions-build", "store-upload", "billing", "other"]);
const FEATURE_PRIORITIES = new Set(["nice-to-have", "important", "blocking"]);

type FeedbackType = "support" | "feature";

type SupportRow = {
  id: string;
  created_at: string;
  name: string | null;
  email: string;
  topic: string;
  message: string;
  page_path: string | null;
};

type FeatureRow = {
  id: string;
  created_at: string;
  email: string | null;
  priority: string;
  title: string;
  description: string;
  page_path: string | null;
};

type EmailResult = {
  sent: boolean;
  error?: string;
  skipped?: string;
};

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
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function cleanText(value: unknown, max: number, label: string, required = false): string | null {
  if (typeof value !== "string") {
    if (required) throw Object.assign(new Error(`${label} is required.`), { status: 400 });
    return null;
  }
  const out = value.trim();
  if (!out) {
    if (required) throw Object.assign(new Error(`${label} is required.`), { status: 400 });
    return null;
  }
  if (out.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(out)) {
    throw Object.assign(new Error(`${label} is invalid.`), { status: 400 });
  }
  return out;
}

function cleanEmail(value: unknown, required = false): string | null {
  const email = cleanText(value, 254, "Email", required)?.toLowerCase() || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw Object.assign(new Error("Email is invalid."), { status: 400 });
  }
  return email;
}

function cleanPagePath(value: unknown): string {
  const pagePath = cleanText(value, 300, "Page path", false) || "/";
  if (!/^\/[a-zA-Z0-9._~/?#=&%:+-]*$/.test(pagePath)) {
    throw Object.assign(new Error("Page path is invalid."), { status: 400 });
  }
  return pagePath;
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
  maxHits = 20,
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
    throw Object.assign(new Error("Request body is too large."), { status: 413 });
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw Object.assign(new Error("Request body is too large."), { status: 413 });
  }
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("Malformed JSON body."), { status: 400 });
  }
}

function payloadOf(body: Record<string, unknown>): Record<string, unknown> {
  const nested = body.payload;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : body;
}

function feedbackTypeOf(value: unknown): FeedbackType {
  if (value === "support" || value === "feature") return value;
  throw Object.assign(new Error("Unknown feedback type."), { status: 400 });
}

function supportPayload(input: Record<string, unknown>) {
  const topic = cleanText(input.topic, 40, "Topic", true) || "";
  if (!SUPPORT_TOPICS.has(topic)) throw Object.assign(new Error("Topic is invalid."), { status: 400 });
  return {
    source: "website",
    page_path: cleanPagePath(input.page_path),
    name: cleanText(input.name, 100, "Name", false),
    email: cleanEmail(input.email, true),
    topic,
    message: cleanText(input.message, 1600, "Message", true)
  };
}

function featurePayload(input: Record<string, unknown>) {
  const priority = cleanText(input.priority, 30, "Priority", false) || "nice-to-have";
  if (!FEATURE_PRIORITIES.has(priority)) throw Object.assign(new Error("Priority is invalid."), { status: 400 });
  return {
    source: "website",
    page_path: cleanPagePath(input.page_path),
    email: cleanEmail(input.email, false),
    priority,
    title: cleanText(input.title, 120, "Title", true),
    description: cleanText(input.description, 1200, "Description", true)
  };
}

function supportReply(row: SupportRow): { subject: string; body: string; summary: string; needsHuman: boolean } {
  const lower = `${row.topic} ${row.message}`.toLowerCase();
  const name = row.name || "there";
  let summary = "Auto-replied with first troubleshooting steps.";
  let needsHuman = row.topic === "billing" || row.topic === "store-upload" || row.topic === "other";
  const urgentTerms = ["refund", "charged", "payment", "invoice", "cancel", "store upload", "app store", "google play", "rejected", "secret", "token", "crash", "urgent"];
  if (urgentTerms.some((term) => lower.includes(term))) needsHuman = true;

  let steps: string[];
  if (row.topic === "github-auth") {
    steps = [
      "Open the Nativize extension again and sign out, then sign in with GitHub once more.",
      "Make sure the browser is using the same GitHub account that owns the repo you want to convert.",
      "If the sign-in loop continues, try a fresh Chrome window and then send the exact error text back here."
    ];
  } else if (row.topic === "generated-project") {
    steps = [
      "Regenerate the native project from the latest Lovable/GitHub code.",
      "Open the generated README and run the install/sync commands it lists.",
      "If Android fails, check that the generated project keeps the pinned Capacitor 8 Android toolchain instead of upgrading to AGP 9."
    ];
  } else if (row.topic === "github-actions-build") {
    steps = [
      "Open the failed GitHub Actions run and expand the first red step.",
      "Re-run the job once after confirming the generated repo was pushed completely.",
      "Reply with the first red error block if it still fails."
    ];
  } else if (row.topic === "store-upload") {
    summary = "Store upload request needs human follow-up.";
    steps = [
      "Store upload usually needs account-specific Apple or Google Play setup, so Sahib should review this one.",
      "Do not send passwords, API keys, issuer IDs, or service-account JSON by email.",
      "Reply with the visible error text and which store step you are on."
    ];
  } else if (row.topic === "billing") {
    summary = "Billing request needs human follow-up.";
    steps = [
      "Sahib should review billing requests directly.",
      "Please do not send card numbers or payment secrets.",
      "Reply with the plan name, approximate purchase time, and the email used at checkout."
    ];
  } else {
    summary = "Uncategorized support request needs human follow-up.";
    steps = [
      "Sahib should review this manually.",
      "Reply with the app URL, GitHub repo, and the exact step where you got stuck.",
      "Do not send tokens, passwords, or payment secrets."
    ];
  }

  const body = [
    `Hi ${name},`,
    "",
    "I got your Nativize support request. I am the automatic support helper, so I can send the first steps right away.",
    "",
    "Try this:",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    needsHuman
      ? "I also flagged this for Sahib because it may need a human reply."
      : "If that does not fix it, reply to this email and Sahib can take over.",
    "",
    "Nativize Support"
  ].join("\n");

  return {
    subject: `Nativize support: ${row.topic.replace(/-/g, " ")}`,
    body,
    summary,
    needsHuman
  };
}

function featureReply(row: FeatureRow): { subject: string; body: string; summary: string; needsHuman: boolean } {
  const needsHuman = row.priority === "blocking" || row.priority === "important";
  const body = [
    "Hi there,",
    "",
    "Thanks for sending this Nativize feature request. It is now in the roadmap inbox.",
    "",
    `Feature: ${row.title}`,
    `Priority: ${row.priority}`,
    "",
    needsHuman
      ? "Because you marked it as important or blocking, I also flagged it for Sahib to review sooner."
      : "Sahib reviews these when planning the next Nativize updates.",
    "",
    "Nativize Support"
  ].join("\n");
  return {
    subject: `Nativize feature request received: ${row.title}`,
    body,
    summary: needsHuman ? "Feature request flagged for review." : "Feature request acknowledged.",
    needsHuman
  };
}

async function sendEmail(params: {
  to: string;
  subject: string;
  text: string;
  replyTo?: string | null;
}): Promise<EmailResult> {
  const apiKey = envOptional("RESEND_API_KEY");
  const from = envOptional("SUPPORT_FROM_EMAIL");
  if (!apiKey || !from) return { sent: false, skipped: "missing_email_config" };

  const body: Record<string, unknown> = {
    from,
    to: [params.to],
    subject: params.subject,
    text: params.text
  };
  if (params.replyTo) body.reply_to = params.replyTo;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = await response.text();
    return { sent: false, error: detail || `Resend failed with status ${response.status}` };
  }
  return { sent: true };
}

async function markAutomation(
  supabase: ReturnType<typeof createClient>,
  table: "support_requests" | "feature_requests",
  id: string,
  patch: Record<string, unknown>
) {
  const { error } = await supabase.from(table).update(patch).eq("id", id);
  if (error) console.error("Could not update feedback automation columns", error);
}

async function automateSupport(supabase: ReturnType<typeof createClient>, row: SupportRow) {
  const reply = supportReply(row);
  const ownerEmail = envOptional("SUPPORT_TO_EMAIL");
  const replyTo = envOptional("SUPPORT_REPLY_TO_EMAIL") || ownerEmail;

  const userEmail = await sendEmail({
    to: row.email,
    subject: reply.subject,
    text: reply.body,
    replyTo
  });

  let ownerResult: EmailResult = { sent: false, skipped: "not_needed" };
  if (reply.needsHuman && ownerEmail) {
    ownerResult = await sendEmail({
      to: ownerEmail,
      subject: `Needs reply: ${reply.subject}`,
      text: [
        "A Nativize support request needs a human reply.",
        "",
        `Name: ${row.name || ""}`,
        `Email: ${row.email}`,
        `Topic: ${row.topic}`,
        `Page: ${row.page_path || "/"}`,
        `Created: ${row.created_at}`,
        "",
        "Message:",
        row.message,
        "",
        "Suggested reply:",
        reply.body
      ].join("\n"),
      replyTo: row.email
    });
  }

  const errors = [userEmail.error, ownerResult.error].filter(Boolean).join("\n") || null;
  await markAutomation(supabase, "support_requests", row.id, {
    status: reply.needsHuman ? "needs_human" : "auto_replied",
    bot_needs_human: reply.needsHuman,
    bot_summary: reply.summary,
    bot_reply_subject: reply.subject,
    bot_reply_body: reply.body,
    auto_reply_sent_at: userEmail.sent ? new Date().toISOString() : null,
    owner_notified_at: ownerResult.sent ? new Date().toISOString() : null,
    automation_error: errors || userEmail.skipped || ownerResult.skipped || null
  });

  return { reply, userEmail, ownerEmail: ownerResult };
}

async function automateFeature(supabase: ReturnType<typeof createClient>, row: FeatureRow) {
  const reply = featureReply(row);
  const ownerEmail = envOptional("SUPPORT_TO_EMAIL");
  const replyTo = envOptional("SUPPORT_REPLY_TO_EMAIL") || ownerEmail;

  let userEmail: EmailResult = { sent: false, skipped: "no_submitter_email" };
  if (row.email) {
    userEmail = await sendEmail({
      to: row.email,
      subject: reply.subject,
      text: reply.body,
      replyTo
    });
  }

  let ownerResult: EmailResult = { sent: false, skipped: "not_needed" };
  if (reply.needsHuman && ownerEmail) {
    ownerResult = await sendEmail({
      to: ownerEmail,
      subject: `Feature review: ${row.title}`,
      text: [
        "A Nativize feature request was marked important/blocking.",
        "",
        `Email: ${row.email || ""}`,
        `Priority: ${row.priority}`,
        `Page: ${row.page_path || "/"}`,
        `Created: ${row.created_at}`,
        "",
        "Description:",
        row.description
      ].join("\n"),
      replyTo: row.email
    });
  }

  const errors = [userEmail.error, ownerResult.error].filter(Boolean).join("\n") || null;
  await markAutomation(supabase, "feature_requests", row.id, {
    status: reply.needsHuman ? "needs_review" : "acknowledged",
    bot_needs_human: reply.needsHuman,
    bot_summary: reply.summary,
    bot_reply_subject: reply.subject,
    bot_reply_body: reply.body,
    auto_reply_sent_at: userEmail.sent ? new Date().toISOString() : null,
    owner_notified_at: ownerResult.sent ? new Date().toISOString() : null,
    automation_error: errors || userEmail.skipped || ownerResult.skipped || null
  });

  return { reply, userEmail, ownerEmail: ownerResult };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false }
    });
    await checkRateLimit(supabase, `feedback-edge:${requestIp(req)}`, 20, 900);

    const body = await readJsonBody(req);
    const type = feedbackTypeOf(body.type);
    const payload = payloadOf(body);
    const table = type === "support" ? "support_requests" : "feature_requests";
    const insertPayload = type === "support" ? supportPayload(payload) : featurePayload(payload);

    const { data, error } = await supabase
      .from(table)
      .insert(insertPayload)
      .select("*")
      .single();

    if (error || !data) {
      if (/too many/i.test(error?.message || "")) return json({ error: "Too many requests. Please try again later." }, 429);
      return json({ error: "Could not submit feedback." }, 500);
    }

    const automation = type === "support"
      ? await automateSupport(supabase, data as SupportRow)
      : await automateFeature(supabase, data as FeatureRow);

    return json({
      ok: true,
      id: data.id,
      needs_human: automation.reply.needsHuman,
      email: {
        auto_reply_sent: automation.userEmail.sent,
        owner_notified: automation.ownerEmail.sent
      }
    });
  } catch (err) {
    console.error(err);
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    if (status === 400 || status === 413 || status === 429) {
      return json({ error: err instanceof Error ? err.message : "Request failed." }, status);
    }
    return json({ error: "Feedback submission failed." }, 500);
  }
});
