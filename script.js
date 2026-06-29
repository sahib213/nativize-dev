/* ============================================================
   Nativize site — interactions. Zero dependencies.
   ============================================================ */
(function () {
  "use strict";

  /* ---- Config: fill these in when the listings go live ---- */
  // When the Chrome Web Store listing exists, set CHROME_STORE_URL and every
  // "Add to Chrome" button points to it. Until then they scroll to install steps.
  var CHROME_STORE_URL = ""; // e.g. "https://chrome.google.com/webstore/detail/…"
  var GITHUB_URL = "https://github.com/sahib213/nativize-dev"; // public Nativize repo

  // Supabase feedback forms. The anon key is publishable; protect the tables
  // with RLS so anonymous visitors can insert but cannot read existing rows.
  var SUPABASE_URL = "https://gaaxcbarmiwtojblkkyh.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_mAA5LXz9HFHlwVzkA1SCEg_ybxHh_X7";
  var FEEDBACK_TABLES = {
    feature: "feature_requests",
    support: "support_requests"
  };

  var prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function isHomePage() {
    var path = window.location.pathname.replace(/\/+$/, "");
    return path === "" || path === "/" || path === "/index.html" || /\/index\.html$/.test(path);
  }

  function homeLink(hash) {
    return (isHomePage() ? "" : "index.html") + hash;
  }

  /* ---- Keep the top nav identical across marketing pages ---- */
  function renderSharedHeader() {
    if (document.body && document.body.classList.contains("app-body")) return;
    var header = document.querySelector(".site-header");
    if (!header) return;
    header.id = "siteHeader";
    header.innerHTML =
      '<nav class="nav container">' +
        '<a class="brand" href="' + homeLink("#top") + '" aria-label="Nativize home">' +
          '<span class="brand-mark" aria-hidden="true">' +
            '<svg viewBox="0 0 128 128"><defs><linearGradient id="bm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset=".5" stop-color="#4f46e5"/><stop offset="1" stop-color="#2563eb"/></linearGradient></defs><rect width="128" height="128" rx="28" fill="url(#bm)"/><path d="M64 30 L86 54 L72 54 L72 96 L56 96 L56 54 L42 54 Z" fill="white"/></svg>' +
          '</span>' +
          '<span class="brand-name">Nativize</span>' +
        '</a>' +
        '<div class="nav-links" id="navLinks">' +
          '<a href="' + homeLink("#how") + '">How it works</a>' +
          '<a class="nav-extra" href="lovable-to-native-app.html">Lovable guide</a>' +
          '<a href="' + homeLink("#best-lovable-native-app") + '">Best app</a>' +
          '<a class="nav-extra" href="ai-app-builder-to-native-app.html">AI builders</a>' +
          '<a class="nav-extra" href="use-cases.html">Use cases</a>' +
          '<a href="' + homeLink("#compare") + '">Compare</a>' +
          '<a class="nav-extra" href="' + homeLink("#features") + '">Features</a>' +
          '<a href="' + homeLink("#pricing") + '">Pricing</a>' +
          '<a class="nav-extra" href="' + homeLink("#security") + '">Security</a>' +
          '<a class="nav-extra" href="' + homeLink("#support") + '">Support</a>' +
          '<a href="' + homeLink("#faq") + '">FAQ</a>' +
        '</div>' +
        '<div class="nav-cta">' +
          '<a class="btn btn-ghost" href="https://github.com" target="_blank" rel="noopener" data-gh>GitHub</a>' +
          '<a class="btn btn-primary" href="' + homeLink("#get-started") + '" data-cta="header">Add to Chrome</a>' +
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
            ["How it works", homeLink("#how")],
            ["Features", homeLink("#features")],
            ["Pricing", homeLink("#pricing")],
            ["Compare", homeLink("#compare")],
            ["Security", homeLink("#security")]
          ]) +
          col("Guides", [
            ["Lovable guide", "lovable-to-native-app.html"],
            ["AI builders", "ai-app-builder-to-native-app.html"],
            ["Use cases", "use-cases.html"],
            ["Best app", "best-app-to-turn-lovable-into-native-app.html"],
            ["FAQ", "faq.html"]
          ]) +
          col("Company", [
            ["Support", "support.html"],
            ["Request a feature", homeLink("#feature-request")],
            ["Privacy", "privacy.html"],
            ["Terms", "terms.html"],
            ["GitHub", GITHUB_URL, ' target="_blank" rel="noopener" data-gh']
          ]) +
        '</nav>' +
      '</div>' +
      '<div class="container footer-bottom">' +
        '<span>&copy; ' + year + ' Nativize &middot; Built on Capacitor 8</span>' +
        '<span class="footer-note">Not affiliated with Lovable, Apple, Google or Microsoft.</span>' +
      '</div>';
  }
  renderSharedFooter();

  /* ---- Wire CTAs + GitHub links ---- */
  document.querySelectorAll("[data-cta]").forEach(function (el) {
    if (CHROME_STORE_URL) {
      el.setAttribute("href", CHROME_STORE_URL);
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener");
    } else {
      el.setAttribute("href", homeLink("#get-started"));
    }
  });
  document.querySelectorAll("[data-gh]").forEach(function (el) {
    el.setAttribute("href", GITHUB_URL);
  });

  /* ---- Year ---- */
  var y = document.getElementById("year");
  if (y) y.textContent = new Date().getFullYear();

  /* ---- Pricing cards (rendered from plans.js so they never drift) ---- */
  var pricingGrid = document.getElementById("pricingGrid");
  if (pricingGrid && window.NativizePlans) {
    pricingGrid.innerHTML = window.NativizePlans.PLANS.map(function (p) {
      var isFree = p.id === "free";
      var url = isFree ? "app.html" : "app.html?plan=" + encodeURIComponent(p.id);
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
    toggle.addEventListener("click", function () {
      links.classList.toggle("open");
    });
    links.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () { links.classList.remove("open"); });
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

  function setFormFallbackStatus(form, type, url) {
    var status = form.querySelector(".form-status");
    if (!status) return;
    status.textContent = "";
    status.classList.remove("is-success", "is-error");
    status.classList.add("is-error");
    status.appendChild(document.createTextNode("The support inbox is not ready yet. "));
    var link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = type === "feature" ? "Open a GitHub feature draft" : "Open a GitHub support draft";
    status.appendChild(link);
    status.appendChild(document.createTextNode(" instead. Do not include secrets."));
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

  function feedbackFallbackUrl(type, payload) {
    var title = type === "feature"
      ? "Feature request: " + (payload.title || "Nativize request")
      : "Support request: " + (payload.topic || "Nativize help");
    var body = type === "feature"
      ? [
          "## Feature request",
          "",
          "**Priority:** " + (payload.priority || "nice-to-have"),
          "**Page:** " + (payload.page_path || "/"),
          "",
          "## Description",
          payload.description || "",
          "",
          "_Email is omitted here so this public GitHub draft does not expose private contact info._"
        ].join("\n")
      : [
          "## Support request",
          "",
          "**Topic:** " + (payload.topic || "other"),
          "**Page:** " + (payload.page_path || "/"),
          "",
          "## What happened",
          payload.message || "",
          "",
          "_Name and email are omitted here so this public GitHub draft does not expose private contact info._"
        ].join("\n");
    var url = GITHUB_URL + "/issues/new";
    var params = new URLSearchParams({ title: title, body: body });
    return url + "?" + params.toString();
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
        await insertFeedback(table, payload);
        form.reset();
        setFormStatus(form, "success", type === "feature" ? "Feature request sent. Thank you." : "Support request sent. Thank you.");
      } catch (err) {
        console.error(err);
        if (payload) {
          setFormFallbackStatus(form, type, feedbackFallbackUrl(type, payload));
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
