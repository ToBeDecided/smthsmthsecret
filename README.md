# LSAT Miss Capture

A Firefox extension that notices when you open a results page on **7Sage** (LSAT Demon to follow), picks out the questions worth journaling, and sends them to the **Inbox** tab of your own Google Sheets wrong-answer journal. You then turn Inbox rows into full journal entries, one-line quick notes, or skips.

Captured, per question: platform, PrepTest, section, question number, question type, difficulty, timed or not, your first answer, the correct answer, your blind-review answer and flag (when shown), time spent (when shown), attempt date, and a link back to the question.

Captured questions:

- every **miss**,
- every question you got **right but flagged** (a lucky guess is a miss you have not paid for yet),
- every question you got **right first but changed to wrong in blind review**.

> **Not affiliated** with 7Sage, LSAT Demon, LSAC, or LawHub. The extension stores and sends **no test content**: no question stems, passages, answer-choice text, or explanations. Only identifiers, metadata, and a link. It reads only pages you already have open and makes no requests of its own to either site.

## How it fits together

```
7Sage results page ──(content script reads the page you're on)──▶ extension background
                                                                     │ outbox in browser.storage.local
                                                                     │ (kept until the sheet confirms)
                                                                     ▼
                                           Apps Script web app  (doPost, shared secret)
                                                                     ▼
                                       Inbox tab ──▶ your existing Journal (same save path as the sidebar)
```

| Path | What it is |
| --- | --- |
| `extension/` | The Firefox add-on (Manifest V3, background event page). |
| `extension/content/platforms/*.config.js` | **All selectors for a site, in one file.** Edit this when a site redesigns. |
| `apps-script/` | Files to add to your sheet's Apps Script project. |
| `scripts/` | Fixture sanitizer and secret scanner. |
| `fixtures/clean/` | Sanitized page snapshots the parser tests run against. |
| `test/` | Unit tests (`npm test`). |

## Requirements

- Firefox 140 or newer (desktop).
- Node.js 20+ for development (`npm install` once).
- A Google Sheet with the journal Apps Script project.

## 1. Set up the sheet side

1. Open your journal sheet → **Extensions → Apps Script**.
2. Add each file from `apps-script/` as a new file with the same name (**+ → Script**). Paste the contents and save.
3. Run **`lmcSetUpCapture`** (choose it in the function dropdown, then **Run**; approve the permissions prompt the first time). This:
   - creates the **Inbox** and **Mapping** tabs if they do not exist, and
   - generates a random secret and stores it in **Project Settings → Script Properties** as `LMC_SECRET`.

   When run from the sheet menu, it shows the secret in a dialog. When run from the editor, copy it from Script Properties.
4. If your **Lists** headers differ from `Platform`, `Question Type`, `Difficulty`, edit `LMC_FIELDS` at the top of `Inbox.gs`.

### Deploy the web app

1. **Deploy → New deployment** → gear icon → **Web app**.
2. **Execute as: Me.** The script writes to your sheet with your permissions.
3. **Who has access: Anyone.** The extension calls it without a Google login. This means anyone who learns the URL can reach it, which is why **every request must carry the secret**. Requests without it are rejected before any sheet is touched. Keep both the URL and the secret private.
4. **Deploy**, then copy the **Web app URL**. It ends in `/exec`.

Opening that URL in a browser shows `{"ok":true,"data":{"app":"lsat-miss-capture",...}}`. That is the health check and returns no data.

### Push script updates without changing the URL

Creating a *new* deployment gives you a *new* URL. To update the code behind the URL you already have:

**Deploy → Manage deployments → select the web app → pencil (Edit) → Version: New version → Deploy.**

The `/exec` URL stays the same, so the extension needs no change.

## 2. Install the extension

### During development

```sh
npm install                 # also turns on the pre-commit secret scan
npm start                   # = web-ext run: opens Firefox with the add-on loaded
```

`web-ext run` uses a throw-away profile by default, so you would have to log in to 7Sage every time. To keep a dev profile you stay logged in to:

```sh
npx web-ext run --source-dir extension --firefox-profile ~/.lmc-dev-profile --profile-create-if-missing --keep-profile-changes
```

Or load it into your everyday Firefox: open **`about:debugging` → This Firefox → Load Temporary Add-on…** and pick `extension/manifest.json`. A temporary add-on **disappears when Firefox restarts**.

### Permanently: sign it as an unlisted add-on

