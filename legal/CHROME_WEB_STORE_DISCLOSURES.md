# Chrome Web Store Disclosure Notes

These notes mirror the Chrome Web Store Developer Dashboard privacy answers for Nativize.

## Single Purpose

Nativize generates native app project kits from web apps, pushes the generated files to a user-selected GitHub repository when requested, and runs GitHub Actions builds for those native projects.

## Permission Justifications

`storage`: Stores extension settings, selected project configuration, GitHub connection state, billing status, Supabase session state, and GitHub tokens locally in Chrome so users can continue the same native-app project workflow.

`identity`: Runs GitHub OAuth sign-in through `chrome.identity` so users can connect GitHub without manually pasting a token.

Host permissions: Required for GitHub API calls and Supabase Auth/billing/app-activation APIs. The content script is limited to Lovable and local development pages by default; it reads only limited page information, such as title and GitHub links, to prefill editable app and repo fields.

## Remote Code

Nativize does not use remote code. All executable JavaScript is included in the extension package. API, OAuth, and payment-related requests to GitHub, Supabase Auth, Supabase database APIs, Supabase edge functions, and Stripe do not load or execute remote JavaScript or WebAssembly.

## Data Categories

- Authentication information
- Web history, limited to the current page origin/path used locally as a per-project storage key
- Website content, limited to page title and GitHub repository links used for prefill
- Support and feature-request text submitted through the Nativize website

## Certifications

- Nativize does not sell or transfer user data except for approved uses needed to provide the extension's functionality.
- Nativize does not use or transfer user data for unrelated purposes.
- Nativize does not use or transfer user data for creditworthiness or lending.
