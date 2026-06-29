# Nativize Privacy Policy

Effective date: June 26, 2026

Nativize is a Chrome extension that helps users generate native iOS, Android, macOS, and Windows project files from a web app, push generated files to the user's GitHub repository, and run GitHub Actions builds.

## Data Nativize Handles

Nativize handles only the data needed for its app-generation and build workflow:

- Authentication information, such as a GitHub OAuth token, Supabase session token, manually entered GitHub token, Stripe billing status, and optional app-store upload credentials when the user enables store-upload workflows.
- Project configuration entered by the user, such as app name, app ID, repository name, web build directory, build options, permission descriptions, social sign-in options, and selected platform settings.
- Limited website content used for prefill, such as the current page title and GitHub repository links found on the current page.
- The current page origin and path may be used locally as a key for per-project settings. Nativize does not create or transmit a general browsing-history list.
- Support requests and feature requests submitted through the Nativize website, including the email address and message text the user chooses to provide.

## How The Data Is Used

Nativize uses this data to:

- Generate native project files and downloadable project archives.
- Push generated files to the GitHub repository selected by the user.
- Create encrypted GitHub Actions secrets when the user enables store-upload workflows.
- Trigger GitHub Actions workflows and fetch build status or artifacts.
- Check paid-plan entitlement and app activations with Supabase, and start Stripe Checkout for paid plans.
- Prefill editable fields in the extension UI.
- Respond to support requests and consider submitted feature requests.

## Storage

Nativize stores extension settings, selected project configuration, GitHub connection state, billing status, Supabase session state, and GitHub tokens locally on the user's device. The Chrome extension uses `chrome.storage.local`; the web Studio keeps auth tokens in `sessionStorage` so they clear when the browser session ends. Optional store-upload credentials are not saved as normal extension settings; when the user enables store upload, they are sent to GitHub to be stored as encrypted GitHub Actions secrets.

Users can remove locally stored data by signing out in the extension, clearing extension data in Chrome, or uninstalling the extension.

Support requests and feature requests submitted through the website are stored in the Nativize Supabase project.

## Third-Party Services

Nativize communicates with these services only as needed for its native-app generation workflow and website support forms:

- GitHub, to authenticate, read repository metadata, push generated files, create encrypted Actions secrets, trigger workflows, and fetch build artifacts.
- Supabase Auth, to complete the GitHub OAuth sign-in flow and return a GitHub provider token to the extension.
- Supabase, to store billing entitlements, app activations, support requests, and feature requests.
- Stripe, to process checkout, subscriptions, one-time purchases, tax, receipts, and payment status.

Nativize does not sell user data. Nativize does not use or transfer user data for advertising, creditworthiness, lending, or purposes unrelated to generating and building native app projects.

## Remote Code

Nativize does not load or execute remote JavaScript or WebAssembly. The extension package contains its executable code. Network requests to GitHub, Supabase Auth, Supabase database APIs, Supabase edge functions, and Stripe are API/OAuth/payment requests, not remote executable code.

## Children

Nativize is not directed to children.

## Changes

This policy may be updated when Nativize changes how it handles data. Material changes will be reflected by updating this policy.

## Contact

For support or privacy questions, use the support form on the Nativize website or the support information provided with the Nativize Chrome Web Store listing.
