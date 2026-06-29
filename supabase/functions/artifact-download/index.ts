import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const MAX_BODY_BYTES = 9000;
const MAX_AUTH_HEADER = 5000;
const GITHUB_ARTIFACT_RE = /^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/artifacts\/\d+\/zip$/;

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

function rateLimitError(message = "Too many downloads. Please try again later."): Error & { status?: number } {
  const err = new Error(message) as Error & { status?: number };
  err.status = 429;
  return err;
}

async function checkRateLimit(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  maxHits = 30,
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

function cleanArtifactUrl(value: unknown): string {
  const url = String(value || "").trim();
  if (!GITHUB_ARTIFACT_RE.test(url)) {
    throw Object.assign(new Error("Artifact download URL is invalid."), { status: 400 });
  }
  return url;
}

function cleanToken(value: unknown): string {
  const token = String(value || "").trim();
  if (!token || token.length > 5000 || /[\u0000-\u001f\u007f]/.test(token)) {
    throw Object.assign(new Error("GitHub access is missing. Sign in again."), { status: 400 });
  }
  return token;
}

function cleanFilename(value: unknown): string {
  let out = String(value || "nativize-artifact.zip")
    .trim()
    .replace(/[<>:"\\|?*\u0000-\u001f]/g, "-")
    .replace(/^[/\\]+/, "")
    .replace(/\.\.+/g, ".");
  if (!out || out === "." || out === "..") out = "nativize-artifact.zip";
  if (!/\.zip$/i.test(out)) out += ".zip";
  return out.slice(0, 180);
}

async function githubError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return `GitHub ${response.status}`;
  try {
    const data = JSON.parse(text);
    return data.message || data.error || `GitHub ${response.status}`;
  } catch {
    return text.slice(0, 220);
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
      await checkRateLimit(supabase, `artifact-anon:${requestIp(req)}`, 10, 900);
      return json({ error: "Sign in is required." }, 401);
    }

    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data.user) {
      await checkRateLimit(supabase, `artifact-invalid:${requestIp(req)}`, 10, 900);
      return json({ error: "Invalid Supabase session." }, 401);
    }
    await checkRateLimit(supabase, `artifact-user:${data.user.id}`, 30, 900);

    const body = await readJsonBody(req);
    const artifactUrl = cleanArtifactUrl(body.artifactUrl);
    const githubToken = cleanToken(body.githubToken);
    const filename = cleanFilename(body.filename);

    const artifact = await fetch(artifactUrl, {
      headers: {
        "Authorization": `Bearer ${githubToken}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Nativize-Artifact-Download"
      },
      redirect: "follow"
    });

    if (!artifact.ok || !artifact.body) {
      const detail = await githubError(artifact);
      return json({ error: `Could not download this app (${detail}).` }, artifact.status === 404 ? 404 : 502);
    }

    const headers = new Headers(corsHeaders);
    headers.set("Content-Type", artifact.headers.get("Content-Type") || "application/zip");
    headers.set("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
    headers.set("Cache-Control", "no-store");
    const length = artifact.headers.get("Content-Length");
    if (length) headers.set("Content-Length", length);

    return new Response(artifact.body, { status: 200, headers });
  } catch (err) {
    console.error(err);
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    if (status === 400 || status === 401 || status === 413 || status === 429) {
      return json({ error: err instanceof Error ? err.message : "Request failed." }, status);
    }
    return json({ error: "Artifact download failed." }, 500);
  }
});
