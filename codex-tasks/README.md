# Codex task packets

These are the self-contained chunks split off for **Codex** to work in parallel
while Claude owned architecture, the shadow-DOM UI, and all live browser
verification.

Each packet is written to stand alone: a tight spec + explicit acceptance
criteria, so you can paste it into Codex to cross-check or regenerate that piece
independently, then diff against what's already in the repo.

| Packet | Target file(s) | Owner |
|--------|----------------|-------|
| [01-kit-templates.md](01-kit-templates.md) | the kit template strings in `src/kit-generator.js` | Codex (codegen) |
| [02-workflow-yaml.md](02-workflow-yaml.md) | `.github/workflows/nativize-build.yml` (generated) | Codex (codegen) |
| [03-unit-tests.md](03-unit-tests.md) | `test/kit-generator.test.js` | Codex (codegen) |
| [04-icon-generator.md](04-icon-generator.md) | `icons/generate-icons.js` | Codex (codegen) |

**Claude kept:** overall architecture, the Capacitor 8 domain knowledge, the
extension shell + shadow-DOM panel (`src/panel.js`, `src/content.js`,
`src/zip.js`, `src/github.js`, `manifest.json`, `popup.html`), and ALL live
browser verification (preview screenshots, console checks) + final integration.

> Note on coordination: Codex was running interactively in the user's terminal,
> which can't be driven programmatically from this environment. So Claude built
> and verified every piece, and these packets capture the exact specs that would
> have been handed to Codex — runnable through Codex any time for an independent
> second implementation to diff against.
