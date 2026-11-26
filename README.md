# sn_milo — ServiceNow Milo

One Chromium MV3 extension that replaces the separate critical-alert, interaction-alert, Informatica button,
KB dark-mode and timecard extensions. Every feature has its own toggle on the options page.

## Requirements

- A Chromium-based browser, version 111 or newer (Chrome, Brave, Vivaldi, Edge).
- Node.js 22 or newer — used for one command, `npm run generate` (see below). There is nothing to `npm install`
  and nothing to compile: the extension ships as plain JS/CSS/HTML.

### Why a Node step at all

The repository is public, so it cannot contain your ServiceNow hostnames. The committed `manifest.template.json`
therefore carries `{{PRODUCTION_ORIGIN}}` / `{{TEST_ORIGIN}}` placeholders, and `npm run generate` fills them in
from your gitignored `config.json`, writing the three files that actually get read at runtime:

| Generated file (gitignored) | Read by |
|---|---|
| `manifest.json` | the browser (this is what **Load unpacked** loads) |
| `shared/origins.generated.mjs` | `background.js` origin checks |
| `features/timecard/config.js` | the timecard content scripts |

It runs once per clone and once per update. You could hand-write those three files and skip Node, but they are
validated against the template (`npm run generate:check`, part of `npm test`) and rewritten on every update.

## Install

1. Clone the repository:

   ```
   git clone https://github.com/AzaelMew/sn_milo.git
   cd sn_milo
   ```

2. Create the private instance config from the example:

   ```
   cp config.example.json config.json
   ```

   Edit `config.json` so it holds exactly one `production` and one `test` instance:

   ```json
   {"instances": [
     {"origin": "https://<test-instance>.service-now.com", "mode": "test", "enableSubmission": true},
     {"origin": "https://<production-instance>.service-now.com", "mode": "production", "enableSubmission": true}
   ]}
   ```

   Origins must be exact `https://<name>.service-now.com` hosts. `config.json` is gitignored — do not commit it.

3. Generate the runtime files (`manifest.json`, the timecard config, the origin module):

   ```
   npm run generate
   ```

   `npm install` is not needed.

4. Load the extension:

   - Open `chrome://extensions`
   - Turn on **Developer mode**
   - Click **Load unpacked** and select this repository folder (the one containing `manifest.json`)

   Do not move or rename that folder afterwards: an unpacked extension's ID is derived from its path, and moving
   it loses everything the extension stored (feature toggles, alert rules, accounts, recipients, known-ticket
   history).

5. Open the options page (extension card → **Details** → **Extension options**, or right-click the toolbar icon →
   **Options**), enable the features you want, and fill in the per-feature data (critical-alert rules, interaction
   accounts, Informatica recipients and resolve notes).

## Update

```
cd sn_milo
git pull
npm run generate
```

Then click **Reload** on the extension card in `chrome://extensions` and reopen your ServiceNow tabs — content
scripts only attach to newly loaded documents.

## Load or reload from the command line (optional)

With a Chromium browser already running with `--remote-debugging-port=<port>` and
`--enable-unsafe-extension-debugging`:

```
SN_MILO_CDP=http://127.0.0.1:<port> npm run load -- --yes
```

`npm run update -- --yes` does the same and also reinjects into already-open tabs.

## Package for another machine (optional)

```
npm run package
```

writes `dist/sn_milo-<version>-private.zip` with the runtime files and your configured origins. Keep that archive
private — it is a local transport package, not a sanitized public release.
