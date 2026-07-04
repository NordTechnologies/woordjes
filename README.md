# Woordjes — Learn Dutch (v0 prototype)

A focused Dutch vocabulary app for people studying for the **inburgering** exam.
Learn the words you need in short daily sessions — **tap, don't type**, with spaced
repetition under the hood. Text-only, fully offline, no accounts, free.

This is **v0**: a mobile web app (PWA) for fast testing on an iPhone. The eventual
App Store release will be a native Flutter app built from the same design + logic
(see the plan in Obsidian).

## 🌐 Live (shareable)

**https://nordtechnologies.github.io/woordjes/**

Open on any phone, "Add to Home Screen" to install. Works offline after first load.
Hosted free on GitHub Pages from the `gh-pages` branch.

### Updating the live site after changes
```
git add -A && git commit -m "..."        # commit changes on main
git push                                  # update the source repo
git -c credential.helper='!gh auth git-credential' \
    subtree push --prefix public origin gh-pages   # redeploy the app
```
Pages rebuilds in ~1 minute; the network-first service worker means testers get the
new version on next open.

## Run it on your iPhone (private, over Wi-Fi)

1. On your Mac, run the server (either):
   - Double-click **`start.command`**, or
   - In Terminal: `cd "Nord Technologies/words-app" && ./start.command`
2. It prints a link like `http://192.168.2.3:8000`.
3. On your **iPhone (same Wi-Fi)**, open that link in **Safari**.
4. Optional: Safari **Share → Add to Home Screen** to use it like a real app.

The Mac must stay on and running the server while you test.

## What works in v0

- Drops straight into learning on first open (no signup).
- Browse words by topic; tap a card to see article (de/het), plural, or verb forms.
- Training: multiple-choice (Dutch→English, then English→Dutch), with a de/het
  follow-up for nouns, and an optional forgiving typing "hard mode" (Settings).
- Simple 7-box Leitner spaced repetition; "due today"; daily new-word cap.
- "Learned" list (earned across multiple days); per-topic progress.
- Daily streak with a one-day streak freeze.

## Project layout

```
public/            the app (static, no build step)
  index.html
  css/styles.css
  js/engine.js     learning engine (SRS, sessions, MC, judging, streak)
  js/app.js        UI controller + screens
  data/words.json  ~2435 words, CEFR-tagged A1–B2 (31 topics; native-speaker proofread still recommended)
  icons/           app icons
  manifest.webmanifest, sw.js   PWA bits
tests/engine.test.js   headless logic tests:  node tests/engine.test.js
start.command      local Wi-Fi test server
docs/              team decisions log
```

## Tests

```
node tests/engine.test.js
```

## Specs (in Obsidian → Nord Technologies/Words App)

- `Words App — Unified Plan.md` — the master plan
- `Design Spec (v0).md` — visual + UX spec
- `Learning Mechanics Spec (v0).md` — the SRS/exercise rules this engine implements
- `App Store Guardrails (v0 web → native).md` — App Store compliance notes
- `Build Log.md` — running record of decisions
