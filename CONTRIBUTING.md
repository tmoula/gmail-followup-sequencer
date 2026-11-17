# Contributing to Sheet Sequencer

Thanks for helping! Sheet Sequencer aims to be the simplest free way to run personal email follow-ups from
a Google Sheet. Contributions of every size are welcome: bug reports, docs fixes, translations, features.

## Ground rules

- **Keep setup simple.** One file to paste, no build step, no server, no third-party services. If a feature
  needs configuration, it goes in the Settings tab, not in code.
- **Privacy first.** No tracking pixels, analytics, or data leaving the user's Google account.
- **Safe defaults.** Anything that sends email should be hard to trigger by accident.
- **Be kind** in issues and reviews.

## Getting started

```sh
git clone https://github.com/tmoula/gmail-followup-sequencer.git
cd gmail-followup-sequencer
node test/harness.js                 # needs Node 18+, no npm install
TZ=Asia/Tokyo node test/harness.js   # run in another time zone too
```

The whole script lives in [`Code.gs`](Code.gs). Tests in [`test/harness.js`](test/harness.js) load that file
into a mocked Apps Script environment (Sheets, Gmail, triggers, a fake clock) and run real scenarios. If you
add behavior, add a `test('...', () => { ... })` case next to the existing ones.

To try changes for real, paste `Code.gs` into a test Google Sheet (see the README setup) and use
**Sequencer → Preview** so emails only go to you. [clasp](https://github.com/google/clasp) works too;
`appsscript.json` is the manifest.

## Pull requests

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Keep PRs focused. Update the README if behavior or settings change.
3. Make sure `node test/harness.js` passes. CI runs it on every PR.

## Roadmap: good places to start

Ideas we'd love help with. Comment on (or open) an issue before starting so work isn't duplicated.

| Idea | Difficulty |
|---|---|
| HTML emails and including the user's Gmail signature | Medium |
| Skip public holidays (e.g. from a Google Calendar or a list in Settings) | Easy |
| Per-row time zone column, so each person gets their own morning | Medium |
| Optional opt-out line appended to emails | Easy |
| Attachments column (Google Drive file links) | Medium |
| One-click "Make a copy" template sheet | Easy |
| Translate the menu, dialogs and README | Easy |
| Weekly summary email: sent, replied, bounced | Easy |
| A/B subject lines with reply-rate reporting | Hard |

## Reporting bugs

Use the bug report template. Include the exact Status text and any error from
**Extensions → Apps Script → Executions**. Never paste real contacts' email addresses or message contents.
