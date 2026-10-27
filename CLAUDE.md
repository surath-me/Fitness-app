# Coach: personal training and food tracker

A single-file web app for one person (Surath). It tracks meals and macros, lift weights, and plans each day's workout, carrying missed sessions forward. It is hosted as a static site on Vercel from this repo. There is no backend, no build step and no framework.

## Files

- `index.html`: the whole app (HTML, CSS, JavaScript). Vercel serves it from the repo root.
- `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png`, `favicon-32.png`: the app icon (blue gradient, glass dumbbell). Must sit next to `index.html`.
- `manifest.webmanifest`: name, standalone display, icons.
- `CLAUDE.md`: this file.

## How to work on it

- Edit `index.html` directly. Keep it one file, vanilla JavaScript, no dependencies, no CDN links, no web fonts.
- Deploy by pushing to `main`. Vercel redeploys on its own. No build command, no framework preset.
- Most requests are small edits to the config block at the top of the script (foods, lifts, sessions, targets). Do those first and leave everything else alone.
- After a change, open the page and check each tab (Train, Eat, Progress, Setup) for console errors.
- Keep the version in `APP_VERSION` up to date when behaviour changes.

## Design rules

- **Light mode only.** Do not add a dark theme unless asked.
- **Native iOS 26 feel (Liquid Glass).** The `.glass` class is the material: translucent gradient, backdrop blur and saturation, a specular highlight (`::before`) and a light edge (`::after`). Used on the floating tab bar, week strip, rest timer, toast and sheets.
- Native patterns already in place: large titles that hand over to a compact blurred nav bar on scroll, a week strip for picking days, inset grouped cards, capsule segmented controls and switches, a floating sheet that can be dragged down to dismiss, swipe left to delete with Undo, tap-to-complete sets, a rest timer pill with a chime, banner toasts from the top.
- **Motion:** spring easing (`--spring`) for physical things (tab indicator, switches, presses, timer, toasts), ease-out (`--out`) for content (rings, bars, sheets, expanding lifts). Page changes use the View Transitions API with a slide direction, with a CSS fallback. Every animation must respect `prefers-reduced-motion`, which also switches the code to synchronous paths.
- Apple's SF Symbols and font files are not bundled (licence). The iPhone renders the system font as SF Pro automatically. Icons are hand-drawn SVGs in the SF style.
- **Accent colour is blue** (`--accent: #007AFF`). Use it for things you can tap and for selection. Change it in one place, the `:root` block.
- **Macro colours are data only**: protein indigo, fat yellow, carbs green, kcal near-black. Do not use them for buttons.
- Mobile first, one column, max width 560px. Tap targets at least 44px.
- Copy: plain, sentence case, active voice. **No em dashes anywhere**, in the UI or in replies to the user.
- Respect `prefers-reduced-motion`. Keep focus outlines visible.

## Code layout inside `index.html`

1. CSS in `<style>`.
2. **CONFIG**: `DEFAULT_TARGETS`, `DEFAULT_CAPS`, `EX` (lifts), `TEMPLATES` (sessions), `DEFAULT_SCHEDULE`, `FOODS`, `QUICK`, `SLOTS`, and the starting data (`SEED_SETS`, `SEED_WAIST`, `SEED_DAYS`).
3. **CORE**: helpers, storage, `liftHistory`, `suggest` (progression), `computeOwed` and `buildPlan` (planner), macro maths, `suggestGap`.
4. **Views**: `viewTrain`, `viewEat`, `viewProgress`, `viewSetup`.
5. **Sheets, timer, render, gestures and events**: `drawSheet`, `toast`, the rest timer (`startRest`), `render` and `afterRender` (tab indicator, nav bar, number tween), the `H` handler object, pointer gestures (swipe rows, sheet drag) and delegated click, input, change and keydown listeners.

Rendering is plain template strings. Views re-render with `render()`. Logging is the exception: set inputs save on `input` and only refresh the lift header and the session card, and opening a lift or checking a set only replaces that lift (`refreshEx`), so focus and scroll are kept. `ui.anim` is set before renders that should replay the rings and bars (tab or day change).

Do not name top-level functions or variables after browser globals (`history`, `name`, `top`, `status`, `event`, `close`). A function called `history` once broke the whole app.

## Data and storage

- Everything lives in `localStorage` under the key `coach-v1`, as one JSON object `S`. It never leaves the device. Setup has Export and Import for backups.
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
- **Time budget:** 45, 60, 75 (default) or 90 minutes. About 11 minutes per compound, 8 per isolation, 6 for abs. Compounds are kept first, then lower `prio`, then older owed. What does not fit stays owed.
- Past days show only what was logged. Future days show only the schedule.
- Buttons: skip today's session, drop carried exercises, train a different session, add an exercise by hand.

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
- **Change the accent colour:** edit `--accent`, `--accent-t` and `--accent-press` in `:root`.

## Testing notes

There is no test suite in the repo. In automated tests, stub `matchMedia` to report reduced motion so sheets and toggles run synchronously. When changing the planner or progression, check by hand with `window.__TODAY__` set before load (for example `window.__TODAY__='2026-10-27'`), covering these cases:

1. Missed Monday, go on an off Tuesday: Monday's session appears, carried, trimmed to the time budget.
2. Missed Monday, Wednesday has its own session: the two merge and compounds win.
3. Lifts done on Tuesday are no longer carried on Wednesday.
4. A lift whose muscle was trained yesterday is held back.
5. Legs trained 2 days ago: lower-body lifts wait.
6. All sets at the top of the range adds weight; 12, 12, 5 holds.
7. Add food, edit quantity, remove entry, copy a day, and reload to confirm the data persists.
