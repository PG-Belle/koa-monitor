// KOA Cabin Watch
// KOA has no shareable results URL: you must fill out the Step 1 reservation
// form (dates + party) before it shows availability on Step 2. So this script
// drives that form in a real browser, reaches the Sites step, and decides
// whether any "full bath with shower" cabin is bookable for your dates. On a
// hit it pushes an alert to your phone.
//
// Everything you might tweak is in CONFIG or in the SELECTORS section below.

import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import fs from "node:fs";

chromium.use(stealth());

const CONFIG = {
  // The clean lodging entry page for the campground. No token needed.
  startUrl:
    process.env.START_URL ||
    "https://koa.com/campgrounds/ventura-ranch/site-type/lodging/",

  // Dates exactly as the form shows them: M/D/YYYY, no leading zeros.
  arrival: process.env.ARRIVAL || "5/28/2027",
  departure: process.env.DEPARTURE || "5/31/2027",

  // Party size. Kept small so more cabins qualify. Set to your real group if you
  // only want alerts for cabins big enough for everyone.
  adults: process.env.ADULTS || "2",
  kids: process.env.KIDS || "0",

  // KOA validates these even for cabins. Cabin bookings don't actually use
  // equipment, but the form refuses to submit until they're set. Automobile +
  // No pets is the safe pick.
  equipmentType: process.env.EQUIPMENT_TYPE || "A",
  pets: process.env.PETS || "No",

  // Catches all three types you want (they all contain this phrase):
  // Deluxe Cabin (full bath with shower), Camping Cabin (full bath with shower),
  // Deluxe Cabin (full bath with shower), Patio.
  cabinKeywords: (process.env.CABIN_KEYWORDS || "full bath with shower").split("|"),
  positiveSignals: ["add to cart", "reserve", "book now", "select site", "add to trip", "book online", "select"],
  negativeSignals: ["sold out", "not available", "no availability", "unavailable", "not currently available"],

  // Phone push via ntfy.sh (free, instant, no account). Set NTFY_TOPIC.
  ntfyTopic: process.env.NTFY_TOPIC || "",

  // Optional email via Resend.
  resendApiKey: process.env.RESEND_API_KEY || "",
  alertEmail: process.env.ALERT_EMAIL || "",
  fromEmail: process.env.FROM_EMAIL || "onboarding@resend.dev",

  reAlertHours: Number(process.env.REALERT_HOURS || 6),
  // How long to wait between "monitor is blind" alerts, so a persistent
  // Cloudflare block does not spam your phone.
  blindAlertHours: Number(process.env.BLIND_ALERT_HOURS || 12),
  stateFile: "state.json",
};

// Text that means we hit a Cloudflare bot-check interstitial instead of the
// Sites step. When present, the "available: false" result is meaningless.
const CLOUDFLARE_MARKERS = [
  "performing security verification",
  "just a moment",
  "checking your browser",
  "cloudflare",
  "ray id:",
];

// ---------------------------------------------------------------------------
// SELECTORS  (if the first test run fails, this is the block to adjust)
// The script tries these in order and also falls back to finding inputs by the
// visible label text next to them, so it should survive minor markup changes.
// ---------------------------------------------------------------------------
const SELECTORS = {
  checkinKeywords: ["arrival", "checkin", "check-in", "arrive", "startdate", "start_date"],
  checkoutKeywords: ["departure", "checkout", "check-out", "depart", "enddate", "end_date"],
  checkinLabel: "Check in",
  checkoutLabel: "Check out",
  // Buttons that enter the form from a marketing page (used only if the date
  // fields are not already on the start page).
  entryButtonText: ["check availability", "reserve", "book now", "book online", "get started", "check rates"],
  // Buttons that advance from Step 1 to the Sites step.
  submitButtonText: ["get available sites", "get sites", "check availability", "find sites", "view sites", "continue", "search", "next"],
};
// ---------------------------------------------------------------------------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG.stateFile, "utf8"));
  } catch {
    return { available: false, lastAlert: null, lastBlindAlert: null };
  }
}
function saveState(state) {
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
}

async function sendNtfy(title, body, url) {
  if (!CONFIG.ntfyTopic) return;
  await fetch(`https://ntfy.sh/${CONFIG.ntfyTopic}`, {
    method: "POST",
    headers: {
      Title: title,
      Priority: "urgent",
      Tags: "tent,rotating_light",
      Click: url,
    },
    body,
  }).catch((e) => console.error("ntfy failed:", e.message));
}

async function sendEmail(subject, html) {
  if (!CONFIG.resendApiKey || !CONFIG.alertEmail) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONFIG.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: CONFIG.fromEmail,
      to: CONFIG.alertEmail,
      subject,
      html,
    }),
  }).catch((e) => console.error("resend failed:", e.message));
}

