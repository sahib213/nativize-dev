import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const MAX_BODY_BYTES = 9000;
const MAX_AUTH_HEADER = 5000;
const MAX_ARTIFACT_BYTES = 250 * 1024 * 1024;
const GITHUB_ARTIFACT_RE = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/actions\/artifacts\/(\d+)\/zip$/;
const REPO_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const PAID_PLANS = new Set(["starter", "pro", "max"]);

type GithubArtifactRef = { owner: string; repo: string; id: string };
type GithubRepoRef = { owner: string; repo: string };
type GithubArtifactMeta = { name: string; archive_download_url?: string; expired?: boolean };

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
    console.warn("Artifact download rate-limit check failed:", error.message || error);
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

function parseArtifactUrl(value: unknown): { url: string; ref: GithubArtifactRef } {
  const url = String(value || "").trim();
  const match = url.match(GITHUB_ARTIFACT_RE);
  if (!match) {
    throw Object.assign(new Error("Artifact download URL is invalid."), { status: 400 });
  }
  return { url, ref: { owner: match[1], repo: match[2], id: match[3] } };
}

function cleanRepo(value: unknown): GithubRepoRef {
  const repo = String(value || "").trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/[?#].*$/, "")
    .replace(/\.git\/?$/i, "")
    .replace(/\/+$/, "");
  const match = repo.match(REPO_RE);
  if (!match || repo.length > 140) {
    throw Object.assign(new Error("GitHub repo must be in owner/repo form."), { status: 400 });
  }
  return { owner: match[1], repo: match[2] };
}

function cleanRef(value: unknown): string {
  const ref = String(value || "").trim();
  if (!ref) return "";
  if (ref.length > 120 || /(^|\/)\.\.?($|\/)/.test(ref) || !/^[A-Za-z0-9._/-]+$/.test(ref)) {
    throw Object.assign(new Error("Git ref is invalid."), { status: 400 });
  }
  return ref;
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

function normalizedArtifactName(name: string): string {
  return String(name || "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function artifactRequiresPaid(name: string): boolean {
  const n = normalizedArtifactName(name);
  if (n.includes("ios simulator preview") || n.includes("nativized ios preview")) return false;
  return true;
}

async function userPlanId(supabase: ReturnType<typeof createClient>, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("billing_entitlements")
    .select("plan_id,status,current_period_end,updated_at")
    .eq("user_id", userId)
    .in("status", ["active", "trialing"])
    .order("updated_at", { ascending: false })
    .limit(5);

  if (error) {
    console.warn("Could not read billing entitlement:", error.message || error);
    return "free";
  }

  const now = Date.now();
  const active = (data || []).find((row) => {
    const end = row.current_period_end ? Date.parse(row.current_period_end) : 0;
    return !row.current_period_end || (Number.isFinite(end) && end > now);
  });
  return String(active?.plan_id || "free").toLowerCase();
}

async function requirePaidPlan(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  message: string
) {
  const planId = await userPlanId(supabase, userId);
  if (!PAID_PLANS.has(planId)) {
    throw Object.assign(new Error(message), { status: 402 });
  }
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

function githubHeaders(githubToken: string): HeadersInit {
  return {
    "Authorization": `Bearer ${githubToken}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Nativize-Artifact-Download"
  };
}

async function fetchGithubArtifact(artifactUrl: string, githubToken: string): Promise<Response> {
  const first = await fetch(artifactUrl, {
    headers: githubHeaders(githubToken),
    redirect: "manual"
  });

  if ([301, 302, 303, 307, 308].includes(first.status)) {
    const location = first.headers.get("Location");
    if (!location) return first;
    return fetch(location, {
      headers: { "User-Agent": "Nativize-Artifact-Download" },
      redirect: "follow"
    });
  }

  return first;
}

async function fetchGithubArtifactMetadata(ref: GithubArtifactRef, githubToken: string): Promise<GithubArtifactMeta> {
  const response = await fetch(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/actions/artifacts/${ref.id}`,
    { headers: githubHeaders(githubToken) }
  );
  if (!response.ok) {
    const detail = await githubError(response);
    throw Object.assign(new Error(`Could not verify this download (${detail}).`), {
      status: response.status === 404 ? 404 : 502
    });
  }
  const data = await response.json();
  return {
    name: String(data?.name || ""),
    archive_download_url: data?.archive_download_url,
    expired: data?.expired === true
  };
}

async function fetchGithubProjectZip(repo: GithubRepoRef, githubToken: string, ref = ""): Promise<Response> {
  const suffix = ref ? `/zipball/${encodeURIComponent(ref).replace(/%2F/g, "/")}` : "/zipball";
  const first = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}${suffix}`, {
    headers: githubHeaders(githubToken),
    redirect: "manual"
  });

  if ([301, 302, 303, 307, 308].includes(first.status)) {
    const location = first.headers.get("Location");
    if (!location) return first;
    return fetch(location, {
      headers: { "User-Agent": "Nativize-Artifact-Download" },
      redirect: "follow"
    });
  }

  return first;
}

async function readDownloadBytes(response: Response): Promise<ArrayBuffer> {
  const length = Number(response.headers.get("Content-Length") || "0");
  if (Number.isFinite(length) && length > MAX_ARTIFACT_BYTES) {
    throw Object.assign(new Error("Download is too large to prepare here."), { status: 413 });
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw Object.assign(new Error("Download is too large to prepare here."), { status: 413 });
  }
  return bytes;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let step = "start";
  try {
    step = "create-client";
    const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false }
    });

    step = "read-auth";
    const authHeader = req.headers.get("Authorization") || "";
    if (authHeader.length > MAX_AUTH_HEADER) return json({ error: "Invalid authorization header." }, 400);
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!jwt) {
      await checkRateLimit(supabase, `artifact-anon:${requestIp(req)}`, 10, 900);
      return json({ error: "Sign in is required." }, 401);
    }

    step = "verify-user";
    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data.user) {
      await checkRateLimit(supabase, `artifact-invalid:${requestIp(req)}`, 10, 900);
      return json({ error: "Invalid Supabase session." }, 401);
    }
    step = "rate-limit";
    await checkRateLimit(supabase, `artifact-user:${data.user.id}`, 30, 900);

    step = "read-body";
    const body = await readJsonBody(req);
    const githubToken = cleanToken(body.githubToken);
    const kind = String(body.kind || "artifact").toLowerCase();
    let download: Response;
    let filename = cleanFilename(kind === "project" ? body.filename || "Nativized Source Code.zip" : body.filename);

    if (kind === "project") {
      step = "authorize-project";
      await requirePaidPlan(
        supabase,
        data.user.id,
        "A paid Nativize plan is required to download Full Source Code."
      );

      step = "fetch-project";
      const repo = cleanRepo(body.repo);
      const ref = cleanRef(body.ref);
      download = await fetchGithubProjectZip(repo, githubToken, ref);
      if (!download.ok) {
        const detail = await githubError(download);
        return json({ error: `Could not download Full Source Code (${detail}).` }, download.status === 404 ? 404 : 502);
      }
    } else {
      step = "verify-artifact";
      const parsed = parseArtifactUrl(body.artifactUrl);
      const meta = await fetchGithubArtifactMetadata(parsed.ref, githubToken);
      if (!meta.name) return json({ error: "Could not verify this download." }, 502);
      if (meta.expired) return json({ error: "This build download has expired. Run the build again." }, 410);
      if (artifactRequiresPaid(meta.name)) {
        await requirePaidPlan(
          supabase,
          data.user.id,
          "A paid Nativize plan is required to download this project package."
        );
      }
      filename = cleanFilename(body.filename || `${meta.name}.zip`);

      step = "fetch-github";
      download = await fetchGithubArtifact(parsed.url, githubToken);

      if (!download.ok) {
        const detail = await githubError(download);
        return json({ error: `Could not download this app (${detail}).` }, download.status === 404 ? 404 : 502);
      }
    }
    step = "read-download";
    const bytes = await readDownloadBytes(download);

    step = "respond";
    const headers = new Headers(corsHeaders);
    headers.set("Content-Type", download.headers.get("Content-Type") || "application/zip");
    headers.set("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Length", String(bytes.byteLength));

    return new Response(bytes, { status: 200, headers });
  } catch (err) {
    console.error(err);
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    if (status === 400 || status === 401 || status === 402 || status === 404 || status === 410 || status === 413 || status === 429) {
      return json({ error: err instanceof Error ? err.message : "Request failed." }, status);
    }
    return json({ error: `Artifact download failed at ${step}.` }, 500);
  }
});
