# Deployment branding

`branding.json` is the public branding configuration shared by web, desktop,
mobile, server messages, and the main marketing pages. The default is Flow with
a simple F mark. Keep secrets in the existing environment configuration.

Edit the file directly, then generate the matching artwork:

```sh
pnpm branding:generate
pnpm branding:check
```

Alternatively, apply a partial enterprise JSON file to the current configuration:

```json
{
  "name": "Acme Engineering",
  "shortName": "Acme",
  "connectName": "Acme Connect",
  "links": {
    "website": "https://engineering.acme.example",
    "support": "https://engineering.acme.example/support"
  },
  "colors": { "background": "#16324F" }
}
```

```sh
pnpm branding:generate --config /path/to/acme.json
```

This updates `branding.json` and the generated artwork in that checkout. Nested
sections merge with the current configuration; use a clean checkout for each
customer so settings from a previous customer cannot carry over. Regenerate to
switch back after restoring the desired configuration. Builds reject stale
branding assets.

Rebuild each deployed client and server normally. Names and icons are bundled;
changing the server does not rebrand an independently installed mobile or desktop
client. Native installs require a new native build, not just a JavaScript update.
No running services or databases need to be changed to prepare a branded build.

`mark.viewBox` and `mark.path` describe a monochrome SVG mark. The same geometry
renders in web and native navigation and generates app icons, favicons, Android
notification icons, and widget artwork. `colors` controls the generated icon
background and foreground, not the user's editor theme. Use the brand's full
name and short name for text; there is no fixed “Code” suffix.

The links are independently configurable. `repository` is a GitHub repository
URL used by the marketing download page; `releases` is its release-history URL.
Configure enterprise mobile distribution URLs through `iosDownload` and
`androidDownload`. `legalWebsite` is the base URL for `/legal`, `/privacy-policy`,
`/terms-of-service`, and `/security-policy`. It retains upstream's published
documents by default; provide the deployment's own legal site before distributing
it under different terms. Upstream license notices, legal text, quoted
testimonials, and the historical marketing campaign remain attributed to T3.

Branding does not change persisted storage paths, package names, CLI commands,
native bundle IDs, URL schemes, provider IDs, or wire protocol keys. Those are
installation and compatibility settings, not display branding. Existing cloud,
signing, and update-publishing environment settings still select the actual
services and release repository; changing a display link does not redirect them.
