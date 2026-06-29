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
 *     initial,     // { appName, appId, githubRepo, webDir, enablePush, token, signedIn, planId }
 *     authRequired,// bool: require Supabase/GitHub sign-in before builder actions
 *     onDownload,  // async (config) => void
 *     onPush,      // async (config, token) => ({ url } | void)
 *     onChange,    // (state) => void   (persist hook; optional)
 *     openNow      // bool: render with panel already open (handy for screenshots)
 *   }) => { open, close, destroy, getState, setStatus, setPlan, root }
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
  .nz-field textarea {
    width: 100%; padding: 9px 11px; border-radius: 10px; font-size: 12px; resize: vertical; min-height: 56px;
    background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.12); color: #f2f2f7; outline: none;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .nz-field textarea:focus { border-color: #7c3aed; background: rgba(124,58,237,.08); }
  .nz-field input[type="file"] { width: 100%; font-size: 11.5px; color: #9aa0b4; }
  .nz-hint { font-size: 10.5px; color: #6f7589; margin-top: 4px; }
  .nz-sub { margin: 4px 0 0 0; padding: 12px; border-radius: 12px; background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.07); display: none; }
  .nz-sub.nz-show { display: block; }
  .nz-subhead { font-size: 11.5px; font-weight: 700; color: #c4b5fd; margin: 0 0 8px; letter-spacing: .3px; }
  .nz-divider { height: 1px; background: rgba(255,255,255,.08); margin: 14px 0 12px; }

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

  var ICON_GH =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" style="margin-right:7px;vertical-align:-2px"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

  function mount(opts) {
    opts = opts || {};
    var doc = (opts.mountInto && opts.mountInto.ownerDocument) || document;
    var parent = opts.mountInto || doc.body;
    var initial = opts.initial || {};
    var authRequired = opts.authRequired === true;
    var signedIn = initial.signedIn === true || (!authRequired && !!(initial.token && initial.token.length));
    var planId = String(initial.planId || "free").toLowerCase();
    var authLocked = false;

    // Host element + shadow root: host-page CSS cannot bleed into the panel.
    var host = el(doc, "div", { "data-nativize": "host" });
    parent.appendChild(host);
    var shadow = host.attachShadow({ mode: "open" });

    var style = doc.createElement("style");
    style.textContent = STYLE +
      ".nz-actions-stack{flex-direction:column;gap:6px}" +
      ".nz-btn-hero{width:100%;font-size:15px;padding:13px 16px;font-weight:700}" +
      ".nz-build-sub{text-align:left;margin-top:2px}" +
      ".nz-advanced{margin-top:14px;border-top:1px solid rgba(255,255,255,.08);padding-top:10px}" +
      ".nz-link{background:none;border:none;color:#a9a3c9;font-size:12px;cursor:pointer;padding:2px 0}" +
      ".nz-link:hover{color:#d8d3ee}" +
      ".nz-advBody{display:none;margin-top:6px}" +
      ".nz-advBody.nz-show{display:block}" +
      ".nz-arts{display:flex;flex-direction:column;gap:8px;margin:14px 0}" +
      ".nz-art{display:flex;flex-direction:column;gap:2px;padding:10px 14px;border-radius:11px;" +
        "background:linear-gradient(135deg,#7c3aed,#db2777);color:#fff;text-decoration:none}" +
      ".nz-art-main{font-weight:650;font-size:13.5px}" +
      ".nz-art-note{font-size:11px;opacity:.85}" +
      ".nz-art:hover{filter:brightness(1.08)}" +
      ".nz-auth{margin-bottom:14px;text-align:center}" +
      ".nz-btn-gh{width:100%;display:inline-flex;align-items:center;justify-content:center;padding:11px 16px;" +
        "border:1px solid rgba(255,255,255,.18);border-radius:11px;background:#1b1726;color:#fff;font-weight:650;font-size:13.5px;cursor:pointer}" +
      ".nz-btn-gh:hover{background:#241f33}" +
      ".nz-signed{font-size:13px;color:#6ee7b7;font-weight:600;padding:10px;background:rgba(110,231,183,.08);border-radius:11px}" +
      ".nz-signed .nz-link{color:#9b94b8;margin-left:4px}" +
      ".nz-auth-lock{display:none;margin:-4px 0 13px;padding:10px 12px;border-radius:11px;text-align:left;" +
        "background:rgba(252,211,77,.1);border:1px solid rgba(252,211,77,.24);color:#fcd34d;font-size:12px;line-height:1.45}" +
      ".nz-auth-lock.nz-show{display:block}" +
      ".nz-paid-lock{display:none;margin:7px 0 3px;padding:9px 11px;border-radius:10px;text-align:left;" +
        "background:rgba(96,165,250,.11);border:1px solid rgba(96,165,250,.26);color:#bfdbfe;font-size:11.5px;line-height:1.45}" +
      ".nz-paid-lock.nz-show{display:block}" +
      ".nz-lock-badge{display:inline-flex;align-items:center;gap:4px;margin-left:6px;padding:2px 6px;border-radius:999px;" +
        "background:rgba(96,165,250,.16);color:#bfdbfe;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}" +
      // ---- build progress ----
      ".nz-prog{margin-top:13px;padding:13px;border:1px solid rgba(255,255,255,.09);border-radius:13px;background:rgba(255,255,255,.025)}" +
      ".nz-prog-top{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:9px}" +
      ".nz-prog-stage{font-size:13px;font-weight:600;color:#ece9f6}" +
      ".nz-prog-time{font-size:12px;color:#9b94b8;font-variant-numeric:tabular-nums}" +
      ".nz-prog-bar{height:6px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden;position:relative}" +
      ".nz-prog-bar::before{content:'';position:absolute;top:0;left:-45%;width:45%;height:100%;border-radius:999px;" +
        "background:linear-gradient(90deg,#8b5cf6,#ec4899);animation:nzslide 1.25s cubic-bezier(.4,0,.2,1) infinite}" +
      "@keyframes nzslide{0%{left:-45%}100%{left:100%}}" +
      ".nz-steps{display:flex;gap:5px;margin-top:10px}" +
      ".nz-step{flex:1;height:4px;border-radius:999px;background:rgba(255,255,255,.12);transition:background .3s}" +
      ".nz-step.on{background:linear-gradient(90deg,#8b5cf6,#ec4899)}" +
      ".nz-step.cur{animation:nzpulse 1.1s ease-in-out infinite}" +
      "@keyframes nzpulse{50%{opacity:.45}}" +
      ".nz-prog-note{font-size:11px;color:#8c85ab;margin-top:9px}" +
      // ---- permissions ----
      ".nz-perm{margin-top:10px;padding:10px 11px;border:1px solid rgba(255,255,255,.08);border-radius:11px;background:rgba(255,255,255,.02)}" +
      ".nz-perm-top{display:flex;align-items:center;justify-content:space-between;gap:10px}" +
      ".nz-perm-name{font-size:13px;font-weight:600;color:#ece9f6}" +
      ".nz-perm-desc{margin-top:8px;display:none}" +
      ".nz-perm-desc.nz-show{display:block}" +
      ".nz-perm-desc input{width:100%;padding:8px 10px;border-radius:9px;border:1px solid rgba(255,255,255,.1);background:rgba(8,7,12,.7);color:#fff;font-size:12.5px}" +
      ".nz-perm-desc input:focus{outline:none;border-color:#a855f7}" +
      ".nz-perm-desc input.nz-bad{border-color:#fca5a5}" +
      ".nz-perm-miss{font-size:11px;color:#fca5a5;margin-top:5px}" +
      ".nz-permwarn{margin-top:12px;padding:10px 12px;border-radius:10px;background:rgba(252,165,165,.1);" +
        "border:1px solid rgba(252,165,165,.3);color:#fca5a5;font-size:12px;line-height:1.5}";
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
        // ---- Sign in with GitHub (one click, via Supabase) ----
        '<div class="nz-auth">' +
          '<button class="nz-btn nz-btn-gh" id="nz-signinBtn">' + ICON_GH + 'Sign in with GitHub</button>' +
          '<div class="nz-signed" id="nz-signedIn" style="display:none">✓ Connected to GitHub · <button class="nz-link" id="nz-signout" type="button">sign out</button></div>' +
          '<div class="nz-hint" id="nz-authHint">Sign in before generating an app so Supabase can verify your Nativize plan.</div>' +
        '</div>' +
        '<div class="nz-auth-lock" id="nz-authLock">Sign in with GitHub first so Supabase can verify your Nativize plan before you make an app.</div>' +
        // ---- Essentials ----
        '<div class="nz-field"><label>App name</label>' +
          '<input type="text" id="nz-appName" maxlength="80" placeholder="My Lovable App"></div>' +
        '<div class="nz-field"><label>GitHub repo (owner/repo)</label>' +
          '<input type="text" id="nz-repo" maxlength="140" placeholder="octocat/my-app"></div>' +
        // ---- Build (hero) ----
        '<div class="nz-actions nz-actions-stack">' +
          '<button class="nz-btn nz-btn-primary nz-btn-hero" id="nz-buildBtn">⚡ Build my app</button>' +
          '<div class="nz-hint nz-build-sub">Builds installable <b>iOS, Android, Mac &amp; Windows</b> apps in the cloud, with download links. Plan is checked before build.</div>' +
          '<button class="nz-btn nz-btn-ghost" id="nz-projectBtn" style="margin-top:8px">⬇ Download full project (source)</button>' +
          '<div class="nz-hint nz-build-sub">The whole project: your <b>src</b> + ios + android + desktop folders, as a .zip.</div>' +
        '</div>' +
        '<div class="nz-status" id="nz-status"></div>' +
        // ---- Options (collapsed) ----
        '<div class="nz-advanced">' +
          '<button class="nz-link" id="nz-optToggle" type="button">Options — app ID, push, store upload, manual token ▾</button>' +
          '<div class="nz-advBody" id="nz-optBody">' +
        '<div class="nz-field"><label>App ID (reverse-DNS)</label>' +
          '<input type="text" id="nz-appId" maxlength="120" placeholder="app.lovable.myapp">' +
          '<div class="nz-hint">Must match your App Store / Play bundle identifier.</div></div>' +
        '<div class="nz-field"><label>Web build dir</label>' +
          '<input type="text" id="nz-webDir" maxlength="120" placeholder="dist"></div>' +
        '<div class="nz-toggle-row">' +
          '<div><div class="nz-tlabel">Push notifications</div>' +
            '<div class="nz-tsub">Adds Firebase messaging (static import, web-safe)</div></div>' +
          '<label class="nz-switch"><input type="checkbox" id="nz-push"><span class="nz-slider"></span></label>' +
        '</div>' +
        '<div class="nz-paid-lock" id="nz-pushLock">Paid plan required for push notifications. Choose Starter, Pro, or Max to enable it.</div>' +
        '<div class="nz-field" id="nz-tokenField" style="margin-top:6px">' +
          '<label>GitHub token <span class="nz-hint" style="display:inline">(manual GitHub fallback; plan still requires sign-in)</span></label>' +
          '<input type="password" id="nz-token" maxlength="5000" autocomplete="off" spellcheck="false" placeholder="ghp_… (needs repo + workflow)">' +
          '<div class="nz-hint"><a href="https://github.com/settings/tokens/new?scopes=repo,workflow&description=Nativize" target="_blank" rel="noopener">Create a token →</a> Stored only in your browser.</div></div>' +
        '<div class="nz-divider"></div>' +
        '<div class="nz-toggle-row">' +
          '<div><div class="nz-tlabel">Auto-upload to stores</div>' +
            '<div class="nz-tsub">Signed build &rarr; TestFlight + Play internal testing</div></div>' +
          '<label class="nz-switch"><input type="checkbox" id="nz-store"><span class="nz-slider"></span></label>' +
        '</div>' +
        '<div class="nz-paid-lock" id="nz-storeLock">Paid plan required for App Store Connect and Google Play upload settings.</div>' +
        '<div class="nz-sub" id="nz-storeWrap">' +
          // ---- iOS / App Store Connect ----
          '<div class="nz-toggle-row" style="padding-top:0">' +
            '<div><div class="nz-tlabel" style="font-size:12.5px">App Store Connect &rarr; TestFlight</div></div>' +
            '<label class="nz-switch"><input type="checkbox" id="nz-ios"><span class="nz-slider"></span></label>' +
          '</div>' +
          '<div class="nz-sub" id="nz-iosWrap">' +
            '<div class="nz-subhead">iOS credentials (App Store Connect API key)</div>' +
            '<div class="nz-field"><label>Key ID</label><input type="text" id="nz-ascKeyId" maxlength="80" placeholder="ABCD123456"></div>' +
            '<div class="nz-field"><label>Issuer ID</label><input type="text" id="nz-ascIssuer" maxlength="80" placeholder="69a6de7e-…"></div>' +
            '<div class="nz-field"><label>Apple Team ID</label><input type="text" id="nz-appleTeam" maxlength="20" placeholder="A1B2C3D4E5"></div>' +
            '<div class="nz-field"><label>API key (.p8 contents)</label><textarea id="nz-ascP8" maxlength="10000" placeholder="-----BEGIN PRIVATE KEY-----&#10;…"></textarea></div>' +
          '</div>' +
          // ---- Android / Google Play ----
          '<div class="nz-toggle-row">' +
            '<div><div class="nz-tlabel" style="font-size:12.5px">Google Play &rarr; Internal testing</div></div>' +
            '<label class="nz-switch"><input type="checkbox" id="nz-android"><span class="nz-slider"></span></label>' +
          '</div>' +
          '<div class="nz-sub" id="nz-androidWrap">' +
            '<div class="nz-subhead">Android credentials</div>' +
            '<div class="nz-field"><label>Upload keystore (.jks / .keystore)</label><input type="file" id="nz-keystore" accept=".jks,.keystore"><div class="nz-hint" id="nz-keystoreInfo">Read in-browser, base64-encoded into a secret.</div></div>' +
            '<div class="nz-field"><label>Keystore password</label><input type="password" id="nz-ksPass" maxlength="256" autocomplete="off"></div>' +
            '<div class="nz-field"><label>Key alias</label><input type="text" id="nz-keyAlias" maxlength="120" placeholder="upload"></div>' +
            '<div class="nz-field"><label>Key password</label><input type="password" id="nz-keyPass" maxlength="256" autocomplete="off"></div>' +
            '<div class="nz-field"><label>Play service account JSON</label><textarea id="nz-playJson" maxlength="20000" placeholder=\'{ "type": "service_account", … }\'></textarea></div>' +
          '</div>' +
          '<div class="nz-hint">Stored only as encrypted GitHub Actions secrets via the API. First Play release must be created manually once (Google requirement).</div>' +
        '</div>' +
          '</div>' +
        '</div>' +
        // ---- App permissions (populated from the catalog at mount) ----
        '<div class="nz-advanced">' +
          '<button class="nz-link" id="nz-permToggle" type="button">App permissions — what your app can access ▾</button>' +
          '<div class="nz-advBody" id="nz-permBody">' +
            '<div class="nz-hint">Turn on only what your app needs. iOS requires a short reason for each — write it in plain language. This writes the iOS Info.plist + Android manifest for you.</div>' +
            '<div id="nz-permsList"></div>' +
            '<div class="nz-permwarn" id="nz-permWarn" style="display:none"></div>' +
          '</div>' +
        '</div>' +
        // ---- Social sign-in (populated from the catalog at mount) ----
        '<div class="nz-advanced">' +
          '<button class="nz-link" id="nz-socialToggle" type="button">Social sign-in — Apple &amp; Google ▾</button>' +
          '<div class="nz-advBody" id="nz-socialBody">' +
            '<div class="nz-hint">Add native Sign in with Apple / Google. Returns an idToken your app passes to Supabase. We install the plugin, write the iOS URL scheme + Apple entitlement, and drop a ready-to-use helper at <code>src/nativeSocialAuth.ts</code>.</div>' +
            '<div class="nz-paid-lock" id="nz-socialLock">Paid plan required for native Apple and Google sign-in.</div>' +
            '<div id="nz-socialList"></div>' +
            '<div class="nz-permwarn" id="nz-socialWarn" style="display:none"></div>' +
          '</div>' +
        '</div>' +
        // ---- Branding: custom app icon + iOS Dynamic Island header (premium) ----
        '<div class="nz-advanced">' +
          '<button class="nz-link" id="nz-brandToggle" type="button">App icon &amp; iOS header — your logo, native look ▾</button>' +
          '<div class="nz-advBody" id="nz-brandBody">' +
            '<div class="nz-hint">Upload your logo once. We resize it in your browser and generate every iOS, Android, Mac &amp; Windows app icon for you.</div>' +
            '<div class="nz-paid-lock" id="nz-brandLock">Paid plan required for a custom app icon and the iOS Dynamic Island header.</div>' +
            '<div class="nz-field"><label>App logo (PNG/JPG, any size — square works best)</label>' +
              '<input type="file" id="nz-logo" accept="image/png,image/jpeg,image/webp">' +
              '<div style="display:flex;align-items:center;gap:12px;margin-top:8px">' +
                '<div id="nz-logoPreview" aria-hidden="true" style="width:56px;height:56px;border-radius:14px;background:#ffffff center/cover no-repeat;border:1px solid rgba(255,255,255,.14);flex:none;display:none"></div>' +
                '<div class="nz-hint" id="nz-logoInfo">Resized to 1024×1024 and used for every app icon.</div>' +
              '</div>' +
            '</div>' +
            '<div class="nz-field"><label>Icon background</label>' +
              '<input type="color" id="nz-logoBg" value="#ffffff" style="width:54px;height:34px;padding:2px;background:none;border:1px solid rgba(255,255,255,.14);border-radius:8px;cursor:pointer">' +
              '<div class="nz-hint">iOS app icons can\'t be transparent — your logo sits on this color.</div></div>' +
            '<div class="nz-divider"></div>' +
            '<div class="nz-toggle-row">' +
              '<div><div class="nz-tlabel">iOS Dynamic Island header</div>' +
                '<div class="nz-tsub">A clean frosted bar that fills the notch / Dynamic Island strip</div></div>' +
              '<label class="nz-switch"><input type="checkbox" id="nz-island"><span class="nz-slider"></span></label>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="nz-advanced">' +
          '<button class="nz-link" id="nz-advToggle" type="button">Advanced — manual setup kit ▾</button>' +
          '<div class="nz-advBody" id="nz-advBody">' +
            '<div class="nz-hint"><b>This is not your built app.</b> It downloads the Capacitor config + setup scripts as a .zip — the recipe you add to your project, then run <code>bash nativize.sh</code> yourself to create the native projects.</div>' +
            '<button class="nz-btn nz-btn-ghost" id="nz-download" style="margin-top:8px">Download setup kit (.zip)</button>' +
          '</div>' +
        '</div>' +
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
    var paidPlanIds = { starter: true, pro: true, max: true };
    var paidControlSelector = [
      "#nz-push", "#nz-store", "#nz-ios", "#nz-android", "#nz-keystore",
      "#nz-ascKeyId", "#nz-ascIssuer", "#nz-appleTeam", "#nz-ascP8",
      "#nz-ksPass", "#nz-keyAlias", "#nz-keyPass", "#nz-playJson",
      "#nz-logo", "#nz-logoBg", "#nz-island",
      "[data-socialtoggle]", "[data-social]"
    ].join(",");

    function isPaidUi() {
      return paidPlanIds[planId] === true;
    }
    function setPanelVisible(id, on) {
      var el = $(id);
      if (el) el.classList.toggle("nz-show", !!on);
    }
    function clearPaidSelections() {
      $("nz-push").checked = false;
      $("nz-store").checked = false;
      $("nz-ios").checked = false;
      $("nz-android").checked = false;
      if ($("nz-island")) $("nz-island").checked = false;
      setPanelVisible("nz-storeWrap", false);
      setPanelVisible("nz-iosWrap", false);
      setPanelVisible("nz-androidWrap", false);
      Array.prototype.forEach.call(shadow.querySelectorAll("[data-socialtoggle]"), function (cb) { cb.checked = false; });
      Array.prototype.forEach.call(shadow.querySelectorAll('[id^="sd-"]'), function (box) { box.classList.remove("nz-show"); });
    }
    function applyControlLocks() {
      var planLocked = !isPaidUi();
      if (planLocked) clearPaidSelections();
      setPanelVisible("nz-pushLock", planLocked);
      setPanelVisible("nz-storeLock", planLocked);
      setPanelVisible("nz-socialLock", planLocked);
      setPanelVisible("nz-brandLock", planLocked);
      Array.prototype.forEach.call(shadow.querySelectorAll("input, textarea, select, button"), function (control) {
        if (!control) return;
        if (control.id === "nz-signinBtn" || control.id === "nz-signout" || control.id === "nz-again") return;
        if (control.classList && control.classList.contains("nz-close")) return;
        control.disabled = !!authLocked;
      });
      Array.prototype.forEach.call(shadow.querySelectorAll(paidControlSelector), function (control) {
        control.disabled = !!authLocked || planLocked;
      });
    }
    function setPlan(nextPlanId) {
      var previousPlanId = planId;
      planId = String(nextPlanId || "free").toLowerCase();
      applyControlLocks();
      if (previousPlanId !== planId) emitChange();
    }

    // ---- Prefill ----
    $("nz-appName").value = initial.appName || "";
    $("nz-appId").value = initial.appId || "";
    $("nz-repo").value = initial.githubRepo || "";
    $("nz-webDir").value = initial.webDir || "dist";
    $("nz-push").checked = initial.enablePush === true;
    $("nz-token").value = initial.token || "";
    tokenField.style.display = "block";

    function setSignedIn(on) {
      signedIn = !!on;
      $("nz-signinBtn").style.display = on ? "none" : "inline-flex";
      $("nz-signedIn").style.display = on ? "block" : "none";
      $("nz-authHint").style.display = on ? "none" : "block";
    }
    function setAuthLocked(locked) {
      authLocked = !!locked;
      var lock = $("nz-authLock");
      if (lock) lock.classList.toggle("nz-show", authLocked);
      applyControlLocks();
    }
    function requireSignedInUi(action) {
      if (!authRequired || signedIn) return true;
      setAuthLocked(true);
      setStatus("Sign in with GitHub first so Supabase can verify your Nativize plan before you " + action + ".", "err");
      return false;
    }
    setSignedIn(signedIn);

    var keystoreB64 = ""; // populated when a keystore file is selected

    // ---- App logo → app icon + splash (resized in-browser via canvas) ----
    var logoImg = null, logoIconB64 = "", logoSplashB64 = "";
    function composeImage(img, size, bg, scale) {
      var c = document.createElement("canvas");
      c.width = c.height = size;
      var x = c.getContext("2d");
      x.fillStyle = bg; x.fillRect(0, 0, size, size);
      var box = size * scale;
      var r = Math.min(box / img.width, box / img.height);
      var w = img.width * r, h = img.height * r;
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
      x.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      return c.toDataURL("image/png");
    }
    function renderLogo() {
      if (!logoImg) return;
      var bg = ($("nz-logoBg") && $("nz-logoBg").value) || "#ffffff";
      logoIconB64 = composeImage(logoImg, 1024, bg, 0.82);          // icon: logo on chosen bg
      logoSplashB64 = composeImage(logoImg, 2732, "#0b0b12", 0.3);  // splash: logo on the brand dark
      var pv = $("nz-logoPreview");
      if (pv) { pv.style.display = "block"; pv.style.backgroundImage = "url(" + logoIconB64 + ")"; }
    }
    function handleLogo(e) {
      var file = e.target.files && e.target.files[0];
      var info = $("nz-logoInfo");
      if (!file) return;
      if (file.size > 12 * 1024 * 1024) { if (info) info.textContent = "That image is too large (max 12MB)."; return; }
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          logoImg = img; renderLogo();
          if (info) info.textContent = file.name + " · resized to 1024×1024 ✓";
          emitChange();
        };
        img.onerror = function () { if (info) info.textContent = "Couldn't read that image."; };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    }

    function getState() {
      var storeOn = isPaidUi() && $("nz-store").checked;
      var iosUpload = storeOn && $("nz-ios").checked;
      var androidUpload = storeOn && $("nz-android").checked;
      // Map UI fields to the exact GitHub secret names the workflow expects.
      var secrets = {};
      if (iosUpload) {
        secrets.ASC_KEY_ID = $("nz-ascKeyId").value.trim();
        secrets.ASC_ISSUER_ID = $("nz-ascIssuer").value.trim();
        secrets.APPLE_TEAM_ID = $("nz-appleTeam").value.trim();
        secrets.ASC_KEY_P8 = $("nz-ascP8").value;
      }
      if (androidUpload) {
        secrets.ANDROID_KEYSTORE_BASE64 = keystoreB64;
        secrets.ANDROID_KEYSTORE_PASSWORD = $("nz-ksPass").value;
        secrets.ANDROID_KEY_ALIAS = $("nz-keyAlias").value.trim();
        secrets.ANDROID_KEY_PASSWORD = $("nz-keyPass").value;
        secrets.PLAY_SERVICE_ACCOUNT_JSON = $("nz-playJson").value;
      }
      return {
        appName: $("nz-appName").value.trim(),
        appId: $("nz-appId").value.trim(),
        githubRepo: $("nz-repo").value.trim(),
        webDir: $("nz-webDir").value.trim() || "dist",
        enablePush: isPaidUi() && $("nz-push").checked,
        token: $("nz-token").value.trim(),
        iosUpload: iosUpload,
        androidUpload: androidUpload,
        storeSecrets: secrets,
        permissions: collectPermissions(),
        socialAuth: isPaidUi() ? collectSocial() : {},
        appIcon: isPaidUi() ? (logoIconB64 || null) : null,
        appSplash: isPaidUi() ? (logoSplashB64 || null) : null,
        iosHeader: isPaidUi() && !!($("nz-island") && $("nz-island").checked)
      };
    }

    // ---- App permissions: render the catalog, collect selection, validate ----
    var KIT = (typeof module === "object" && module.exports) ? require("./kit-generator.js")
      : (typeof self !== "undefined" ? self.NativizeKit : null);
    var PERM_CATALOG = (KIT && KIT.PERMISSION_CATALOG) || [];

    function renderPermissions() {
      var host = $("nz-permsList");
      if (!host) return;
      var saved = {};
      ((initial.permissions) || []).forEach(function (p) { if (p && p.key) saved[p.key] = p; });
      host.innerHTML = PERM_CATALOG.map(function (cat) {
        var on = !!saved[cat.key];
        var desc = (saved[cat.key] && saved[cat.key].description) || "";
        var descBox = cat.needsDesc
          ? '<div class="nz-perm-desc" id="pd-' + cat.key + '">' +
              '<input type="text" data-perm="' + cat.key + '" maxlength="240" placeholder="Why does your app need this? (shown to users)" value="' + esc(desc) + '">' +
              '<div class="nz-perm-miss" id="pm-' + cat.key + '" style="display:none">iOS needs a reason for this permission.</div>' +
            '</div>'
          : '';
        return '<div class="nz-perm">' +
            '<div class="nz-perm-top">' +
              '<span class="nz-perm-name">' + esc(cat.label) + '</span>' +
              '<label class="nz-switch"><input type="checkbox" data-permtoggle="' + cat.key + '"' + (on ? ' checked' : '') + '><span class="nz-slider"></span></label>' +
            '</div>' + descBox +
          '</div>';
      }).join("");
      // wire toggles + inputs
      Array.prototype.forEach.call(host.querySelectorAll("[data-permtoggle]"), function (cb) {
        var key = cb.getAttribute("data-permtoggle");
        var box = $("pd-" + key);
        if (box) box.classList.toggle("nz-show", cb.checked);
        cb.addEventListener("change", function () {
          if (box) box.classList.toggle("nz-show", cb.checked);
          validatePerms(); emitChange();
        });
      });
      Array.prototype.forEach.call(host.querySelectorAll("[data-perm]"), function (inp) {
        inp.addEventListener("input", function () { validatePerms(); emitChange(); });
      });
      validatePerms();
    }
    function collectPermissions() {
      var host = $("nz-permsList");
      if (!host) return (initial.permissions || []);
      var out = [];
      Array.prototype.forEach.call(host.querySelectorAll("[data-permtoggle]"), function (cb) {
        if (!cb.checked) return;
        var key = cb.getAttribute("data-permtoggle");
        var inp = host.querySelector('[data-perm="' + key + '"]');
        out.push({ key: key, description: inp ? inp.value.trim() : "" });
      });
      return out;
    }
    // Returns the list of enabled permissions missing a required description; also paints the UI.
    function validatePerms() {
      var host = $("nz-permsList");
      if (!host || !KIT) return [];
      var missing = KIT.validatePermissions(collectPermissions()); // array of labels
      var missingKeys = {};
      collectPermissions().forEach(function (p) {
        var cat = PERM_CATALOG.filter(function (c) { return c.key === p.key; })[0];
        if (cat && cat.needsDesc && !p.description) missingKeys[p.key] = true;
      });
      PERM_CATALOG.forEach(function (cat) {
        var inp = host.querySelector('[data-perm="' + cat.key + '"]');
        var miss = $("pm-" + cat.key);
        var bad = !!missingKeys[cat.key];
        if (inp) inp.classList.toggle("nz-bad", bad);
        if (miss) miss.style.display = bad ? "block" : "none";
      });
      var warn = $("nz-permWarn");
      if (warn) {
        if (missing.length) {
          warn.style.display = "block";
          warn.innerHTML = "Add a reason for: <b>" + missing.map(esc).join(", ") + "</b>. iOS rejects builds with a permission but no usage description.";
        } else { warn.style.display = "none"; }
      }
      return missing;
    }

    // ---- Social sign-in: render the catalog, collect selection, validate ----
    var SOCIAL_CATALOG = (KIT && KIT.SOCIAL_AUTH_CATALOG) || [];

    function renderSocial() {
      var host = $("nz-socialList");
      if (!host) return;
      var saved = (initial.socialAuth) || {};
      host.innerHTML = SOCIAL_CATALOG.map(function (prov) {
        var sv = saved[prov.key] || {};
        var on = sv.enabled === true;
        var fields = prov.fields.map(function (f) {
          var val = sv[f.key] == null ? "" : sv[f.key];
          return '<input type="text" data-social="' + prov.key + '" data-field="' + f.key + '"' +
                   ' maxlength="500"' +
                   ' placeholder="' + esc(f.label) + (f.required ? " (required)" : "") + '"' +
                   ' value="' + esc(val) + '">' +
                 '<div class="nz-perm-miss" id="sm-' + prov.key + "-" + f.key + '" style="display:none">Required for ' + esc(prov.label) + '.</div>';
        }).join("");
        return '<div class="nz-perm">' +
            '<div class="nz-perm-top">' +
              '<span class="nz-perm-name">' + esc(prov.label) + '</span>' +
              '<label class="nz-switch"><input type="checkbox" data-socialtoggle="' + prov.key + '"' + (on ? ' checked' : '') + '><span class="nz-slider"></span></label>' +
            '</div>' +
            '<div class="nz-perm-desc" id="sd-' + prov.key + '">' + fields + '</div>' +
          '</div>';
      }).join("");
      Array.prototype.forEach.call(host.querySelectorAll("[data-socialtoggle]"), function (cb) {
        var key = cb.getAttribute("data-socialtoggle");
        var box = $("sd-" + key);
        if (box) box.classList.toggle("nz-show", cb.checked);
        cb.addEventListener("change", function () {
          if (box) box.classList.toggle("nz-show", cb.checked);
          validateSocial(); emitChange();
        });
      });
      Array.prototype.forEach.call(host.querySelectorAll("[data-social]"), function (inp) {
        inp.addEventListener("input", function () { validateSocial(); emitChange(); });
      });
      validateSocial();
    }
    function collectSocial() {
      var host = $("nz-socialList");
      if (!host) return (initial.socialAuth || {});
      var out = {};
      SOCIAL_CATALOG.forEach(function (prov) {
        var cb = host.querySelector('[data-socialtoggle="' + prov.key + '"]');
        var entry = { enabled: !!(cb && cb.checked) };
        prov.fields.forEach(function (f) {
          var inp = host.querySelector('[data-social="' + prov.key + '"][data-field="' + f.key + '"]');
          entry[f.key] = inp ? inp.value.trim() : "";
        });
        out[prov.key] = entry;
      });
      return out;
    }
    // Returns the list of "Provider: Field" problems; also paints the UI.
    function validateSocial() {
      var host = $("nz-socialList");
      if (!host || !KIT) return [];
      var state = collectSocial();
      var problems = KIT.validateSocialAuth(state); // array of "Provider: Field"
      SOCIAL_CATALOG.forEach(function (prov) {
        var on = state[prov.key] && state[prov.key].enabled;
        prov.fields.forEach(function (f) {
          var inp = host.querySelector('[data-social="' + prov.key + '"][data-field="' + f.key + '"]');
          var miss = $("sm-" + prov.key + "-" + f.key);
          var bad = !!(on && f.required && !(state[prov.key][f.key]));
          if (inp) inp.classList.toggle("nz-bad", bad);
          if (miss) miss.style.display = bad ? "block" : "none";
        });
      });
      var warn = $("nz-socialWarn");
      if (warn) {
        if (problems.length) {
          warn.style.display = "block";
          warn.innerHTML = "Add: <b>" + problems.map(esc).join(", ") + "</b>.";
        } else { warn.style.display = "none"; }
      }
      return problems;
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

    // ---- Store auto-upload toggles ----
    function reveal(id, on) { $(id).classList.toggle("nz-show", !!on); }
    $("nz-store").addEventListener("change", function () { reveal("nz-storeWrap", $("nz-store").checked); emitChange(); });
    $("nz-ios").addEventListener("change", function () { reveal("nz-iosWrap", $("nz-ios").checked); emitChange(); });
    $("nz-android").addEventListener("change", function () { reveal("nz-androidWrap", $("nz-android").checked); emitChange(); });
    ["nz-ascKeyId", "nz-ascIssuer", "nz-appleTeam", "nz-ascP8", "nz-ksPass", "nz-keyAlias", "nz-keyPass", "nz-playJson"]
      .forEach(function (id) { $(id).addEventListener("input", emitChange); });

    // Read the keystore file entirely in-browser and base64-encode it.
    $("nz-keystore").addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) { keystoreB64 = ""; return; }
      if (file.size > 180000) {
        keystoreB64 = "";
        e.target.value = "";
        $("nz-keystoreInfo").textContent = "Keystore is too large. Use a .jks/.keystore under 180 KB.";
        setStatus("Keystore file is too large.", "err");
        emitChange();
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        var bytes = new Uint8Array(reader.result);
        var bin = "";
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        keystoreB64 = (typeof btoa === "function") ? btoa(bin) : "";
        $("nz-keystoreInfo").textContent = file.name + " · " + bytes.length + " bytes · encoded ✓";
        emitChange();
      };
      reader.readAsArrayBuffer(file);
    });

    function emitChange() { if (typeof opts.onChange === "function") opts.onChange(getState()); }

    $("nz-download").addEventListener("click", function () {
      var st = getState();
      if (!requireSignedInUi("download a native kit")) return;
      setStatus("Generating kit…");
      Promise.resolve(opts.onDownload && opts.onDownload(st))
        .then(function () {
          showSuccess("Kit downloaded", "Your native kit <b>" + esc(st.appName || "app") +
            "</b>.zip is in Downloads. Unzip into your project root and run <code>bash nativize.sh</code>.");
        })
        .catch(function (e) { setStatus("Download failed: " + (e && e.message || e), "err"); });
    });

    // Advanced disclosure for the (demoted) manual setup-kit download.
    $("nz-advToggle").addEventListener("click", function () {
      $("nz-advBody").classList.toggle("nz-show");
    });
    // Options disclosure (app id, push, store upload, manual token).
    $("nz-optToggle").addEventListener("click", function () {
      $("nz-optBody").classList.toggle("nz-show");
    });
    // App permissions disclosure + populate the catalog list.
    $("nz-permToggle").addEventListener("click", function () {
      $("nz-permBody").classList.toggle("nz-show");
    });
    renderPermissions();
    // Social sign-in disclosure + populate the provider list.
    $("nz-socialToggle").addEventListener("click", function () {
      $("nz-socialBody").classList.toggle("nz-show");
    });
    renderSocial();
    // App icon + iOS header disclosure and controls.
    $("nz-brandToggle").addEventListener("click", function () {
      $("nz-brandBody").classList.toggle("nz-show");
    });
    $("nz-logo").addEventListener("change", handleLogo);
    $("nz-logoBg").addEventListener("input", function () { renderLogo(); emitChange(); });
    $("nz-island").addEventListener("change", emitChange);
    setAuthLocked(authRequired && !signedIn);

    // ---- Sign in with GitHub (one click, via Supabase) ----
    $("nz-signinBtn").addEventListener("click", function () {
      if (typeof opts.onSignIn !== "function") {
        return setStatus("Sign-in isn't wired in this context.", "err");
      }
      setStatus("Opening GitHub sign-in…");
      Promise.resolve(opts.onSignIn())
        .then(function (token) {
          if (!token) throw new Error("No token returned.");
          $("nz-token").value = token;     // build flow reads this
          setSignedIn(true);
          setAuthLocked(false);
          setStatus("✓ Signed in with GitHub.", "ok");
          emitChange();
        })
        .catch(function (e) { setStatus("Sign-in failed: " + (e && e.message || e), "err"); });
    });
    $("nz-signout").addEventListener("click", function () {
      $("nz-token").value = "";
      setSignedIn(false);
      setAuthLocked(authRequired);
      if (typeof opts.onSignOut === "function") { try { opts.onSignOut(); } catch (e) {} }
      setStatus("");
      emitChange();
    });

    function actionsLink(url) {
      return url ? ' <a href="' + esc(url) + '" target="_blank" rel="noopener">Open the build ↗</a>' : "";
    }
    // Map a build artifact to a plain-English "what is this / where does it open".
    function describeArtifact(name) {
      var n = String(name).toLowerCase();
      if (n.indexOf("mac") >= 0) return { label: "💻 Mac app (.dmg)", note: "double-click to open on your Mac" };
      if (n.indexOf("win") >= 0) return { label: "🪟 Windows app (.exe)", note: "double-click to open on Windows" };
      if (n.indexOf("ios") >= 0) return { label: "🍏 iPhone app", note: "needs Apple signing to install on an iPhone (won't open on a computer)" };
      if (n.indexOf("android") >= 0) return { label: "📱 Android app", note: "install .apk on an Android phone, or upload .aab to Google Play" };
      return { label: name, note: "" };
    }
    function artifactsHtml(res) {
      if (!res.artifacts || !res.artifacts.length) return "";
      var html = '<div class="nz-arts">';
      res.artifacts.forEach(function (a) {
        var d = describeArtifact(a.name);
        var mb = a.sizeBytes ? " · " + Math.max(1, Math.round(a.sizeBytes / 1048576)) + " MB" : "";
        html += '<a class="nz-art" href="' + esc(a.downloadUrl) + '" target="_blank" rel="noopener">' +
          '<span class="nz-art-main">⬇ ' + esc(d.label) + mb + '</span>' +
          (d.note ? '<span class="nz-art-note">' + esc(d.note) + '</span>' : '') +
          '</a>';
      });
      return html + '</div><div class="nz-hint">Each opens the GitHub build page — tap <b>Artifacts</b> to download. ' +
        'Mac/Windows files open on a computer; phone apps only run on phones.</div>';
    }

    // Live animated progress for the long (~5-10 min) cloud build so it never
    // looks frozen: indeterminate bar + counting-up timer + 4 step dots.
    var BUILD_STAGE_TEXT = {
      push: "Pushing your app kit…",
      dispatched: "Build queued in the cloud…",
      queued: "Build queued in the cloud…",
      in_progress: "Building iOS, Android, Mac & Windows…",
      completed: "Packaging your downloads…"
    };
    function stageToStep(stage) {
      if (stage === "dispatched" || stage === "queued") return 1;
      if (stage === "in_progress") return 2;
      if (stage === "completed") return 3;
      return 0; // push
    }
    function startBuildProgress() {
      var t0 = Date.now();
      var s = $("nz-status");
      s.className = "nz-status";
      s.innerHTML =
        '<div class="nz-prog">' +
          '<div class="nz-prog-top"><span class="nz-prog-stage" id="nz-progStage">Starting…</span>' +
            '<span class="nz-prog-time" id="nz-progTime">0:00</span></div>' +
          '<div class="nz-prog-bar"></div>' +
          '<div class="nz-steps" id="nz-progSteps">' +
            '<span class="nz-step"></span><span class="nz-step"></span>' +
            '<span class="nz-step"></span><span class="nz-step"></span></div>' +
          '<div class="nz-prog-note">Runs in the cloud — keep this open; download links appear when it finishes.</div>' +
        '</div>';
      var stepsEl = $("nz-progSteps");
      function setStep(idx) {
        for (var i = 0; i < stepsEl.children.length; i++) {
          stepsEl.children[i].className = "nz-step" + (i < idx ? " on" : (i === idx ? " on cur" : ""));
        }
      }
      setStep(0);
      var timer = setInterval(function () {
        var el = $("nz-progTime"); if (!el) return;
        var sec = Math.floor((Date.now() - t0) / 1000);
        el.textContent = Math.floor(sec / 60) + ":" + ("0" + (sec % 60)).slice(-2);
      }, 1000);
      return {
        update: function (stage) {
          var st = $("nz-progStage"); if (st) st.textContent = BUILD_STAGE_TEXT[stage] || ("Building… (" + stage + ")");
          setStep(stageToStep(stage));
        },
        stop: function () { clearInterval(timer); }
      };
    }

    // Download the whole project (source: src + ios + android + desktop) as a .zip.
    $("nz-projectBtn").addEventListener("click", function () {
      var st = getState();
      if (!requireSignedInUi("download the full project")) return;
      if (!st.githubRepo) return setStatus("Enter a GitHub repo (owner/repo) first.", "err");
      if (!st.token) return setStatus("GitHub access is missing. Sign out, then sign in with GitHub again.", "err");
      if (typeof opts.onDownloadProject !== "function") return setStatus("Project download isn't wired here.", "err");
      var b = $("nz-projectBtn"); b.disabled = true;
      setStatus("Zipping your full project (src + ios + android + desktop)…");
      Promise.resolve(opts.onDownloadProject(st))
        .then(function () { b.disabled = false; setStatus("✓ Full project downloaded (source + all platform folders).", "ok"); })
        .catch(function (e) { b.disabled = false; setStatus("Project download failed: " + (e && e.message || e), "err"); });
    });

    $("nz-buildBtn").addEventListener("click", function () {
      var st = getState();
      if (!requireSignedInUi("build an app")) return;
      if (!st.githubRepo) return setStatus("Enter a GitHub repo (owner/repo) first.", "err");
      if (!st.token) return setStatus("GitHub access is missing. Sign out, then sign in with GitHub again.", "err");
      var permMissing = validatePerms();
      if (permMissing.length) {
        $("nz-permBody").classList.add("nz-show");
        return setStatus("Add a usage reason for: " + permMissing.join(", ") + " (under App permissions).", "err");
      }
      var btn = $("nz-buildBtn");
      btn.disabled = true;
      var prog = startBuildProgress();
      prog.update("push");
      var onProgress = function (stage) { prog.update(stage); };

      Promise.resolve(opts.onPush && opts.onPush(st, st.token, onProgress))
        .then(function (res) {
          res = res || {};
          prog.stop();
          btn.disabled = false;
          var hasArtifacts = res.artifacts && res.artifacts.length;
          var failed = res.conclusion && res.conclusion !== "success";

          if (hasArtifacts) {
            showSuccess("🎉 Your app is ready", "Your installable app was built in the cloud. Download it:" +
              artifactsHtml(res));
          } else if (failed) {
            showSuccess("Build didn't pass", "The cloud build finished as <b>" + esc(res.conclusion) +
              "</b>." + actionsLink(res.runUrl) + " to read the logs and retry.");
          } else if (res.runUrl || res.actionsUrl) {
            // Build started but we didn't wait for artifacts (or none were produced).
            showSuccess("Building your app", "Your <b>.apk / .aab</b> and iOS app will appear as downloadable " +
              "files when the run finishes (~5–10 min)." + actionsLink(res.runUrl || res.actionsUrl));
          } else {
            showSuccess("Pushed to GitHub", "Kit pushed to <b>" + esc(st.githubRepo) +
              "</b>. Start the build from <b>Actions → Nativize Build → Run workflow</b>.");
          }
        })
        .catch(function (e) { prog.stop(); btn.disabled = false; setStatus("Build failed: " + (e && e.message || e), "err"); });
    });

    function esc(s) {
      return String(s).replace(/[&<>"]/g, function (ch) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
      });
    }

    if (opts.openNow) open();

    return {
      open: open, close: close, toggle: toggle,
      getState: getState, setStatus: setStatus, setPlan: setPlan, showSuccess: showSuccess,
      root: shadow,
      destroy: function () { try { host.remove(); } catch (e) {} }
    };
  }

  return { mount: mount };
});