Firefox release only runs signed add-ons. Unlisted signing is automatic: Mozilla signs it but does not publish it.

1. Create API credentials at <https://addons.mozilla.org/developers/addon/api/key/>.
2. Put them in environment variables. **Never commit them**: the pre-commit hook and CI block AMO keys.
   ```sh
   export WEB_EXT_API_KEY='user:…'
   export WEB_EXT_API_SECRET='…'
   ```
3. Bump `"version"` in `extension/manifest.json`. Every upload needs a new version.
4. `npm run sign` (= `web-ext sign --channel unlisted`). The signed `.xpi` lands in `web-ext-artifacts/`.
5. In Firefox: **`about:addons` → gear icon → Install Add-on From File…** → pick the `.xpi`.

At install time, Firefox asks you to agree to the data the add-on sends (*website content* and *browsing activity*). The add-on only ever sends that data to the web app URL you configure, not to the developer or anyone else.

### First run

The options page opens by itself.

1. **Site access.** Firefox may not grant host permissions automatically. If anything shows ✗, click **Grant access** and choose **Allow**. If no prompt appears, open `about:addons` → LSAT Miss Capture → **Permissions** and switch the sites on.
2. **Connect your sheet.** Paste the `/exec` URL and the secret → **Save** → **Test connection**.
3. Optional: turn on **Dry run** to see what would be sent, without writing to the sheet.

The secret and URL are stored only in `browser.storage.local`; neither is hard-coded anywhere.

## Using it

Finish a drill, section, or PT on 7Sage and open the results / review page. After a moment a toast appears:

> 4 misses + 1 flagged from PT 158 S2 → Inbox

The toolbar badge counts captures you have not dealt with yet: New rows in Inbox plus anything still waiting to send. If the sheet cannot be reached, captures wait in the browser and retry with backoff. The options page lists anything waiting, with **Retry**. Nothing is dropped automatically.

Reopening a results page does not add duplicates. Each question attempt has a capture ID, and the sheet ignores IDs it has already seen.

If a page did not trigger a capture, click the toolbar button → **Capture this page**.

### Mapping site labels to your Lists

Platform, question type, and difficulty are matched against your **Lists** tab:

1. A row in the **Mapping** tab wins (`Field`, `Platform` (blank = any site), `Site value`, `Journal value`).
2. Otherwise a Lists value that matches ignoring case is used.
3. Otherwise the site's value goes through **as-is** and the Inbox **Needs review** column says so. Add a Mapping row and future captures will map.

## Fixing a broken selector

When a site redesigns, captures stop (no toast) or the Inbox gets blanks. To fix it:

1. Open the results page in Firefox and save it with **File → Save Page As… → "Web Page, complete"** into `fixtures/raw/<site>/`.
   - Do not use "HTML only": for these single-page apps that saves the empty shell from before the results render.
   - `fixtures/raw/` is git-ignored. It holds licensed test content and your account details.
2. `npm run sanitize` writes a cleaned copy to `fixtures/clean/`. Open it and check that no question text, your name, or your email survived. Put extra terms to scrub (your name, username) one per line in `fixtures/raw/redact.txt`.
3. Open `extension/content/platforms/<site>.config.js`. Every selector and JSON path the parser uses is there, with a comment saying what it should point at. Use the browser's Inspector on the live page to find the new ones.
4. `npm test` runs the parser against every fixture. Add the new fixture's expected values to the site's test file.
5. Reload the add-on (`about:debugging` → **Reload**, or rebuild and re-sign) and revisit the page.

## Development

```sh
npm test         # unit tests (parsers, capture rules, outbox, Apps Script via an in-memory sheet)
npm run lint     # web-ext lint — must pass with zero warnings
npm run scan     # secret scan over tracked files
npm run check    # all three
```

### Keeping the public repo clean

- `reference/`, `fixtures/raw/`, and `fixtures/README.md` are git-ignored and must never be committed.
- `npm install` points git at `.githooks/`. The **pre-commit hook** refuses commits containing:
  - Apps Script `/exec` URLs or deployment IDs,
  - Google sheet or Drive URLs,
  - API keys and tokens,
  - personal email addresses,
  - any file under the private folders.
- The **`checks` GitHub Action** runs the same scan over every line ever committed, plus the tests and `web-ext lint`.
- If the scan ever catches a real secret that was already pushed, **rotate it first**: run `lmcRotateCaptureSecret` and paste the new one into the extension. Then clean the history.

## License

MIT. See [LICENSE](LICENSE).
