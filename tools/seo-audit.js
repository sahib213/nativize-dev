#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const SITE = path.join(ROOT, "website");
const ORIGIN = "https://nativize.dev";
const CHROME_STORE_URL = "https://chromewebstore.google.com/detail/mofjfbhfeanhffcfighdmhdboimiienb?utm_source=item-share-cb";
const SCRIPT_CACHE_KEY = "20260708-chrome-store";
const errors = [];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function rel(file) {
  return path.relative(ROOT, file);
}

function fail(file, message) {
  errors.push(`${rel(file)}: ${message}`);
}

function match(content, pattern) {
  return (content.match(pattern) || [])[1] || "";
}

function isRedirect(content) {
  return /<meta http-equiv="refresh"/i.test(content);
}

function publicHtmlFiles() {
  return walk(SITE).filter((file) => file.endsWith(".html"));
}

function pathForUrl(url) {
  if (!url.startsWith(`${ORIGIN}/`)) return null;
  const pathname = new URL(url).pathname;
  if (pathname === "/") return path.join(SITE, "index.html");
  if (pathname.endsWith("/")) return path.join(SITE, pathname, "index.html");
  return path.join(SITE, pathname);
}

for (const file of publicHtmlFiles()) {
  const content = fs.readFileSync(file, "utf8");
  if (rel(file) === "website/google887b90a064d7ffe6.html") continue;

  if (/<meta name="keywords"/i.test(content)) {
    fail(file, "remove obsolete meta keywords tag");
  }

  if (isRedirect(content)) {
    if (!/<meta name="robots" content="noindex,follow" \/>/.test(content)) {
      fail(file, "redirect shim must be noindex,follow");
    }
    if (!/<link rel="canonical" href="https:\/\/nativize\.dev\//.test(content)) {
      fail(file, "redirect shim needs an absolute canonical URL");
    }
    continue;
  }

  const title = match(content, /<title>([^<]+)<\/title>/);
  const description = match(content, /<meta name="description" content="([^"]+)" \/>/);
  const robots = match(content, /<meta name="robots" content="([^"]+)" \/>/);
  const canonical = match(content, /<link rel="canonical" href="([^"]+)" \/>/);
  const ogTitle = /<meta property="og:title" content="[^"]+" \/>/.test(content);
  const ogDescription = /<meta property="og:description" content="[^"]+" \/>/.test(content);
  const ogImage = /<meta property="og:image" content="https:\/\/nativize\.dev\/og-image\.png" \/>/.test(content);
  const twitterTitle = /<meta name="twitter:title" content="[^"]+" \/>/.test(content);
  const twitterDescription = /<meta name="twitter:description" content="[^"]+" \/>/.test(content);
  const twitterImage = /<meta name="twitter:image" content="https:\/\/nativize\.dev\/og-image\.png" \/>/.test(content);
  const staticIcons = /<link rel="icon" href="\/favicon\.ico" sizes="any" \/>/.test(content)
    && /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" \/>/.test(content)
    && /<link rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png" \/>/.test(content)
    && /<link rel="manifest" href="\/site\.webmanifest" \/>/.test(content);
  const h1 = /<h1[\s>]/.test(content);
  const scriptRefs = [...content.matchAll(/<script src="\/script\.js\?v=([^"]+)" defer><\/script>/g)].map((m) => m[1]);
  const ctaHrefs = [...content.matchAll(/<a\b[^>]*data-cta="[^"]+"[^>]*href="([^"]+)"/g)].map((m) => m[1]);

  if (!title) fail(file, "missing title");
  if (!description) fail(file, "missing meta description");
  if (!robots || /noindex/i.test(robots)) fail(file, "public page should be indexable");
  if (!canonical.startsWith(`${ORIGIN}/`)) fail(file, "canonical must be absolute nativize.dev URL");
  if (!ogTitle || !ogDescription || !ogImage) fail(file, "missing complete Open Graph metadata");
  if (!twitterTitle || !twitterDescription || !twitterImage) fail(file, "missing complete Twitter metadata");
  if (!staticIcons) fail(file, "missing static favicon/apple-touch/manifest links");
  if (!h1) fail(file, "missing crawlable h1");
  for (const scriptRef of scriptRefs) {
    if (scriptRef !== SCRIPT_CACHE_KEY) {
      fail(file, `stale script.js cache key: ${scriptRef}`);
    }
  }
  for (const href of ctaHrefs) {
    if (href !== CHROME_STORE_URL) {
      fail(file, `data-cta link should point to Chrome Web Store, got ${href}`);
    }
  }

  const jsonLdBlocks = [...content.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  if (!jsonLdBlocks.length) {
    fail(file, "missing JSON-LD");
  }
  for (const block of jsonLdBlocks) {
    try {
      JSON.parse(block[1]);
    } catch (err) {
      fail(file, `invalid JSON-LD: ${err.message}`);
    }
  }
}

const sitemapPath = path.join(SITE, "sitemap.xml");
const sitemap = fs.readFileSync(sitemapPath, "utf8");
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
for (const url of urls) {
  const target = pathForUrl(url);
  if (!target) {
    fail(sitemapPath, `non-nativize URL in sitemap: ${url}`);
    continue;
  }
  if (!fs.existsSync(target)) {
    fail(sitemapPath, `sitemap URL has no deployed file: ${url}`);
    continue;
  }
  if (target.endsWith(".html")) {
    const content = fs.readFileSync(target, "utf8");
    if (/<meta name="robots" content="[^"]*noindex/i.test(content)) {
      fail(sitemapPath, `sitemap includes noindex page: ${url}`);
    }
    const canonical = match(content, /<link rel="canonical" href="([^"]+)" \/>/);
    if (canonical && canonical !== url) {
      fail(sitemapPath, `canonical mismatch for ${url}: ${canonical}`);
    }
  }
}

for (const required of [
  `${ORIGIN}/github-to-native-app/`,
  `${ORIGIN}/blog/`,
  `${ORIGIN}/blog/ship-lovable-app-to-app-store/`,
  `${ORIGIN}/nativize-vs-capacitor/`,
  `${ORIGIN}/feed.xml`,
]) {
  if (!urls.includes(required)) fail(sitemapPath, `missing sitemap URL: ${required}`);
}

JSON.parse(fs.readFileSync(path.join(SITE, "nativize-facts.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(SITE, "site.webmanifest"), "utf8"));

for (const asset of [
  "favicon.ico",
  "favicon.svg",
  "favicon-32.png",
  "favicon-192.png",
  "favicon-512.png",
  "apple-touch-icon.png",
  "site.webmanifest",
]) {
  const assetPath = path.join(SITE, asset);
  if (!fs.existsSync(assetPath)) fail(assetPath, "missing referenced icon or manifest asset");
}

if (errors.length) {
  console.error(`SEO audit failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`SEO audit passed for ${publicHtmlFiles().length} HTML files and ${urls.length} sitemap URLs.`);
