# Coach: personal training and food tracker

A single-file web app for one person (Surath). It tracks meals and macros, lift weights, and plans each day's workout, carrying missed sessions forward. It is hosted as a static site on Vercel from this repo, with one small serverless function for optional cloud backup. There is no build step and no framework.

## Files

- `index.html`: the whole app (HTML, CSS, JavaScript). Vercel serves it from the repo root.
- `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png`, `favicon-32.png`: the app icon (blue gradient, glass dumbbell). Must sit next to `index.html`.
- `manifest.webmanifest`: name, standalone display, icons.
- `api/sync.js`: the cloud backup function (Vercel Node function, no npm packages, Node built-ins and `fetch` only). It stores the app's data in Upstash Redis.
- `vercel.json`: runs the function in Frankfurt (`fra1`), next to the database.
- `.gitignore`: keeps the local `.vercel` link out of git.
- `CLAUDE.md`: this file.

## How to work on it

- Edit `index.html` directly. Keep it one file, vanilla JavaScript, no dependencies, no CDN links, no web fonts. `api/sync.js` also stays dependency-free.
- Deploy by pushing to `main`. Vercel redeploys on its own. No build command, no framework preset.
- Most requests are small edits to the config block at the top of the script (foods, lifts, sessions, targets). Do those first and leave everything else alone.
- After a change, open the page and check each tab (Train, Eat, Progress, Setup) for console errors.
- **Always pull up the local preview after a change** so Surath can try it right away: start `coach` from `.claude/launch.json` (localhost:4173), set the Browser pane tab to light mode, reload it and leave it on the screen that changed. Do this before asking whether to push.
- Keep the version in `APP_VERSION` up to date when behaviour changes.

## Design rules

