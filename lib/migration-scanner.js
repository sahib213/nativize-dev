/*
 * Nativize Migration Hub — project scanner.
 *
 * Runs 100% in the browser: the uploaded ZIP is unpacked and read locally,
 * nothing is sent to any server. Output contains ONLY safe metadata —
 * file paths, counts, secret NAMES (never values), and redacted excerpts.
 *
 * Redaction is applied to every excerpt before it can leave this module.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NativizeMigrationScanner = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MAX_FILES = 6000;
  var MAX_ARCHIVE_BYTES = 120 * 1024 * 1024;
  var MAX_TEXT_BYTES = 1024 * 1024; // per-file cap for text scanning
  var MAX_TOTAL_TEXT_BYTES = 25 * 1024 * 1024;
  var TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|sql|toml|md|txt|html|css|scss|yml|yaml|env|sh|xml|svelte|vue|astro|lock|example|local|production|development)$/i;

  /* ================= Redaction (mandatory, see safety rules) ================= */
  function maskValue(v) {
    if (!v) return "";
    if (v.length <= 8) return "••••";
    return v.slice(0, 4) + "…" + v.slice(-4);
  }
  var TOKEN_PATTERNS = [
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,          // JWTs
    /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g,                       // Stripe keys
    /\bwhsec_[A-Za-z0-9]{8,}\b/g,                                            // Stripe webhook secrets
    /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}\b/g,                      // Supabase keys
    /\bAIza[0-9A-Za-z_-]{30,}\b/g,                                           // Google API keys
    /\bya29\.[0-9A-Za-z_-]{20,}\b/g,                                         // Google OAuth tokens
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,                         // GitHub tokens
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,                                     // Slack
    /\bre_[A-Za-z0-9_]{16,}\b/g,                                             // Resend
    /\b(?:appl|goog|amzn|strp|rcb)_[A-Za-z0-9]{16,}\b/g,                     // RevenueCat-style
    /postgres(?:ql)?:\/\/[^\s"'@]+@[^\s"']+/g                                // DB URLs with creds
  ];
  var ASSIGN_PATTERN = /((?:[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASS|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*["']?)([^\s"',;]{8,})/g;

  function redact(text) {
    var out = String(text == null ? "" : text);
    for (var i = 0; i < TOKEN_PATTERNS.length; i++) {
      out = out.replace(TOKEN_PATTERNS[i], function (m) { return maskValue(m); });
    }
    out = out.replace(ASSIGN_PATTERN, function (_m, lead, val) { return lead + maskValue(val); });
    return out;
  }
  function looksLikeSecretValue(v) {
    if (!v || v.length < 12) return false;
    for (var i = 0; i < TOKEN_PATTERNS.length; i++) {
      TOKEN_PATTERNS[i].lastIndex = 0;
      if (TOKEN_PATTERNS[i].test(v)) return true;
    }
    return false;
  }

  /* ================= Minimal ZIP reader (store + deflate) ================= */
  function findEocd(view) {
    for (var i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 22 - 65536); i--) {
      if (view.getUint32(i, true) === 0x06054b50) return i;
    }
    return -1;
  }
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot unpack ZIP files — use Chrome, Edge, Safari 16.4+, or Firefox 113+.");
    var ds = new DecompressionStream("deflate-raw");
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    var buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  async function unzip(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength > MAX_ARCHIVE_BYTES) throw new Error("ZIP is over the 120 MB safety limit.");
    var view = new DataView(arrayBuffer);
    var bytes = new Uint8Array(arrayBuffer);
    var eocd = findEocd(view);
    if (eocd < 0) throw new Error("Not a valid ZIP file.");
    var count = view.getUint16(eocd + 10, true);
    if (count > MAX_FILES) throw new Error("ZIP contains more than " + MAX_FILES + " files. Exclude node_modules, .git, and build output, then try again.");
    var cdOffset = view.getUint32(eocd + 16, true);
    var files = [];
    var p = cdOffset;
    var decoder = new TextDecoder();
    for (var i = 0; i < count && i < MAX_FILES; i++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      var method = view.getUint16(p + 10, true);
      var compSize = view.getUint32(p + 20, true);
      var rawSize = view.getUint32(p + 24, true);
      var nameLen = view.getUint16(p + 28, true);
      var extraLen = view.getUint16(p + 30, true);
      var commentLen = view.getUint16(p + 32, true);
      var localOffset = view.getUint32(p + 42, true);
      var name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith("/")) continue; // directory
      files.push({ path: name, method: method, compSize: compSize, size: rawSize, localOffset: localOffset });
    }
    // Read text contents lazily-but-eagerly for scannable files.
    var out = [];
    var totalTextBytes = 0;
    for (var j = 0; j < files.length; j++) {
      var f = files[j];
      var entry = { path: f.path, size: f.size, text: null };
      var base = f.path.split("/").pop() || "";
      var isEnvName = /^\.env(\..+)?$/.test(base);
      if ((TEXT_EXT.test(f.path) || isEnvName || /(^|\/)(Dockerfile|Procfile|Makefile)$/.test(f.path)) && f.size <= MAX_TEXT_BYTES) {
        totalTextBytes += f.size;
        if (totalTextBytes > MAX_TOTAL_TEXT_BYTES) throw new Error("Project contains more than 25 MB of text to scan. Exclude generated files and try again.");
        try {
          var lo = f.localOffset;
          if (view.getUint32(lo, true) === 0x04034b50) {
            var lNameLen = view.getUint16(lo + 26, true);
            var lExtraLen = view.getUint16(lo + 28, true);
            var start = lo + 30 + lNameLen + lExtraLen;
            var comp = bytes.subarray(start, start + f.compSize);
            var raw = f.method === 0 ? comp : f.method === 8 ? await inflateRaw(comp) : null;
            if (raw) entry.text = decoder.decode(raw);
          }
        } catch (e) { /* unreadable entry — keep metadata only */ }
      }
      out.push(entry);
    }
    return out;
  }

  /* ================= Detection ================= */
  function stripRoot(files) {
    // GitHub ZIPs wrap everything in "repo-branch/" — normalize that away.
    if (!files.length) return files;
    var first = files[0].path.split("/")[0];
    if (!first) return files;
    var allShare = files.every(function (f) { return f.path.split("/")[0] === first; });
    if (!allShare) return files;
    return files.map(function (f) {
      return { path: f.path.slice(first.length + 1), size: f.size, text: f.text };
    }).filter(function (f) { return f.path; });
  }

  var INTEGRATIONS = [
    { id: "revenuecat", label: "RevenueCat", re: /revenuecat|purchases-js|rc_[a-z]{4}|api\.revenuecat\.com/i },
    { id: "stripe", label: "Stripe / payments", re: /stripe|checkout\.session|payment_intent/i },
    { id: "webhooks", label: "Webhooks", re: /webhook/i },
    { id: "youtube", label: "YouTube API", re: /youtube|googleapis\.com\/youtube/i },
    { id: "soundcloud", label: "SoundCloud", re: /soundcloud/i },
    { id: "audius", label: "Audius", re: /audius/i },
    { id: "deezer", label: "Deezer", re: /deezer/i },
    { id: "lastfm", label: "Last.fm", re: /last\.fm|audioscrobbler|lastfm/i },
    { id: "ai", label: "Gemini / OpenAI", re: /generativelanguage|gemini-|openai|gpt-4|anthropic/i },
    { id: "email", label: "Email provider", re: /resend\.com|sendgrid|postmark|mailgun|nodemailer|smtp/i },
    { id: "cron", label: "Cron jobs", re: /pg_cron|cron\.schedule|schedule\(|crontab/i },
    { id: "push", label: "Push notifications", re: /push.?notification|fcm|apns|onesignal/i },
    { id: "family", label: "Family / invites", re: /family_invite|invite_code|accept_invite/i }
  ];

  function scan(inputFiles) {
    var files = stripRoot(inputFiles || []);
    var r = {
      fileCount: files.length,
      sqlMigrations: [],          // paths
      edgeFunctions: [],          // {name, path, secrets[], hasDenoJson, importsShared, usesServiceRole, externalApis[], hasEnvErrorHandling}
      hasConfigToml: false,
      clientFiles: [],            // supabase client files
      projectRefs: [],            // detected *.supabase.co refs (safe: refs are public)
      secrets: [],                // {name, files[], scope: "server"|"frontend", suspicious}
      storageBuckets: [],         // bucket names
      authRedirects: [],          // files with redirectTo / deep links
      deepLinks: [],              // custom schemes
      envFiles: [],               // {path, gitWarning}
      envTracked: false,
      integrations: [],           // {id,label,files[]}
      warnings: []
    };

    var secretMap = {};
    var refSet = {};
    var bucketSet = {};
    var schemeSet = {};
    var integrationMap = {};
    var fnMap = {};
    var gitignoreText = "";
    var hasGitDir = false;

    function fnOf(path) {
      var m = path.match(/^supabase\/functions\/([^/]+)\//);
      if (!m || m[1] === "_shared") return null;
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(m[1])) {
        if (!r.warnings.some(function (w) { return w.text === "An edge function folder has an unsafe name and was excluded from commands: " + m[1]; })) {
          r.warnings.push({ level: "danger", text: "An edge function folder has an unsafe name and was excluded from commands: " + m[1] });
        }
        return null;
      }
      if (!fnMap[m[1]]) fnMap[m[1]] = { name: m[1], secrets: [], hasDenoJson: false, importsShared: false, usesServiceRole: false, externalApis: [], hasEnvErrorHandling: false, files: 0 };
      return fnMap[m[1]];
    }

    files.forEach(function (f) {
      // Paths are metadata too: redact token-looking segments before any path
      // can appear in scan output, warnings, logs, or saved summaries.
      var path = redact(f.path).slice(0, 500);
      var base = path.split("/").pop() || "";
      var text = f.text || "";

      if (path.indexOf(".git/") === 0 || path.indexOf("/.git/") > -1) { hasGitDir = true; return; }
      if (path.indexOf("node_modules/") === 0 || path.indexOf("/node_modules/") > -1) return;

      if (/^supabase\/migrations\/.+\.sql$/.test(path)) r.sqlMigrations.push(path);
      if (path === "supabase/config.toml") r.hasConfigToml = true;
      if (base === ".gitignore" && path === ".gitignore") gitignoreText = text;

      if (/^\.env(\..+)?$/.test(base) && !/\.example$/.test(base)) {
        r.envFiles.push({ path: path });
        // Only names are recorded — never values.
        text.split("\n").forEach(function (line) {
          var m = line.match(/^\s*([A-Z][A-Z0-9_]{2,})\s*=/);
          if (m) addSecret(m[1], path, "env-file");
        });
      }

      var fn = fnOf(path);
      if (fn) {
        fn.files++;
        if (base === "deno.json" || base === "deno.jsonc") fn.hasDenoJson = true;
      }

      if (!text) return;

      // Supabase client files
      if (/@supabase\/supabase-js|createClient\s*\(/.test(text) && /\.(ts|tsx|js|jsx)$/.test(path) && path.indexOf("supabase/functions/") !== 0) {
        r.clientFiles.push(path);
      }

      // Old project refs (project refs are public identifiers — safe to list)
      var refRe = /([a-z0-9]{20})\.supabase\.co/g, rm;
      while ((rm = refRe.exec(text))) refSet[rm[1]] = true;

      // Deno.env.get secrets
      var envRe = /Deno\.env\.get\(\s*["']([A-Z0-9_]+)["']\s*\)/g, em;
      while ((em = envRe.exec(text))) {
        addSecret(em[1], path, "server");
        if (fn && fn.secrets.indexOf(em[1]) < 0) fn.secrets.push(em[1]);
      }
      // Frontend env names
      var feRe = /import\.meta\.env\.(VITE_[A-Z0-9_]+)|process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g, fem;
      while ((fem = feRe.exec(text))) addSecret(fem[1] || fem[2], path, "frontend");

      // Storage buckets
      var bkRe = /\.storage[\s\S]{0,40}?\.from\(\s*["']([A-Za-z0-9_-]+)["']\s*\)|storage\.from\(\s*["']([A-Za-z0-9_-]+)["']\s*\)/g, bm;
      while ((bm = bkRe.exec(text))) bucketSet[bm[1] || bm[2]] = true;

      // Auth redirects + deep links
      if (/redirectTo|redirect_to|emailRedirectTo/.test(text)) r.authRedirects.push(path);
      var dlRe = /["']([a-z][a-z0-9+.-]{2,30}):\/\//g, dm;
      while ((dm = dlRe.exec(text))) {
        var s = dm[1];
        if (["http", "https", "ws", "wss", "file", "data", "blob", "mailto", "tel", "postgres", "postgresql"].indexOf(s) < 0) schemeSet[s] = true;
      }

      // Edge function specifics
      if (fn && /\.(ts|js)$/.test(path)) {
        if (/SUPABASE_SERVICE_ROLE_KEY/.test(text)) fn.usesServiceRole = true;
        if (/from\s+["']\.\.\/_shared\//.test(text) || /["']\.\.\/_shared\//.test(text)) fn.importsShared = true;
        if (/https?:\/\/(?!.*supabase\.co)[a-z0-9.-]+\.[a-z]{2,}/i.test(text)) {
          var apiRe = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi, am;
          while ((am = apiRe.exec(text))) {
            var host = am[1].toLowerCase();
            if (host.indexOf("supabase.co") < 0 && host.indexOf("deno.land") < 0 && host.indexOf("esm.sh") < 0 && host.indexOf("jsr.io") < 0 && host.indexOf("w3.org") < 0 && fn.externalApis.indexOf(host) < 0 && fn.externalApis.length < 8) fn.externalApis.push(host);
          }
        }
        if (/if\s*\(\s*!\w+\s*\)|Missing\s+[A-Z0-9_]+|throw new Error\([^)]*env/i.test(text)) fn.hasEnvErrorHandling = true;
      }

      // Integrations
      INTEGRATIONS.forEach(function (integ) {
        if (integ.re.test(text)) {
          if (!integrationMap[integ.id]) integrationMap[integ.id] = { id: integ.id, label: integ.label, files: [] };
          if (integrationMap[integ.id].files.length < 6) integrationMap[integ.id].files.push(path);
        }
      });
    });

    function addSecret(name, path, scope) {
      if (!name) return;
      if (!secretMap[name]) secretMap[name] = { name: name, files: [], scope: scope, suspicious: false };
      if (secretMap[name].files.indexOf(path) < 0 && secretMap[name].files.length < 8) secretMap[name].files.push(path);
      if (scope === "server") secretMap[name].scope = "server";
      if (scope === "frontend" && /KEY|SECRET|TOKEN|PASSWORD|SERVICE/.test(name) && !/PUBLISHABLE|PUBLIC|ANON/.test(name)) secretMap[name].suspicious = true;
    }

    r.edgeFunctions = Object.keys(fnMap).sort().map(function (k) { return fnMap[k]; });
    r.secrets = Object.keys(secretMap).sort().map(function (k) { return secretMap[k]; });
    r.projectRefs = Object.keys(refSet);
    r.storageBuckets = Object.keys(bucketSet);
    r.deepLinks = Object.keys(schemeSet);
    r.integrations = Object.keys(integrationMap).map(function (k) { return integrationMap[k]; });
    r.clientFiles = r.clientFiles.slice(0, 20);
    r.authRedirects = r.authRedirects.slice(0, 20);
    r.sqlMigrations.sort();

    // .env tracked by Git?
    if (r.envFiles.length) {
      var ignoresEnv = /(^|\n)\s*\.?env(\.\w+)?\s*(\n|$)|(^|\n)\s*\.env\*/.test(gitignoreText) || /(^|\n)\s*\.env/.test(gitignoreText);
      r.envTracked = hasGitDir ? !ignoresEnv : !ignoresEnv;
      r.warnings.push({
        level: "danger",
        text: r.envFiles.length + " .env file" + (r.envFiles.length > 1 ? "s" : "") + " found in the project (" + r.envFiles.map(function (e) { return e.path; }).join(", ") + "). Delete them from the export and ROTATE any keys they contain" + (r.envTracked ? " — they do not appear to be covered by .gitignore, so they may be tracked by Git." : ".")
      });
    }
    if (r.projectRefs.length > 1) r.warnings.push({ level: "warn", text: "Multiple Supabase project refs found (" + r.projectRefs.join(", ") + ") — old refs must be replaced with the target project's ref." });
    else if (r.projectRefs.length === 1) r.warnings.push({ level: "warn", text: "Project ref " + r.projectRefs[0] + " is referenced in code — replace it with the target project's ref during migration." });
    r.secrets.forEach(function (s) {
      if (s.suspicious) r.warnings.push({ level: "danger", text: s.name + " looks like a private secret but is exposed to the frontend (" + s.files[0] + "). Move it to an edge function." });
    });

    return r;
  }

  /* ================= Size + risk ================= */
  function sizeOf(scanResult) {
    var sqls = scanResult.sqlMigrations.length, fns = scanResult.edgeFunctions.length;
    if (sqls >= 100 || fns >= 50) return "complex";
    if (sqls >= 50 || fns >= 20) return "large";
    if (sqls >= 10 || fns >= 5) return "medium";
    return "small";
  }
  function riskOf(scanResult) {
    var danger = scanResult.warnings.some(function (w) { return w.level === "danger"; });
    if (danger) return { level: "danger", label: "Danger", reasons: scanResult.warnings.filter(function (w) { return w.level === "danger"; }).map(function (w) { return w.text; }) };
    if (scanResult.warnings.length || scanResult.projectRefs.length) return { level: "warn", label: "Needs attention", reasons: scanResult.warnings.map(function (w) { return w.text; }) };
    return { level: "safe", label: "Safe", reasons: [] };
  }
  function isSupabaseStyle(scanResult) {
    return scanResult.sqlMigrations.length > 0 || scanResult.edgeFunctions.length > 0 || scanResult.hasConfigToml || scanResult.clientFiles.length > 0;
  }

  return {
    unzip: unzip,
    scan: scan,
    redact: redact,
    maskValue: maskValue,
    looksLikeSecretValue: looksLikeSecretValue,
    sizeOf: sizeOf,
    riskOf: riskOf,
    isSupabaseStyle: isSupabaseStyle,
    MAX_FILES: MAX_FILES
  };
});
