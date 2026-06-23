/*
 * Nativize panel UI — shadow-DOM, dependency-free.
 *
 * Renders a floating launcher button + a glassmorphism panel inside a
 * shadow root so Lovable's (or any host page's) CSS can never bleed in.
 *
 * Reused verbatim by:
 *   - src/content.js   (real extension, real callbacks)
 *   - tools/harness.html (browser preview + screenshots, stub callbacks)
 *
 * API:
 *   NativizePanel.mount({
 *     mountInto,   // element to attach the host to (default document.body)
 *     initial,     // { appName, appId, githubRepo, webDir, enablePush, token }
 *     onDownload,  // async (config) => void
 *     onPush,      // async (config, token) => ({ url } | void)
 *     onChange,    // (state) => void   (persist hook; optional)
 *     openNow      // bool: render with panel already open (handy for screenshots)
 *   }) => { open, close, destroy, getState, setStatus, root }
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.NativizePanel = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var STYLE = `
  :host { all: initial; }
  *, *::before, *::after { box-sizing: border-box; }

  .nz-fab {
    position: fixed; right: 22px; bottom: 22px; z-index: 2147483646;
    width: 56px; height: 56px; border-radius: 16px; border: none; cursor: pointer;
    background: linear-gradient(135deg, #7c3aed 0%, #4f46e5 50%, #2563eb 100%);
    box-shadow: 0 10px 30px rgba(79,70,229,.45), inset 0 1px 0 rgba(255,255,255,.25);
    display: grid; place-items: center; transition: transform .15s ease, box-shadow .15s ease;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  .nz-fab:hover { transform: translateY(-2px) scale(1.04); box-shadow: 0 14px 38px rgba(79,70,229,.6); }
  .nz-fab svg { width: 26px; height: 26px; }

  .nz-panel {
    position: fixed; right: 22px; bottom: 90px; z-index: 2147483647;
    width: 372px; max-height: 80vh; overflow: hidden; display: none;
    border-radius: 20px; color: #e8e8f0;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: rgba(17, 17, 28, 0.78);
    backdrop-filter: blur(22px) saturate(160%);
    -webkit-backdrop-filter: blur(22px) saturate(160%);
    border: 1px solid rgba(255,255,255,.10);
    box-shadow: 0 24px 70px rgba(0,0,0,.55);
    animation: nz-in .18s ease;
  }
  .nz-panel.nz-show { display: block; }
  @keyframes nz-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

  .nz-header {
    padding: 18px 20px 16px;
    background: linear-gradient(135deg, rgba(124,58,237,.95), rgba(37,99,235,.92));
    position: relative;
  }
  .nz-header h1 { margin: 0; font-size: 17px; font-weight: 700; letter-spacing: .2px; display: flex; align-items: center; gap: 8px; }
  .nz-header p { margin: 4px 0 0; font-size: 12px; opacity: .85; }
  .nz-close {
    position: absolute; top: 14px; right: 14px; width: 26px; height: 26px; border-radius: 8px;
    border: none; cursor: pointer; color: #fff; background: rgba(255,255,255,.16); font-size: 15px; line-height: 1;
  }
  .nz-close:hover { background: rgba(255,255,255,.28); }

  .nz-body { padding: 16px 20px 20px; overflow-y: auto; max-height: calc(80vh - 76px); }

  .nz-field { margin-bottom: 13px; }
  .nz-field label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: #9aa0b4; margin-bottom: 5px; }
  .nz-field input[type="text"], .nz-field input[type="password"] {
    width: 100%; padding: 9px 11px; border-radius: 10px; font-size: 13px;
    background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.12); color: #f2f2f7; outline: none;
    transition: border-color .15s ease, background .15s ease;
  }
  .nz-field input[type="text"]:focus, .nz-field input[type="password"]:focus { border-color: #7c3aed; background: rgba(124,58,237,.08); }
  .nz-hint { font-size: 10.5px; color: #6f7589; margin-top: 4px; }

  .nz-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0 4px; }
  .nz-toggle-row .nz-tlabel { font-size: 13px; font-weight: 600; color: #e8e8f0; }
  .nz-toggle-row .nz-tsub { font-size: 11px; color: #8a90a4; margin-top: 2px; }
  .nz-switch { position: relative; width: 44px; height: 25px; flex: 0 0 auto; cursor: pointer; }
  .nz-switch input { opacity: 0; width: 0; height: 0; }
  .nz-slider {
    position: absolute; inset: 0; border-radius: 999px; background: rgba(255,255,255,.16);
    transition: background .2s ease;
  }
  .nz-slider::before {
    content: ""; position: absolute; left: 3px; top: 3px; width: 19px; height: 19px; border-radius: 50%;
    background: #fff; transition: transform .2s ease; box-shadow: 0 2px 6px rgba(0,0,0,.4);
  }
  .nz-switch input:checked + .nz-slider { background: linear-gradient(135deg, #7c3aed, #2563eb); }
  .nz-switch input:checked + .nz-slider::before { transform: translateX(19px); }

  .nz-actions { display: flex; gap: 10px; margin-top: 16px; }
  .nz-btn {
    flex: 1; padding: 11px 12px; border-radius: 11px; border: none; cursor: pointer; font-size: 13px; font-weight: 600;
    transition: transform .12s ease, filter .12s ease; color: #fff;
  }
  .nz-btn:active { transform: scale(.97); }
  .nz-btn-primary { background: linear-gradient(135deg, #7c3aed, #2563eb); box-shadow: 0 8px 22px rgba(79,70,229,.4); }
  .nz-btn-primary:hover { filter: brightness(1.08); }
  .nz-btn-ghost { background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.14); }
  .nz-btn-ghost:hover { background: rgba(255,255,255,.12); }
  .nz-btn[disabled] { opacity: .5; cursor: not-allowed; }

  .nz-status { margin-top: 12px; font-size: 12px; min-height: 16px; }
  .nz-status.err { color: #ff8a8a; }
  .nz-status.ok { color: #7ee2a8; }

  .nz-success {
    display: none; padding: 28px 22px 26px; text-align: center;
  }
  .nz-success.nz-show { display: block; animation: nz-in .2s ease; }
  .nz-success .nz-check {
    width: 58px; height: 58px; margin: 0 auto 14px; border-radius: 50%;
    background: linear-gradient(135deg, #22c55e, #16a34a); display: grid; place-items: center;
    box-shadow: 0 10px 28px rgba(34,197,94,.4);
  }
  .nz-success h2 { margin: 0 0 6px; font-size: 17px; }
  .nz-success p { margin: 0 0 16px; font-size: 12.5px; color: #9aa0b4; line-height: 1.5; }
  .nz-success a { color: #a78bfa; word-break: break-all; }

  .nz-foot { padding: 10px 20px 14px; font-size: 10.5px; color: #646a7e; text-align: center; border-top: 1px solid rgba(255,255,255,.06); }
  `;

  function el(doc, tag, attrs, html) {
    var n = doc.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (html != null) n.innerHTML = html;
    return n;
  }

  function iconUp(px) {
    return '<svg viewBox="0 0 24 24" width="' + px + '" height="' + px + '" fill="none" stroke="#fff" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M12 6v8"/><path d="M9 9l3-3 3 3"/></svg>';
  }
  var ICON_FAB = iconUp(26);

  var ICON_CHECK =
    '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

  function mount(opts) {
    opts = opts || {};
    var doc = (opts.mountInto && opts.mountInto.ownerDocument) || document;
    var parent = opts.mountInto || doc.body;
    var initial = opts.initial || {};

    // Host element + shadow root: host-page CSS cannot bleed into the panel.
    var host = el(doc, "div", { "data-nativize": "host" });
    parent.appendChild(host);
    var shadow = host.attachShadow({ mode: "open" });

    var style = doc.createElement("style");
    style.textContent = STYLE;
    shadow.appendChild(style);

    // ---- Launcher button ----
    var fab = el(doc, "button", { class: "nz-fab", title: "Nativize", "aria-label": "Open Nativize" }, ICON_FAB);
    shadow.appendChild(fab);

    // ---- Panel ----
    var panel = el(doc, "div", { class: "nz-panel", role: "dialog", "aria-label": "Nativize" });
    panel.innerHTML =
      '<div class="nz-header">' +
        '<h1>' + iconUp(18) + 'Nativize</h1>' +
        '<p>Ship this Lovable app to the App Store &amp; Play Store</p>' +
        '<button class="nz-close" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="nz-body">' +
        '<div class="nz-field"><label>App name</label>' +
          '<input type="text" id="nz-appName" placeholder="My Lovable App"></div>' +
        '<div class="nz-field"><label>App ID (reverse-DNS)</label>' +
          '<input type="text" id="nz-appId" placeholder="app.lovable.myapp">' +
          '<div class="nz-hint">Must match your App Store / Play bundle identifier.</div></div>' +
        '<div class="nz-field"><label>GitHub repo (owner/repo)</label>' +
          '<input type="text" id="nz-repo" placeholder="octocat/my-app"></div>' +
        '<div class="nz-field"><label>Web build dir</label>' +
          '<input type="text" id="nz-webDir" placeholder="dist"></div>' +
        '<div class="nz-toggle-row">' +
          '<div><div class="nz-tlabel">Push notifications</div>' +
            '<div class="nz-tsub">Adds Firebase messaging (static import, web-safe)</div></div>' +
          '<label class="nz-switch"><input type="checkbox" id="nz-push"><span class="nz-slider"></span></label>' +
        '</div>' +
        '<div class="nz-field" id="nz-tokenField" style="display:none;margin-top:6px">' +
          '<label>GitHub token (repo scope) — for direct push</label>' +
          '<input type="password" id="nz-token" autocomplete="off" spellcheck="false" placeholder="ghp_… (stored only in chrome.storage.local)">' +
          '<div class="nz-hint">Optional. Only needed for &ldquo;Push to GitHub&rdquo;. Never leaves your browser.</div></div>' +
        '<div class="nz-actions">' +
          '<button class="nz-btn nz-btn-ghost" id="nz-download">Download .zip</button>' +
          '<button class="nz-btn nz-btn-primary" id="nz-pushBtn">Push to GitHub</button>' +
        '</div>' +
        '<div class="nz-status" id="nz-status"></div>' +
      '</div>' +
      '<div class="nz-success" id="nz-success">' +
        '<div class="nz-check">' + ICON_CHECK + '</div>' +
        '<h2 id="nz-successTitle">Kit generated</h2>' +
        '<p id="nz-successMsg"></p>' +
        '<button class="nz-btn nz-btn-ghost" id="nz-again" style="max-width:140px;margin:0 auto">Back</button>' +
      '</div>' +
      '<div class="nz-foot">Nativize · Capacitor 8 · runs entirely in your browser</div>';
    shadow.appendChild(panel);

    var $ = function (id) { return shadow.getElementById(id); };
    var tokenField = $("nz-tokenField");

    // ---- Prefill ----
    $("nz-appName").value = initial.appName || "";
    $("nz-appId").value = initial.appId || "";
    $("nz-repo").value = initial.githubRepo || "";
    $("nz-webDir").value = initial.webDir || "dist";
    $("nz-push").checked = initial.enablePush === true;
    $("nz-token").value = initial.token || "";
    tokenField.style.display = "block"; // token always available for push delivery

    function getState() {
      return {
        appName: $("nz-appName").value.trim(),
        appId: $("nz-appId").value.trim(),
        githubRepo: $("nz-repo").value.trim(),
        webDir: $("nz-webDir").value.trim() || "dist",
        enablePush: $("nz-push").checked,
        token: $("nz-token").value.trim()
      };
    }

    function setStatus(msg, kind) {
      var s = $("nz-status");
      s.textContent = msg || "";
      s.className = "nz-status" + (kind ? " " + kind : "");
    }

    function showSuccess(title, msgHtml) {
      $("nz-successTitle").textContent = title;
      $("nz-successMsg").innerHTML = msgHtml || "";
      panel.querySelector(".nz-body").style.display = "none";
      $("nz-success").classList.add("nz-show");
    }
    function backFromSuccess() {
      $("nz-success").classList.remove("nz-show");
      panel.querySelector(".nz-body").style.display = "block";
      setStatus("");
    }

    function open() { panel.classList.add("nz-show"); }
    function close() { panel.classList.remove("nz-show"); }
    function toggle() { panel.classList.toggle("nz-show"); }

    // ---- Wiring ----
    fab.addEventListener("click", toggle);
    panel.querySelector(".nz-close").addEventListener("click", close);
    $("nz-again").addEventListener("click", backFromSuccess);

    // Auto-derive appId from app name if the user hasn't typed one.
    $("nz-appName").addEventListener("input", function () {
      if (!$("nz-appId").dataset.touched) {
        var lib = (typeof module === "object" && module.exports)
          ? require("./kit-generator.js")
          : (typeof self !== "undefined" ? self.NativizeKit : null);
        if (lib) $("nz-appId").value = lib.normalizeAppId("", getState().appName);
      }
      emitChange();
    });
    $("nz-appId").addEventListener("input", function () { $("nz-appId").dataset.touched = "1"; emitChange(); });
    ["nz-repo", "nz-webDir", "nz-token"].forEach(function (id) {
      $(id).addEventListener("input", emitChange);
    });
    $("nz-push").addEventListener("change", emitChange);

    function emitChange() { if (typeof opts.onChange === "function") opts.onChange(getState()); }

    $("nz-download").addEventListener("click", function () {
      var st = getState();
      setStatus("Generating kit…");
      Promise.resolve(opts.onDownload && opts.onDownload(st))
        .then(function () {
          showSuccess("Kit downloaded", "Your native kit <b>" + esc(st.appName || "app") +
            "</b>.zip is in Downloads. Unzip into your project root and run <code>bash nativize.sh</code>.");
        })
        .catch(function (e) { setStatus("Download failed: " + (e && e.message || e), "err"); });
    });

    $("nz-pushBtn").addEventListener("click", function () {
      var st = getState();
      if (!st.githubRepo) return setStatus("Enter a GitHub repo (owner/repo) first.", "err");
      if (!st.token) return setStatus("A GitHub token with 'repo' scope is required to push.", "err");
      setStatus("Pushing to " + st.githubRepo + "…");
      Promise.resolve(opts.onPush && opts.onPush(st, st.token))
        .then(function (res) {
          var url = res && res.url;
          showSuccess("Pushed to GitHub",
            "Kit committed to <b>" + esc(st.githubRepo) + "</b>." +
            (url ? ' <br><a href="' + esc(url) + '" target="_blank" rel="noopener">Open the commit ↗</a>' : "") +
            "<br><br>Now run <b>Actions → Nativize Build</b> to build in the cloud.");
        })
        .catch(function (e) { setStatus("Push failed: " + (e && e.message || e), "err"); });
    });

    function esc(s) {
      return String(s).replace(/[&<>"]/g, function (ch) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
      });
    }

    if (opts.openNow) open();

    return {
      open: open, close: close, toggle: toggle,
      getState: getState, setStatus: setStatus, showSuccess: showSuccess,
      root: shadow,
      destroy: function () { try { host.remove(); } catch (e) {} }
    };
  }

  return { mount: mount };
});