- **Light and dark follow the system** (`prefers-color-scheme`), with no switch in the app. Every colour is a token in `:root`, and the dark block below it sets Apple's iOS 26 dark values (black background, `#1C1C1E` cards, `#2C2C2E` cards inside sheets, blue `#0091FF`). Never hard-code a colour in a rule; add a token with both values. White stays white only for text on coloured fills, the switch knob and the touch glow. `theme-color` has a light and a dark entry for the status bar.
- **iOS 26 Liquid Glass, following Apple's HIG.** The `.glass` class is the material: translucent white tint, backdrop blur, saturation and brightness, a specular highlight and touch glow (`::before`) and a light rim (`::after`). Safari cannot do real lensing (no SVG filters in `backdrop-filter`), so edges and inner light imply it.
- **Glass is for the navigation layer only**: tab bar, its accessory (rest timer), toolbar buttons, menus, sheets, alerts and toasts. Content (cards, rows, the week strip) stays solid. No glass on glass. Small glass is clearer; large glass (menus, sheets) is thicker and more opaque. Tint glass only for the primary action (`.btn`, prominent glass).
- **Glass materialises, it does not fade.** Appearing and disappearing ramp blur, tint and scale (`.ghost` state and the `mat` animation). Only what sits on the glass fades.
- **Interaction:** touching glass lights it from the fingertip (`.lit`, `--px`/`--py`, spreading to the shared group) and it grows slightly with a spring. Controls lift into a see-through lens while touched: the tab bar selection (drag it across tabs), segmented control thumbs (drag them), and switch knobs.
- **Native patterns in place:** a transparent nav bar with glass toolbar buttons (`toolbarHTML`: a glass Back button on Setup pages, a `+` and `⋯` group on the right; Today is a tinted capsule beside the week arrows, not in the nav bar), large titles that hand over to an inline title and subtitle on scroll, a soft scroll edge effect at the top and bottom (`.edge`), a floating tab bar that always stays full size (Surath does not want it minimising on scroll), the rest timer as a tab bar accessory above it, menus that grow out of their button (`openMenu`), sheets that always slide up from the bottom (Surath does not want them zooming out of the `+`) and are inset glass at partial height but edge to edge and opaque when tall (`.sheet.full`), a sheet bar with Close or Back leading and an inline title, a glass alert (`askGlass`), inset grouped cards, swipe left to delete with Undo (as in iOS lists: the red action fills exactly what the row uncovers and grows with the swipe, short of halfway closes, past halfway or a flick opens at 82 px, past 60% deletes on release, swiping right does nothing, scrolling or tapping elsewhere closes; `setSwipe`, `DEL_W`), tap-to-complete sets, banner toasts. Sheets sit above the on-screen keyboard (`--kb` from `visualViewport`), and full-height sheets (the food list always) have a fixed top so short lists stay under their search field.
- **Setup follows the Apple Health profile:** a centred header (app icon, name, last backup with Back up now), then inset grouped rows with chevrons under bold section headers. Each row opens its own page (`ui.setupPage`, `SETUP_PAGES`, `setupPage`) with a glass Back button and an inline title. Back also works by swiping from the left edge or tapping the Setup tab. Value pickers are native `<select>` styled as the iOS menu picker (`.pick`), so the phone shows Safari's own picker.
- **A day is either a training day or a rest day, never both.** On Eat this is one quiet pop-up button at the top right of the summary card (`.dtpick`, menu `daytype`) that states what the day is: grey text and icon with up/down chevrons, like the Weekly split picker, not accent blue (it is a status you can change, not a primary action). Its menu lists both types with their targets and a check on the current one. Do not show the two types as tabs or a segmented control.
- **Hierarchy in lists:** on Eat, each meal's name and totals are the headline (17 px name, 16 px bold black totals); each food's own macros are small, regular and grey, and an empty meal shows no row of zeros. On Train, a closed exercise shows the weight to load big on the left (Surath likes it there, it is the number that matters at the gym), the lift's name with the reps needed under it (`3 × 8–12 reps`, `reps/side` for single-arm lifts; he wants those at a glance) and the status chip, nothing else; the reasoning and what was logged (`exWhy`) appear only once it is opened, above the sets.
- **Macro bars follow Health's comparison bars:** a big number with its target, then a thick rounded bar with the macro's name inside (`macroRow`, `.mbar`). The name is drawn twice so it stays readable on both the track and the fill.
- **Motion:** SwiftUI-style springs as CSS `linear()` curves (`--spring` bouncy, `--smooth`, `--snappy`, with cubic-bezier fallbacks). JavaScript animations read them through `EASE`. Page changes animate only the new content, underneath the bars: `.swap` fades a new tab in, `.enter` slides a pushed Setup page in. A day change keeps the title and week strip still, slides only `.daybody` a little, and lets the rings, macro bars and calorie number glide from the old day's values (`meterSnap`, `meterMorph`) instead of refilling from empty. Do not use the View Transitions API: its snapshots paint above the fixed nav bar and tab bar, and giving those a `view-transition-name` makes them a backdrop root, so their glass stops blurring. The toolbar glass persists between screens (`setToolbar` swaps the buttons on it) and only materialises or dematerialises when a screen has none. Every animation must respect `prefers-reduced-motion`, which also switches the code to synchronous paths.
- Apple's SF Symbols and font files are not bundled (licence). The iPhone renders the system font as SF Pro automatically. Icons are hand-drawn SVGs in the SF style. Toolbar and menu icons are monochrome.
- **Accent colour is iOS 26 system blue** (`--accent: #0088FF`, `#0091FF` in dark). Use it for things you can tap and for selection. Change it in one place, the `:root` block. Colours follow the iOS 26 palette (red `#FF383C`, indigo `#6155F5`).
- **Macro colours are data only**: protein indigo, fat yellow, carbs green, kcal blue. Do not use them for buttons.
- Mobile first, one column, max width 560px. Tap targets at least 44px.
- Copy: plain, sentence case, active voice, and short: units like `kg/side`, `kg/hand`, `reps/side`. **No em dashes anywhere**, in the UI or in replies to the user.
- Respect `prefers-reduced-motion`. Keep focus outlines visible.

## Code layout inside `index.html`

