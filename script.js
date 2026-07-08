/* ============================================================
   Nativize site — interactions. Zero dependencies.
   ============================================================ */
(function () {
  "use strict";

  /* ---- Config: fill this in when the listing goes live ---- */
  // When the Chrome Web Store listing exists, set CHROME_STORE_URL and every
  // "Add to Chrome" button points to it. Until then they point to Get Started.
  var CHROME_STORE_URL = "https://chromewebstore.google.com/detail/mofjfbhfeanhffcfighdmhdboimiienb?utm_source=item-share-cb";

  /* ---- Analytics: paste your GA4 Measurement ID to turn it on ----
     1. Create a GA4 property at https://analytics.google.com (free).
     2. Copy the "Measurement ID" (looks like G-XXXXXXXXXX).
     3. Paste it below. Analytics stays fully OFF while this is empty,
        and the CSP already whitelists Google Analytics so it just works. */
  var GA_MEASUREMENT_ID = ""; // e.g. "G-XXXXXXXXXX"
  (function loadAnalytics() {
    if (!GA_MEASUREMENT_ID) return;
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(GA_MEASUREMENT_ID);
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    window.gtag = gtag;
    gtag("js", new Date());
    gtag("config", GA_MEASUREMENT_ID, { anonymize_ip: true });
  })();

  // Supabase feedback forms. The anon key is publishable; protect the tables
  // with RLS so anonymous visitors can insert but cannot read existing rows.
  var SUPABASE_URL = "https://gaaxcbarmiwtojblkkyh.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_mAA5LXz9HFHlwVzkA1SCEg_ybxHh_X7";
  var FEEDBACK_TABLES = {
    feature: "feature_requests",
    support: "support_requests"
  };
  var FEEDBACK_FUNCTION_URL = SUPABASE_URL + "/functions/v1/feedback-submit";

  /* ---- First-party pageview counter (no cookies, no Google, no PII) ----
     Logs an insert-only row into Supabase page_views. It never reads data.
     Aggregation happens only in the local dashboard (tools/dashboard.js).
     Set COUNT_PAGEVIEWS = false to disable. */
  var COUNT_PAGEVIEWS = true;
  (function logPageView() {
    if (!COUNT_PAGEVIEWS || !SUPABASE_URL || !SUPABASE_ANON_KEY) return;
    if (navigator.doNotTrack === "1" || window.doNotTrack === "1") return; // respect DNT
    try {
      var today = new Date().toISOString().slice(0, 10);
      var key = "nz_seen_" + today;
      var isNew = false;
      try {
        if (!window.localStorage.getItem(key)) { isNew = true; window.localStorage.setItem(key, "1"); }
      } catch (e) { /* storage blocked — count as a view without unique flag */ }
      var refHost = null;
      try {
        if (document.referrer) {
          var host = new URL(document.referrer).host;
          if (host && host !== location.host) refHost = host.slice(0, 180);
        }
      } catch (e) { /* ignore */ }
      fetch(SUPABASE_URL + "/rest/v1/page_views", {
        method: "POST",
        credentials: "omit",
        keepalive: true,
        headers: {
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + SUPABASE_ANON_KEY,
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
        },
        body: JSON.stringify({
          path: location.pathname.slice(0, 300),
          referrer_host: refHost,
          is_new_visitor: isNew
        })
      }).catch(function () { /* analytics must never break the page */ });
    } catch (e) { /* never throw from analytics */ }
  })();

  var GITHUB_LOGIN_URL = "/app/?login=github";
  var GITHUB_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

  var prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var ROUTES = {
    home: "/",
    how: "/how-it-works/",
    best: "/best-app-to-turn-lovable-into-native-app/",
    lovable: "/lovable-to-native-app/",
    aiBuilders: "/ai-app-builder-to-native-app/",
    githubNative: "/github-to-native-app/",
    blog: "/blog/",
    capacitor: "/nativize-vs-capacitor/",
    useCases: "/use-cases/",
    compare: "/compare/",
    features: "/features/",
    pricing: "/pricing/",
    security: "/security/",
    getStarted: "/get-started/",
    support: "/support/",
    faq: "/faq/",
    featureRequest: "/feature-request/"
  };

  /* ---- Keep the top nav identical across marketing pages ---- */
  function renderSharedHeader() {
    if (document.body && document.body.classList.contains("app-body")) return;
    var header = document.querySelector(".site-header");
    if (!header) return;
    header.id = "siteHeader";
    header.innerHTML =
      '<nav class="nav container">' +
        '<a class="brand" href="' + ROUTES.home + '" aria-label="Nativize home">' +
          '<span class="brand-mark" aria-hidden="true">' +
            '<svg viewBox="0 0 128 128"><defs><linearGradient id="bm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset=".5" stop-color="#4f46e5"/><stop offset="1" stop-color="#2563eb"/></linearGradient></defs><rect width="128" height="128" rx="28" fill="url(#bm)"/><path d="M64 30 L86 54 L72 54 L72 96 L56 96 L56 54 L42 54 Z" fill="white"/></svg>' +
          '</span>' +
          '<span class="brand-name">Nativize</span>' +
        '</a>' +
        '<div class="nav-links" id="navLinks">' +
          '<a href="' + ROUTES.how + '">How it works</a>' +
          '<a class="nav-extra" href="' + ROUTES.lovable + '">Lovable guide</a>' +
          '<a href="' + ROUTES.best + '">Best app</a>' +
          '<a class="nav-extra" href="' + ROUTES.aiBuilders + '">AI builders</a>' +
          '<a class="nav-extra" href="' + ROUTES.githubNative + '">GitHub to app</a>' +
          '<a class="nav-extra" href="' + ROUTES.useCases + '">Use cases</a>' +
          '<a class="nav-extra" href="' + ROUTES.blog + '">Blog</a>' +
          '<a href="' + ROUTES.compare + '">Compare</a>' +
          '<a class="nav-extra" href="' + ROUTES.features + '">Features</a>' +
          '<a href="' + ROUTES.pricing + '">Pricing</a>' +
          '<a class="nav-extra" href="' + ROUTES.security + '">Security</a>' +
          '<a class="nav-extra" href="' + ROUTES.support + '">Support</a>' +
          '<a href="' + ROUTES.faq + '">FAQ</a>' +
        '</div>' +
        '<div class="nav-cta">' +
          '<a class="btn btn-github-login" href="' + GITHUB_LOGIN_URL + '">' + GITHUB_ICON + '<span>Log in with GitHub</span></a>' +
          '<a class="btn btn-primary" href="' + (CHROME_STORE_URL || ROUTES.getStarted) + '" data-cta="header">Add to Chrome</a>' +
        '</div>' +
        '<button class="nav-toggle" id="navToggle" aria-label="Menu"><span></span><span></span><span></span></button>' +
      '</nav>';
  }

  renderSharedHeader();

  /* ---- Keep one clean, column-aligned footer across every marketing page ---- */
  function renderSharedFooter() {
    if (document.body && document.body.classList.contains("app-body")) return;
    var footer = document.querySelector(".site-footer");
    if (!footer) return;
    var year = new Date().getFullYear();
    function col(title, links) {
      return '<div class="footer-col"><h4>' + title + '</h4>' +
        links.map(function (l) {
          return '<a href="' + l[1] + '"' + (l[2] || "") + '>' + l[0] + '</a>';
        }).join("") + '</div>';
    }
    footer.innerHTML =
      '<div class="container footer-inner">' +
        '<div class="footer-brand">' +
          '<span class="brand-mark sm" aria-hidden="true"><svg viewBox="0 0 128 128"><defs><linearGradient id="bmf" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset=".5" stop-color="#4f46e5"/><stop offset="1" stop-color="#2563eb"/></linearGradient></defs><rect width="128" height="128" rx="28" fill="url(#bmf)"/><path d="M64 30 L86 54 L72 54 L72 96 L56 96 L56 54 L42 54 Z" fill="white"/></svg></span>' +
          '<div><strong>Nativize</strong>' +
            '<p>Lovable &rarr; native iOS, Android, Mac &amp; Windows. Generation runs in your browser.</p>' +
          '</div>' +
        '</div>' +
        '<nav class="footer-cols" aria-label="Footer">' +
          col("Product", [
            ["How it works", ROUTES.how],
            ["Open Studio", "/app/"],
            ["Features", ROUTES.features],
            ["Pricing", ROUTES.pricing],
            ["Compare", ROUTES.compare],
            ["Security", ROUTES.security]
          ]) +
          col("Guides", [
            ["Lovable guide", ROUTES.lovable],
            ["GitHub to native app", ROUTES.githubNative],
            ["AI builders", ROUTES.aiBuilders],
            ["Manual Capacitor", ROUTES.capacitor],
            ["Use cases", ROUTES.useCases],
            ["Best app", ROUTES.best],
            ["Blog", ROUTES.blog],
            ["FAQ", "/faq/"]
          ]) +
          col("Company", [
            ["Support", ROUTES.support],
            ["Request a feature", ROUTES.featureRequest],
            ["Privacy", "/privacy/"],
            ["Terms", "/terms/"]
          ]) +
        '</nav>' +
      '</div>' +
      '<div class="container footer-bottom">' +
        '<span>&copy; ' + year + ' Nativize &middot; Built on Capacitor 8</span>' +
        '<span class="footer-note">Not affiliated with Lovable, Apple, Google or Microsoft.</span>' +
      '</div>';
  }
  renderSharedFooter();

  /* ---- Wire CTAs ---- */
  document.querySelectorAll("[data-cta]").forEach(function (el) {
    if (CHROME_STORE_URL) {
      el.setAttribute("href", CHROME_STORE_URL);
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener");
    } else {
      el.setAttribute("href", ROUTES.getStarted);
    }
  });
  /* ---- Year ---- */
  var y = document.getElementById("year");
  if (y) y.textContent = new Date().getFullYear();

  /* ---- Pricing cards (rendered from plans.js so they never drift) ---- */
  var pricingGrid = document.getElementById("pricingGrid");
  if (pricingGrid && window.NativizePlans) {
    pricingGrid.innerHTML = window.NativizePlans.PLANS.map(function (p) {
      var isFree = p.id === "free";
      var url = isFree ? "/app/" : "/app/?plan=" + encodeURIComponent(p.id);
      var cta = isFree ? "Start free" : "Get " + p.name;
      var feats = (p.highlights || []).map(function (h) { return "<li>" + h + "</li>"; }).join("");
      return '<article class="price-card card reveal' + (p.popular ? " popular" : "") + '">' +
          (p.popular ? '<span class="price-tag">Most popular</span>' : "") +
          '<h3>' + p.name + '</h3>' +
          '<div class="price-amt"><span class="amt">' + p.price + '</span><span class="per">' + p.priceNote + '</span></div>' +
          '<p class="price-line">' + p.tagline + '</p>' +
          '<ul class="price-feats">' + feats + '</ul>' +
          '<a class="btn ' + (p.popular ? "btn-primary" : "btn-glass") + ' price-cta" href="' + url + '">' + cta + '</a>' +
        '</article>';
    }).join("");
  }

  /* ---- Header: blur/border once scrolled ---- */
  var header = document.getElementById("siteHeader");
  if (header) {
    var onScroll = function () {
      if (window.scrollY > 12) header.classList.add("scrolled");
      else header.classList.remove("scrolled");
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ---- Mobile nav ---- */
  var toggle = document.getElementById("navToggle");
  var links = document.getElementById("navLinks");
  if (toggle && links) {
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", function () {
      var isOpen = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(isOpen));
    });
    links.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        links.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  /* ---- Scroll reveal (staggered) ---- */
  var reveals = Array.prototype.slice.call(document.querySelectorAll(".reveal"));
  if (prefersReduced || !("IntersectionObserver" in window)) {
    reveals.forEach(function (el) { el.classList.add("in"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        // Stagger siblings inside the same grid/row for a cascade effect.
        var sibs = el.parentElement ? Array.prototype.slice.call(el.parentElement.children).filter(function (c) { return c.classList.contains("reveal"); }) : [el];
        var idx = sibs.indexOf(el);
        el.style.transitionDelay = Math.min(idx, 6) * 70 + "ms";
        el.classList.add("in");
        io.unobserve(el);
      });
    }, { threshold: 0.14, rootMargin: "0px 0px -8% 0px" });
    reveals.forEach(function (el) { io.observe(el); });
  }

  /* ---- Feature card spotlight follows cursor ---- */
  if (!prefersReduced) {
    document.querySelectorAll(".feat").forEach(function (card) {
      card.addEventListener("pointermove", function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty("--mx", (e.clientX - r.left) + "px");
        card.style.setProperty("--my", (e.clientY - r.top) + "px");
      });
    });
  }

  /* ---- FAQ: single-open accordion ---- */
  var faqItems = document.querySelectorAll("#faq-list .faq-item");
  faqItems.forEach(function (item) {
    item.addEventListener("toggle", function () {
      if (!item.open) return;
      faqItems.forEach(function (other) {
        if (other !== item) other.open = false;
      });
    });
  });

  /* ---- Supabase: support + feature request forms ---- */
  function formValue(form, name) {
    var value = new FormData(form).get(name);
    return typeof value === "string" ? value.trim() : "";
  }

  function cleanFormText(value, max, label, required) {
    value = String(value || "").trim();
    if (required && !value) throw new Error(label + " is required.");
    if (value.length > max) throw new Error(label + " is too long.");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error(label + " contains invalid characters.");
    return value;
  }

  function cleanEmail(value, required) {
    value = cleanFormText(value, 254, "Email", required).toLowerCase();
    if (value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw new Error("Email is invalid.");
    return value;
  }

  function setFormStatus(form, state, message) {
    var status = form.querySelector(".form-status");
    if (!status) return;
    status.textContent = "";
    status.classList.remove("is-success", "is-error");
    if (state) status.classList.add("is-" + state);
    status.textContent = message || "";
  }

  function setFormFallbackStatus(form, type) {
    var status = form.querySelector(".form-status");
    if (!status) return;
    status.textContent = "";
    status.classList.remove("is-success", "is-error");
    status.classList.add("is-error");
    status.textContent = type === "feature"
      ? "Could not send this feature request yet. Please try again in a moment."
      : "Could not send this support request yet. Please try again in a moment.";
  }

  function setFormBusy(form, busy) {
    var button = form.querySelector("button[type='submit']");
    if (!button) return;
    if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? "Sending..." : button.dataset.idleText;
  }

  function buildFeedbackPayload(form, type) {
    var base = {
      source: "website",
      page_path: cleanFormText(window.location.pathname || "/", 300, "Page path", true)
    };

    if (type === "feature") {
      base.email = cleanEmail(formValue(form, "email"), false) || null;
      base.priority = cleanFormText(formValue(form, "priority"), 30, "Priority", true);
      base.title = cleanFormText(formValue(form, "title"), 120, "Title", true);
      base.description = cleanFormText(formValue(form, "description"), 1200, "Description", true);
      return base;
    }

    base.name = cleanFormText(formValue(form, "name"), 100, "Name", false) || null;
    base.email = cleanEmail(formValue(form, "email"), true);
    base.topic = cleanFormText(formValue(form, "topic"), 40, "Topic", true);
    base.message = cleanFormText(formValue(form, "message"), 1600, "Message", true);
    return base;
  }

  async function insertFeedback(table, payload) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error("Supabase is not configured yet.");
    }

    var response = await fetch(SUPABASE_URL + "/rest/v1/" + encodeURIComponent(table), {
      method: "POST",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      var detail = await response.text();
      throw new Error(detail || ("Supabase insert failed with status " + response.status));
    }
  }

  async function submitFeedbackFunction(type, payload) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error("Supabase is not configured yet.");
    }

    var response = await fetch(FEEDBACK_FUNCTION_URL, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ type: type, payload: payload })
    });

    if (!response.ok) {
      var detail = await response.text();
      var err = new Error(detail || ("Feedback function failed with status " + response.status));
      err.status = response.status;
      throw err;
    }
  }

  async function submitFeedback(type, table, payload) {
    try {
      await submitFeedbackFunction(type, payload);
      return;
    } catch (err) {
      if (err && (err.status === 400 || err.status === 413 || err.status === 429)) throw err;
      await insertFeedback(table, payload);
    }
  }

  document.querySelectorAll("[data-feedback-form]").forEach(function (form) {
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      var type = form.getAttribute("data-feedback-type");
      var table = FEEDBACK_TABLES[type];
      if (!table) return;

      if (formValue(form, "website")) {
        form.reset();
        return;
      }

      setFormBusy(form, true);
      setFormStatus(form, "", "");
      var payload = null;
      try {
        payload = buildFeedbackPayload(form, type);
        await submitFeedback(type, table, payload);
        form.reset();
        setFormStatus(form, "success", type === "feature" ? "Feature request sent. Thank you." : "Support request sent. Thank you.");
      } catch (err) {
        console.error(err);
        if (payload) {
          setFormFallbackStatus(form, type);
        } else {
          setFormStatus(form, "error", (err && err.message) || "Please check the form and try again.");
        }
      } finally {
        setFormBusy(form, false);
      }
    });
  });

  /* ---- Platform glyphs (masked so they take the element's color) ---- */
  var GLYPHS = {
    ios: "M17.05 13.06c-.03-2.7 2.2-4 2.3-4.06-1.25-1.84-3.2-2.09-3.9-2.12-1.66-.17-3.24.98-4.08.98-.84 0-2.14-.96-3.52-.93-1.81.03-3.48 1.05-4.41 2.67-1.88 3.27-.48 8.1 1.35 10.76.9 1.3 1.96 2.76 3.36 2.71 1.35-.05 1.86-.87 3.49-.87 1.63 0 2.09.87 3.52.84 1.45-.03 2.37-1.32 3.26-2.63 1.03-1.5 1.45-2.96 1.47-3.04-.03-.01-2.82-1.08-2.85-4.28zM14.4 5.3c.74-.9 1.24-2.15 1.1-3.4-1.07.04-2.36.71-3.13 1.61-.69.79-1.29 2.06-1.13 3.27 1.19.09 2.42-.6 3.16-1.48z",
    mac: "M5 5h14a1.5 1.5 0 0 1 1.5 1.5V15H3.5V6.5A1.5 1.5 0 0 1 5 5zM2 16.5h20a.5.5 0 0 1 .45.72l-.6 1.2a1 1 0 0 1-.9.58H3.05a1 1 0 0 1-.9-.58l-.6-1.2A.5.5 0 0 1 2 16.5z",
    android: "M7.2 7.6 5.95 5.4a.4.4 0 0 1 .7-.4l1.28 2.22A6.8 6.8 0 0 1 12 6.3c1.5 0 2.9.4 4.07 1.12L17.35 5a.4.4 0 1 1 .7.4L16.8 7.6A5.7 5.7 0 0 1 19 12H5a5.7 5.7 0 0 1 2.2-4.4zM5 13h14v5a1.5 1.5 0 0 1-1.5 1.5h-.6V22a1.2 1.2 0 0 1-2.4 0v-2.5H9.5V22a1.2 1.2 0 0 1-2.4 0v-2.5h-.6A1.5 1.5 0 0 1 5 18v-5zM3.3 13.2a1.2 1.2 0 0 1 2.4 0v3.6a1.2 1.2 0 0 1-2.4 0v-3.6zm15 0a1.2 1.2 0 0 1 2.4 0v3.6a1.2 1.2 0 0 1-2.4 0v-3.6z",
    win: "M3 4.6 11 3.45V11.4H3zM12 3.3 21 2v9.4h-9zM3 12.6h8v7.8L3 19.2zM12 12.6h9V22l-9-1.35z",
    git: "M12 1.6A10.4 10.4 0 0 0 8.7 21.9c.52.1.71-.22.71-.5v-1.7c-2.9.63-3.5-1.4-3.5-1.4-.48-1.2-1.16-1.53-1.16-1.53-.95-.65.07-.64.07-.64 1.05.08 1.6 1.08 1.6 1.08.94 1.6 2.45 1.14 3.05.87.09-.68.36-1.14.66-1.4-2.32-.27-4.76-1.16-4.76-5.17 0-1.14.41-2.07 1.07-2.8-.11-.27-.46-1.34.1-2.78 0 0 .88-.28 2.87 1.07a9.9 9.9 0 0 1 5.22 0c1.99-1.35 2.86-1.07 2.86-1.07.57 1.44.21 2.51.11 2.78.67.73 1.07 1.66 1.07 2.8 0 4.02-2.45 4.9-4.78 5.16.38.32.71.95.71 1.92v2.85c0 .28.19.61.72.5A10.4 10.4 0 0 0 12 1.6z"
  };
  function maskFor(path) {
    var svg = "data:image/svg+xml," + encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='" + path + "'/></svg>"
    );
    return "url(\"" + svg + "\")";
  }
  document.querySelectorAll("[data-platform]").forEach(function (el) {
    var key = el.getAttribute("data-platform");
    var path = GLYPHS[key];
    if (!path) return;
    var m = maskFor(path);
    el.style.webkitMaskImage = m;
    el.style.maskImage = m;
    el.style.webkitMaskRepeat = el.style.maskRepeat = "no-repeat";
    el.style.webkitMaskPosition = el.style.maskPosition = "center";
    el.style.webkitMaskSize = el.style.maskSize = "contain";
    el.style.backgroundColor = "currentColor";
  });
})();
