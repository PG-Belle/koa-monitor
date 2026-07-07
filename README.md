# KOA Cabin Watch

Watches Ventura Ranch KOA for any **cabin with a full bath and shower** (Deluxe
Cabin, Camping Cabin with full bath, or the patio variant) opening up for
**5/28/27 to 5/31/27**, and pushes an instant alert to your phone when one does.
Runs free on GitHub Actions every 15 minutes. No server, no waiting list, no
manually refreshing.

## How it works

KOA has no shareable results URL: you have to fill out the Step 1 reservation form
(dates and party size) before it will show availability on the Sites step. So a
real headless browser (Playwright) opens the lodging page, fills that form in for
your dates, clicks through to the Sites step, and reads what is bookable. On a hit
it fires a push notification. It only alerts on a fresh opening (not every run), so
you will not get spammed.

## One-time setup (about 10 minutes)

### 1. Put these files in a new GitHub repo
Create an empty repo (private is fine) and push everything in this folder to it.

### 2. Set up phone push with ntfy (free, instant, no account)
1. Install the **ntfy** app (iOS or Android).
2. In the app, subscribe to a topic name only you know, e.g. `belle-koa-ventura-9f3k2`.
   Pick something random so no one else guesses it.
3. That topic name is your `NTFY_TOPIC` secret below.

### 3. Add repo secrets
In the repo: **Settings > Secrets and variables > Actions > New repository secret**.

Required:
- `NTFY_TOPIC` = the topic from step 2

The dates and party size already default to your trip inside `check.mjs`, so you
do not have to set anything else. Only add these if you want to change them without
editing code:
- `ARRIVAL` = `5/28/2027`  (format M/D/YYYY, no leading zeros)
- `DEPARTURE` = `5/31/2027`
- `ADULTS` = `2`
- `KIDS` = `0`
- `START_URL` = the campground lodging page (defaults to Ventura Ranch already)

Optional email backup (you already use Resend):
- `RESEND_API_KEY` = your Resend key
- `ALERT_EMAIL` = where to email you
- `FROM_EMAIL` = a verified Resend sender (or leave unset to use Resend's test sender)

### 4. Turn it on
Go to the **Actions** tab, enable workflows if prompted, open **KOA Cabin Watch**,
and click **Run workflow** to test it immediately. After that it runs itself every
15 minutes.

## Verify the first run (do this once)

Filling a form blind is the one fragile part, so confirm it worked. After the first
run, open that run in the Actions tab and download the `last-run` artifact:
- `last-run-step1.png` what the form looked like after the script filled it. The
  check-in / check-out boxes should read 5/28/2027 and 5/31/2027.
- `last-run-step2.png` the Sites step. This should show the cabin listings (your
  full-bath cabins marked sold out for now).
- `last-run-step1.html` / `last-run-step2.html` the raw page, handy if a selector
  needs adjusting.

If step1 shows the dates filled and step2 shows the cabin list, you are done: it
will flip to an alert the moment a full-bath cabin becomes bookable.

If step1 shows the dates blank or step2 never reached the cabin list, the form
selectors need a small tweak. Hand the two HTML files plus `check.mjs` to Claude
Code and ask it to fix the date-field and submit-button selectors in the
`SELECTORS` block near the top; the saved HTML tells it exactly what to target.

## Tuning

Top of `check.mjs`:
- `cabinKeywords` matches the phrase `full bath with shower`, covering all three
  types you want (Deluxe, Camping with full bath, and the Patio variant).
- `positiveSignals` / `negativeSignals` words that mean bookable vs sold out.
- `arrival` / `departure` / `adults` / `kids` the search itself.
- `reAlertHours` how long before it reminds you again while a cabin stays open
  (default 6h).

The checker leans toward alerting: if unsure, it pings you so you never miss a real
opening. Worst case is an occasional heads-up that is already gone by the time you
click, which is a fair trade.

## If KOA ever blocks the GitHub runners

KOA has bot detection. Playwright with a real browser usually gets through, but if
runs start returning a block page (visible in `last-run-step1.png`), run the same
script on your own always-on machine. Install Node, run
`npm install && npx playwright install chromium`, set the same env vars, and
schedule `node check.mjs` with cron every 15 minutes. A home or office IP is far
less likely to be blocked than a datacenter one.

## Cost

Free. Public repos get unlimited Actions minutes; private repos get 2,000 free
minutes/month and this uses well under that at a 15-minute cadence.