1. CSS in `<style>`.
2. **CONFIG**: `DEFAULT_TARGETS`, `DEFAULT_CAPS`, `EX` (lifts), `TEMPLATES` (sessions), `DEFAULT_SCHEDULE`, `FOODS`, `QUICK`, `SLOTS`, and the starting data (`SEED_SETS`, `SEED_WAIST`, `SEED_DAYS`).
3. **CORE**: helpers, storage, `liftHistory`, `suggest` (progression), `computeOwed` and `buildPlan` (planner), macro maths, `suggestGap`.
4. **Views**: `viewTrain`, `viewEat`, `viewProgress`, `viewSetup`.
5. **Sheets, timer, render, gestures and events**: `drawSheet` and `morphSheet`, `toast`, `askGlass`, the rest timer (`startRest`), `render` and `afterRender` (tab indicator `placeIndicator`, `setToolbar`, `initSegs`, nav bar, number tween), menus (`menuSpec`, `openMenu`, `closeMenu`), the `H` handler object, pointer gestures (swipe rows, sheet drag, then the Liquid Glass block: touch light, tab and segment lens drags, week swipe) and delegated click, input, change and keydown listeners.

Rendering is plain template strings. Views re-render with `render()`. Logging is the exception: set inputs save on `input` and only refresh the lift header and the session card, and opening a lift or checking a set only replaces that lift (`refreshEx`), so focus and scroll are kept. `ui.anim` is set before renders that should replay the rings and bars (tab or day change).

Do not name top-level functions or variables after browser globals (`history`, `name`, `top`, `status`, `event`, `close`). A function called `history` once broke the whole app.

## Data and storage

- Everything lives in `localStorage` under the key `coach-v1`, as one JSON object `S`. The device is always the source of truth and the app works offline. Setup has Export and Import for backups.
- **Cloud backup (optional, Setup, Your data, Cloud backup).** Each device connects once with a passphrase. `saveState` saves locally (`saveLocal`) and schedules a sync 4 s later (`scheduleSync`); the app also syncs when it opens, comes back to the foreground and comes back online (`syncNow`). The device keeps its sync details in `coach-sync` (passphrase, cloud revision, status) and the last synced copy in `coach-sync-base`.
- When both the device and the cloud changed, `merge3` merges them against that last synced copy, date by date: a day changed on one side takes that side (deletions included); a day changed on both sides combines food entries by id and keeps an entry identical in name, meal, amount and macros only once (every install creates the same starter days with different ids), real logged food beats an imported day total for the same day, the lift with more done sets wins, and the higher water wins. Custom foods are matched by name, unit and macros. On first connect there is no base, so both sides are combined and nothing is replaced. Erase everything turns sync off on that device first, so it never wipes the cloud.
- The function (`api/sync.js`) checks `Authorization: Bearer <COACH_TOKEN>`, keeps a revision number and answers 409 with the newer copy when a device is behind. Redis keys: `coach:meta` (rev, savedAt, device), `coach:state` and one `coach:snap:YYYY-MM-DD` per day kept for 31 days, all gzipped. `GET /api/sync?snapshots=1` lists snapshots and `?snapshot=DAY` returns one.
- Vercel setup: project `fitness-app` under `surath-me`, Upstash for Redis resource `coach-sync` (Free plan, Frankfurt, auto-upgrade and eviction off, so it can never cost money), env vars `KV_REST_API_URL` and `KV_REST_API_TOKEN` from the integration, and `COACH_TOKEN` (sensitive, production). The passphrase is in `data/cloud-passphrase.txt` on Surath's Mac only. Never print it, commit it or put it in a URL.
- Import also takes a history file (`kind: 'coach-history'`, built from the chat logs). It only fills gaps (`mergeHistory`): a food day is added only if nothing is logged that day, a lift session only if that lift has no sets that day, and nothing is overwritten. A normal backup still replaces everything.
- Personal exports and history files live in `data/`, which is excluded from git (the repo is public). Never commit them.
- Safari and an installed home-screen icon have separate storage. Say so if the user switches.
- `S` holds: `days[date].entries`, `workouts[date].ex[liftId] = [{w, r}]`, `dismissed`, `foods` (custom foods), `waist`, `water`, and `settings` (targets, caps, schedule, `timeBudget`, `returning`, `exCfg`, `planStart`).
- Dates are local `YYYY-MM-DD` strings. Weekday 0 is Sunday.
- `window.__TODAY__` overrides today's date for testing. `window.__coach` exposes internals for debugging.
- **Saved settings beat code defaults.** Changing `DEFAULT_TARGETS`, `DEFAULT_CAPS` or `DEFAULT_SCHEDULE` only affects new installs. To change values for the existing user, add a migration in `migrate()` or tell them to edit Setup.
- Foods, lifts and sessions come from code, so edits to `FOODS`, `EX` and `TEMPLATES` apply immediately. Per-lift overrides saved in `exCfg` still win.
- Seed data is only written on first run, never to an existing install.
- Food entries store their own macros, so editing a food never rewrites history.