async function findDateInput(page, keywords, labelText) {
  for (const kw of keywords) {
    for (const attr of ["id", "name", "placeholder", "aria-label"]) {
      const loc = page.locator(`input[${attr}*="${kw}" i]`).first();
      if (await loc.count()) return loc;
    }
  }
  // Fall back to the first input after the visible label.
  const byLabel = page
    .locator(`xpath=//*[contains(normalize-space(.),"${labelText}")]/following::input[1]`)
    .first();
  if (await byLabel.count()) return byLabel;
  return null;
}

async function setDate(page, keywords, labelText, value) {
  const input = await findDateInput(page, keywords, labelText);
  if (!input) {
    console.warn(`Could not find date field for "${labelText}"`);
    return false;
  }
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click().catch(() => {});
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Delete").catch(() => {});
  try {
    await input.type(value, { delay: 40 });
  } catch {
    await input.fill(value).catch(() => {});
  }
  // Commit the value. Escape (previously here) cancels a jQuery UI datepicker
  // without applying — Tab blurs the field which commits + fires change.
  await input.press("Tab").catch(() => {});
  // Belt-and-suspenders: force the value + fire input/change/blur so anything
  // listening (jQuery UI, React, plain vanilla) picks up the update.
  await input
    .evaluate((el, val) => {
      if (el.value !== val) el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    }, value)
    .catch(() => {});
  const actual = await input.inputValue().catch(() => "");
  if (actual !== value) {
    console.warn(`Date field "${labelText}" wanted ${value} but reads ${actual}`);
  }
  return actual === value;
}

async function setPartyNumber(page, keywords, labelText, value) {
  const kws = Array.isArray(keywords) ? keywords : [keywords];
  // Prefer a <select> (KOA's Adults / Kids are dropdowns defaulting to 0).
  for (const kw of kws) {
    for (const attr of ["id", "name", "aria-label"]) {
      const sel = page.locator(`select[${attr}*="${kw}" i]`).first();
      if (await sel.count()) {
        try {
          await sel.selectOption(String(value));
          return true;
        } catch (e) {
          console.warn(`selectOption failed on ${attr}*="${kw}":`, e.message);
        }
      }
    }
  }
  // Otherwise fall through to a plain input.
  for (const kw of kws) {
    for (const attr of ["id", "name", "placeholder", "aria-label"]) {
      const inp = page.locator(`input[${attr}*="${kw}" i]`).first();
      if (await inp.count()) {
        await inp.fill(String(value)).catch(() => {});
        return true;
      }
    }
  }
  // Last resort: find by visible label.
  try {
    const byLabel = page
      .locator(`xpath=//*[contains(normalize-space(.),"${labelText}")]/following::*[self::input or self::select][1]`)
      .first();
    if (await byLabel.count()) {
      const tag = await byLabel.evaluate((el) => el.tagName.toLowerCase());
      if (tag === "select") await byLabel.selectOption(String(value)).catch(() => {});
      else await byLabel.fill(String(value)).catch(() => {});
      return true;
    }
  } catch (e) {
    console.warn(`Party field "${labelText}" not set:`, e.message);
  }
  return false;
}

async function clickByText(page, texts) {
  for (const t of texts) {
    const btn = page
      .locator(`xpath=//button[contains(translate(normalize-space(.),"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"${t}")] | //a[contains(translate(normalize-space(.),"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"${t}")] | //input[@type="submit" and contains(translate(@value,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"${t}")]`)
      .first();
    if (await btn.count()) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click().catch(() => {});
      return t;
    }
  }
  return null;
}

async function dateFieldPresent(page) {
  const loc = await findDateInput(page, SELECTORS.checkinKeywords, SELECTORS.checkinLabel);
  return !!loc;
}

function decideAvailability(text) {
  const lower = text.toLowerCase();
  const mentioned = CONFIG.cabinKeywords.some((k) => lower.includes(k.toLowerCase()));
  if (!mentioned) {
    return {
      available: false,
      reason: "No full-bath-with-shower cabin appeared on the Sites step (likely still sold out, or the form did not submit).",
    };
  }
  for (const kw of CONFIG.cabinKeywords) {
    let idx = lower.indexOf(kw.toLowerCase());
    while (idx !== -1) {
      const window = lower.slice(idx, idx + 900);
      const soldOut = CONFIG.negativeSignals.some((s) => window.includes(s));
      const bookable = CONFIG.positiveSignals.some((s) => window.includes(s));
      const hasPrice = /\$\s?\d/.test(window);
      if (!soldOut && (bookable || hasPrice)) {
        return { available: true, reason: `Bookable signal near "${kw}".` };
      }
      idx = lower.indexOf(kw.toLowerCase(), idx + 1);
    }
  }
  return {
    available: false,
    reason: "Cabin type listed but every one reads as sold out for these dates.",
  };
}

