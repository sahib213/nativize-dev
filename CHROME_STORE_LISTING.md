# Chrome Web Store listing — compliant copy (resubmit after rejection)

**Why it was rejected:** "Keyword spam" — the listing **description** repeated brand/keyword
names (Lovable, Apple, Google, Microsoft, GitHub, Capacitor). The fix is to describe
the extension's function plainly and mention third-party names only where they're
functionally necessary, not as a repeated keyword list.

The manifest description + version are already fixed in code (v1.1.5). The text below
is for the **Store listing → Description** field in the dashboard (that long field is
not stored in the repo, so paste it manually).

---

## Short description (132 char max — matches the manifest)

```
Turn your Lovable web app into native iOS and Android apps. Generated in your browser and built in the cloud.
```

## Detailed description (paste into Store listing → Description)

```
Nativize turns a web app you built with Lovable into a real native app project you fully own.

Everything runs in your browser. Open your project, pick your options, and Nativize generates a complete native app project, then pushes it to your own code repository. An included cloud build workflow then produces installable iOS and Android builds — you don't need a Mac or any local native tooling to get started.

What you can do:
• Generate a native app project from your existing web app
• Push the generated project to your own repository in one click
• Build iOS and Android in the cloud with the included workflow
• Add a custom app icon from your own logo
• Configure app permissions, push notifications, and sign-in
• Download the full project as a .zip whenever you want

You stay in control. The generated code is a standard project in your own repository that you can keep building with — Nativize is not a closed, hosted wrapper. Your access token is stored in your browser and used by Nativize only for repository actions and secure download checks; it is not stored on a Nativize server.

Note: publishing an app to a mobile app store requires the usual developer account and that store's review. Nativize is an independent tool and is not affiliated with or endorsed by the platforms it integrates with.
```

**Guidelines this follows**
- Each third-party name appears at most once or twice, only where it's functionally needed.
- No repeated keyword lists, no "iOS, Android, Mac, Windows, App Store, Play Store, …" stuffing.
- The non-affiliation line is generic (doesn't re-list every brand).

---

## How to resubmit (you must do this in your dashboard — I can't)

1. Build is ready: **`dist/nativize-extension-1.1.4.zip`** (manifest v1.1.4, cleaned description).
2. Go to the **Chrome Web Store Developer Dashboard** → your item.
3. **Package**: upload `dist/nativize-extension-1.1.4.zip` (new version 1.1.4).
4. **Store listing → Description**: replace the current text with the *Detailed description* above.
   Also check the **Summary/short description** field uses the short version above.
5. Re-check **screenshots, title, and promo images** for the same issue — no keyword
   pile-ups or text overlays stuffed with brand names.
6. Save the draft, then **Submit for review**.

If you think the original was a mistake you can also use the **Appeal** button on the
item's Build → Status page — but the cleaner-copy resubmission is the faster path.