## Planner rules (`buildPlan`)

- Today's scheduled session comes from `settings.schedule`.
- **Carry-over:** every exercise in a scheduled session from the last 7 days that has no logged sets on or after that date is owed. Owed exercises join today's pool, exercise by exercise. Days before `planStart` (the first day the app was opened) are ignored.
- **Recovery:** a compound lift is held back if its muscle was trained yesterday (needs 2 days). Isolation lifts need 1 day.
- **Lower body once a week:** if two or more leg lifts were logged in the last 5 days, quads, hamstrings and calves wait.
- **Time budget:** 45, 60, 75 (default) or 90 minutes. The time control and the "Back after a break" switch only show when the day has exercises; a rest day hides them. About 11 minutes per compound, 8 per isolation, 6 for abs. Compounds are kept first, then lower `prio`, then older owed. What does not fit stays owed.
- Past days show only what was logged. Future days show only the schedule.
- Buttons: skip today's session, drop carried exercises, train a different session, add an exercise by hand.

## Meal suggestions (`planDay`, shown inside the Eat meal cards)

- Runs on the device, no AI and nothing sent anywhere. It plans every meal after the last one logged that day (a meal not logged yet is still planned, so it is one tap to log), on today and future days, never on past days.
- Suggestions live inside the meal cards under Meals, not in a separate section: each meal not logged yet shows one quiet grey row (`sugBlock`): a small sparkle, the foods with amounts, one line of `kcal · g protein · short tag`, a grey shuffle button for another idea and the food list's round `+` to log it. Keep it low-key: no tinted tile, no coloured macro dots, no filled blue buttons (Surath found those too loud). Logging any food in a meal re-plans the meals after it. A note under the meals says where the day ends with the suggestions (`planNote`). With every meal logged and the day still short, the single-food top-ups (`suggestGap`, `topUps`) appear instead.
- Ideas come from `MEALS` (per slot; `flex` is the food whose amount is tuned, `office` meals are canteen lunches, `usual` marks a standing habit: eggs and whey at breakfast, chicken and rice at dinner) plus meals logged at least twice in the last 60 days (`learnedMeals`, with his real portions).
- Rules are hard filters, never traded off: the daily limits (capped foods are trimmed to the room left or the meal is dropped), fruit only in the snack, no bread at breakfast, and only foods in his list.
- It tries every combination of the remaining meals (12 best ideas per meal, a few ms), sizing each meal in order so what one meal leaves over goes to the next, and keeps the day that lands best: calories close to target, protein at the floor (each gram under weighs about 85 kcal off target) and not over 178 g, fat under the ceiling, one fourth protein source (`FOURTH_PROTEIN`), canteen lunch on `OFFICE_DAYS`, his usual and recent meals first, puddings only when clearly better (cost), a little variety from yesterday.
- `SLOT_SHARE` says how a day is usually spread. "Another idea" moves that meal to its next idea and re-plans the others around it (`ui.planAlt`). The `+` logs all of a meal's foods in that slot.

## Progression rules (`suggest`)