async function run() {
  const browser = await chromium.launch({
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 950 },
    locale: "en-US",
  });
  const page = await context.newPage();

  console.log("Opening:", CONFIG.startUrl);
  await page.goto(CONFIG.startUrl, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(4000);

  // If the date fields are not on this page, click an entry button to reach them.
  if (!(await dateFieldPresent(page))) {
    const clicked = await clickByText(page, SELECTORS.entryButtonText);
    console.log("Entry button clicked:", clicked);
    await page.waitForTimeout(5000);
  }

  await page.screenshot({ path: "last-run-step1.png", fullPage: true });
  fs.writeFileSync("last-run-step1.html", await page.content());

  // Fill the Step 1 form.
  const okIn = await setDate(page, SELECTORS.checkinKeywords, SELECTORS.checkinLabel, CONFIG.arrival);
  const okOut = await setDate(page, SELECTORS.checkoutKeywords, SELECTORS.checkoutLabel, CONFIG.departure);
  await setPartyNumber(page, ["adults"], "Adults", CONFIG.adults);
  await setPartyNumber(page, ["kids"], "Kids", CONFIG.kids);
  await setPartyNumber(page, ["equipmenttype", "equipment"], "Equipment", CONFIG.equipmentType);
  await setPartyNumber(page, ["pets"], "Pets", CONFIG.pets);
  console.log("Dates set:", { arrival: okIn, departure: okOut });

  // Advance to the Sites step.
  const submitted = await clickByText(page, SELECTORS.submitButtonText);
  console.log("Submit button clicked:", submitted);

  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(7000);

  // If we hit a Cloudflare interstitial, give it a chance to auto-clear
  // (stealth defeats the easy challenges within a few seconds).
  let text = await page.evaluate(() => document.body.innerText);
  if (isBlocked(text)) {
    console.log("Cloudflare interstitial detected, waiting for it to clear...");
    await page
      .waitForFunction(
        (markers) => {
          const t = (document.body.innerText || "").toLowerCase();
          return !markers.some((m) => t.includes(m));
        },
        CLOUDFLARE_MARKERS,
        { timeout: 45000 }
      )
      .catch(() => {});
    await page.waitForTimeout(3000);
    text = await page.evaluate(() => document.body.innerText);
  }

  fs.writeFileSync("last-run-step2.txt", text);
  fs.writeFileSync("last-run-step2.html", await page.content());
  await page.screenshot({ path: "last-run-step2.png", fullPage: true });

  const prev = loadState();
  const now = new Date();
  const bookUrl = CONFIG.startUrl;

  // Still blocked? Send a rate-limited "monitor is blind" alert so you know
  // to move the checker to a residential IP, then exit without touching the
  // availability flag.
  if (isBlocked(text)) {
    console.log("Result: BLOCKED by Cloudflare");
    const stale =
      !prev.lastBlindAlert ||
      now - new Date(prev.lastBlindAlert) > CONFIG.blindAlertHours * 3600 * 1000;
    if (stale) {
      const title = "KOA monitor is BLIND (Cloudflare block)";
      const body =
        "The GitHub Actions runner is being served Cloudflare's bot-check page, " +
        "so I can't see real cabin availability. Move the checker to your own machine.";
      console.log("ALERTING (blind)");
      await sendNtfy(title, body, bookUrl);
      saveState({ ...prev, lastBlindAlert: now.toISOString() });
    } else {
      saveState({ ...prev });
    }
    await browser.close();
    return;
  }

  const result = decideAvailability(text);
  console.log("Result:", result);

  let shouldAlert = false;
  if (result.available) {
    const transitioned = !prev.available;
    const stale =
      prev.lastAlert && now - new Date(prev.lastAlert) > CONFIG.reAlertHours * 3600 * 1000;
    if (transitioned || !prev.lastAlert || stale) shouldAlert = true;
  }

  if (shouldAlert) {
    const title = "KOA cabin OPEN: Ventura Ranch 5/28-5/31/27";
    const body = `A cabin with a full bath + shower looks bookable. Grab it now. ${bookUrl}`;
    console.log("ALERTING");
    await sendNtfy(title, body, bookUrl);
    await sendEmail(
      title,
      `<p>A cabin with a full bath and shower at Ventura Ranch looks bookable for 5/28-5/31/2027.</p>
       <p><a href="${bookUrl}">Open the booking page and grab it fast.</a></p>
       <p style="color:#888">${result.reason}</p>`
    );
    saveState({ ...prev, available: true, lastAlert: now.toISOString() });
  } else {
    saveState({
      ...prev,
      available: result.available,
      lastAlert: result.available ? prev.lastAlert : null,
    });
  }

  await browser.close();
}

function isBlocked(text) {
  const lower = (text || "").toLowerCase();
  return CLOUDFLARE_MARKERS.some((m) => lower.includes(m));
}

run().catch((e) => {
  console.error("Run error:", e);
  process.exit(1);
});