- Double progression. If every set in the last session reached the top of the rep range and there were at least the target number of sets, add the lift's `inc`.
- Otherwise hold the weight. Two sessions in a row under the bottom of the range at the same weight means go one step lighter.
- Gap since the last workout of any kind (not per lift): 5 to 14 days means treat set 1 as a check, 15 days or more means start one step lighter.
- "Back after a break or illness" switch: set 1 one step lighter, add weight from set 2 if easy.
- Single-arm lifts (`single: true`): the left arm leads and the right matches the reps.

## The user's food rules (do not break them)

- Daily limits: **3 whole eggs, 1 whey scoop, 250 g quark, 150 g cooked chicken breast** (raw counts as 0.75), **2 protein puddings per 7 days**.
- Protein 160 g is a floor, fat 70 g (65 on rest days) is a ceiling. Do not push suggestions above about 175 g protein.
- Training day 2,250 kcal, 160 P, 70 F, 235 C. Rest day 2,000 kcal, 160 P, 65 F, 175 C.
- A fourth protein source is needed every day (tuna, chana, dal, soya, turkey). The gap suggester only offers foods that respect these limits.
- Never suggest Harzer Käse, apples, or bread at breakfast. Fruit goes in the afternoon.
- He cooks with a little oil and often under-eats calories and carbs. The fix is carbs and some fat, not more protein.
- Lift names that look alike are different machines and are logged separately: pec deck vs pec fly, leg press vs vertical squat machine. Hammer curls are retired because they injured his elbow.

## Common edits

- **Add a food:** add `F('id','Name','g'|'piece',group,kcal,p,f,c,{step,inc})` to `FOODS`. Unit `'g'` means macros per 100 g. Any other unit means macros per piece or portion.
- **Link a food to a limit:** pass `{cap:'egg'|'whey'|'quark'|'chicken'|'pudding'}`, and `capMul` to convert units.
- **Add or change a lift:** edit its entry in `EX` (rep range `low`/`high`, `sets`, `inc`, `prio`, `ord`, `unit`). Add its id to a session in `TEMPLATES`.
- **Change the week:** edit `DEFAULT_SCHEDULE` for new installs. For the existing user use Setup, or a migration.
- **Change a one-tap meal:** edit `QUICK`.
- **Add or change a planner meal idea:** edit `MEALS` (and `OFFICE_DAYS` if the office days change).
- **Change the accent colour:** edit `--accent`, `--accent-t` and `--accent-press` in `:root`.

## Testing notes

The local preview (`.claude/dev-server.py` on port 4173, kept out of git) serves the working copy and forwards `/api/sync` to the live site, and Surath's local copy there is connected to the real cloud. So never add test data in that browser; run automated tests in separate browser contexts, which start disconnected. There is no test suite in the repo. To test cloud sync without touching production, run `api/sync.js` behind a small local Node server with a fake Upstash REST endpoint (it only needs `GET`, `SET` with `EX`, `SCAN`, and the `/pipeline` and `/multi-exec` paths), then drive two browser contexts as two devices. In automated tests, stub `matchMedia` to report reduced motion so sheets and toggles run synchronously. For visual checks, drive the page with Playwright in WebKit and Chromium at 393×852. Headless WebKit does not draw `backdrop-filter` or the incoming page of a view transition, so judge the glass in Chromium or on the phone. When changing the planner or progression, check by hand with `window.__TODAY__` set before load (for example `window.__TODAY__='2026-10-27'`), covering these cases:

1. Missed Monday, go on an off Tuesday: Monday's session appears, carried, trimmed to the time budget.
2. Missed Monday, Wednesday has its own session: the two merge and compounds win.
3. Lifts done on Tuesday are no longer carried on Wednesday.
4. A lift whose muscle was trained yesterday is held back.
5. Legs trained 2 days ago: lower-body lifts wait.
6. All sets at the top of the range adds weight; 12, 12, 5 holds.
7. Add food, edit quantity, remove entry, copy a day, and reload to confirm the data persists.
