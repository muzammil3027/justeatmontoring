import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const CITIES = (process.env.CITIES || 'Pisa,Livorno')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Vehicles we DO NOT care about. Anything else that appears = alert.
const IGNORED = /(scooter|moped|motorbike|motorcycle|motorino|^.*\bcar\b.*$|auto|macchina)/i;

// The question we are here to read — never auto-answer it.
const VEHICLE_QUESTION = /choose the vehicle|which vehicle|scegli il veicolo|veicolo/i;

// Words that make a line look like a vehicle label at all.
const VEHICLE_WORDS = /(bike|bicycle|bici|scooter|moped|motorbike|car|auto|macchina|foot|walk|piedi)/i;

const STATE_FILE = process.env.STATE_FILE || 'state.json';
const DEBUG = process.argv.includes('--debug');
const HEADED = process.argv.includes('--headed');

const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

// Dummy data for steps 1-3. Nothing is ever submitted: the script stops at
// step 4 (Vehicle) and closes the browser. No application is created.
const DUMMY = {
  first: 'Marco',
  last: 'Bianchi',
  email: 'noreply.monitor@example.com',
  phone: '3331234567',
  postcode: '56100',
  date: '1995-05-15',
  generic: 'Test',
};

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

async function telegram(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    log('!! TELEGRAM_TOKEN / TELEGRAM_CHAT_ID missing — printing instead:\n' + text);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
  });
  if (!res.ok) log('!! telegram failed:', res.status, await res.text());
}

async function shot(page, name) {
  if (!DEBUG) return;
  fs.mkdirSync('debug', { recursive: true });
  await page.screenshot({ path: path.join('debug', `${name}.png`), fullPage: true }).catch(() => {});
}

async function dismissCookies(page) {
  const patterns = [
    /accept all/i, /accept/i, /agree/i,
    /accetta tutti/i, /accetta/i, /ho capito/i,
  ];
  for (const p of patterns) {
    const btn = page.getByRole('button', { name: p }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await sleep(500);
      return;
    }
  }
}

// Step 1 is normally pre-filled from the ?city= URL param and skipped. If it is
// still showing, the city was not recognised — say so instead of walking the
// form eight times and reporting a vague failure.
async function ensureCity(page, city) {
  const sel = page.locator('select').first();
  if (!(await sel.isVisible().catch(() => false))) return null; // step already passed

  const options = await sel
    .locator('option')
    .evaluateAll((os) => os.map((o) => ({ value: o.value, text: (o.textContent || '').trim() })))
    .catch(() => []);

  const cities = options.filter((o) => o.value);
  const match = cities.find((o) => o.text.toLowerCase() === city.toLowerCase());

  if (!match) {
    return `"${city}" is not one of the ${cities.length} cities Just Eat operates in`;
  }

  await sel.selectOption(match.value).catch(() => {});
  await sleep(800);
  return null;
}

// Are we on the "Choose the vehicle" step?
async function onVehicleStep(page) {
  const heading = page.getByText(/choose the vehicle|which vehicle|scegli il veicolo/i).first();
  return await heading.isVisible().catch(() => false);
}

// The form renders radio groups as a hidden <input type="radio"> wrapped in a
// <label> next to a styled <div class="radio__box">. The input itself is never
// "visible" to Playwright, so we answer the group by clicking its <label>.
async function answerRadioGroups(page) {
  const groups = await page
    .evaluate(() => {
      const byName = {};
      for (const r of document.querySelectorAll('input[type="radio"]')) {
        if (!r.name) continue;
        const g = (byName[r.name] ||= { name: r.name, legend: '', values: [], answered: false });
        if (!g.legend) {
          const fs = r.closest('fieldset');
          g.legend = ((fs && fs.querySelector('legend')?.textContent) || '').trim();
        }
        const label = r.closest('label');
        g.values.push(((r.value || '') + ' ' + ((label && label.textContent) || '')).trim());
        if (r.checked) g.answered = true;
      }
      return Object.values(byName);
    })
    .catch(() => []);

  let answered = 0;

  for (const g of groups) {
    if (g.answered) continue;
    if (VEHICLE_QUESTION.test(g.legend)) continue; // this is what we came to read

    // "Do you have a referral code / promo code?" -> No. Anything else
    // (age, right to work, ...) -> Yes, since that is what keeps the form open.
    const wantNo = /referr|referen|promo|code|codice|invit/i.test(g.legend);
    const prefer = wantNo ? /\bno\b/i : /\b(yes|s[iì])\b/i;

    let idx = g.values.findIndex((v) => prefer.test(v));
    if (idx < 0) idx = 0; // no match: take the first option so the step validates

    const radio = page.locator(`input[type="radio"][name="${g.name.replace(/"/g, '\\"')}"]`).nth(idx);
    const label = radio.locator('xpath=ancestor::label[1]');

    if (await label.isVisible().catch(() => false)) {
      await label.click({ timeout: 2000 }).catch(() => {});
    } else {
      // Fallback: click the hidden input directly via the DOM.
      await radio.evaluate((el) => el.click()).catch(() => {});
    }
    await sleep(400);
    answered++;

    if (DEBUG) log(`   answered "${g.legend || g.name}" -> ${g.values[idx]}`);
  }

  return answered;
}

// Any inline validation messages currently on screen.
async function validationErrors(page) {
  return await page
    .evaluate(() =>
      [...document.querySelectorAll('[class*="error" i], [class*="invalid" i], [role="alert"]')]
        .map((e) => (e.textContent || '').trim().replace(/\s+/g, ' '))
        .filter((t) => t && t.length <= 120)
    )
    .catch(() => []);
}

// Answering one question often reveals the next one on the same step, so keep
// filling until a pass has nothing left to answer.
async function fillStep(page) {
  for (let pass = 0; pass < 5; pass++) {
    const answered = await fillStepOnce(page);
    if (!answered) break;
    await sleep(1200);
  }
}

// Fill every visible, empty, editable field on the current step with dummy data.
async function fillStepOnce(page) {
  const inputs = await page.locator('input:not([type="hidden"]), textarea').all();

  for (const el of inputs) {
    if (!(await el.isVisible().catch(() => false))) continue;
    if (!(await el.isEditable().catch(() => false))) continue;

    const type = ((await el.getAttribute('type').catch(() => '')) || 'text').toLowerCase();

    // Radios are handled by answerRadioGroups(): the real <input> is hidden
    // behind a styled box, so it never passes the isVisible() guard above.
    if (type === 'radio') continue;

    if (type === 'checkbox') {
      await el.check({ timeout: 2000 }).catch(() => {});
      continue;
    }

    const current = await el.inputValue().catch(() => '');
    if (current) continue;

    const meta = [
      await el.getAttribute('name').catch(() => ''),
      await el.getAttribute('id').catch(() => ''),
      await el.getAttribute('placeholder').catch(() => ''),
      await el.getAttribute('aria-label').catch(() => ''),
    ]
      .join(' ')
      .toLowerCase();

    let value = DUMMY.generic;
    if (type === 'email' || /mail/.test(meta)) value = DUMMY.email;
    else if (type === 'tel' || /phone|tel|mobile|cell/.test(meta)) value = DUMMY.phone;
    else if (type === 'date' || /birth|dob|nascita/.test(meta)) value = DUMMY.date;
    else if (/zip|postcode|postal|cap/.test(meta)) value = DUMMY.postcode;
    else if (/first|given|nome/.test(meta)) value = DUMMY.first;
    else if (/last|surname|family|cognome/.test(meta)) value = DUMMY.last;
    else if (type === 'number') value = '1';

    await el.fill(value, { timeout: 2000 }).catch(() => {});
  }

  // Native <select> dropdowns: pick the first real option.
  for (const sel of await page.locator('select').all()) {
    if (!(await sel.isVisible().catch(() => false))) continue;

    // Never guess at the city picker — picking "the first option" there would
    // silently monitor a different city than the one we were asked about.
    const context = await sel
      .evaluate((el) => ((el.closest('fieldset') || el.parentElement)?.textContent || '').trim())
      .catch(() => '');
    if (/city|citt[àa]|location/i.test(context)) continue;

    const options = await sel.locator('option').all();
    for (const opt of options) {
      const v = await opt.getAttribute('value').catch(() => '');
      if (v) {
        await sel.selectOption(v).catch(() => {});
        break;
      }
    }
  }

  return await answerRadioGroups(page);
}

async function clickProceed(page) {
  const btn = page
    .getByRole('button', { name: /proceed|continue|next|submit answers|avanti|prosegui|continua/i })
    .first();

  if (!(await btn.isVisible().catch(() => false))) return false;

  // The button stays disabled while the step re-renders after an answer.
  for (let i = 0; i < 8; i++) {
    if (await btn.isEnabled().catch(() => false)) break;
    await sleep(500);
  }
  if (!(await btn.isEnabled().catch(() => false))) return false;

  await btn.click().catch(() => {});
  return true;
}

// Pull the vehicle option labels off the vehicle step.
async function extractVehicles(page) {
  const found = new Set();

  // Preferred: read the options straight off the vehicle radio group.
  const fromGroup = await page
    .evaluate((src) => {
      const re = new RegExp(src, 'i');
      for (const fs of document.querySelectorAll('fieldset')) {
        const legend = (fs.querySelector('legend')?.textContent || '').trim();
        if (!re.test(legend)) continue;
        return [...fs.querySelectorAll('label')]
          .map((l) => (l.textContent || '').trim().replace(/\s+/g, ' '))
          .filter(Boolean);
      }
      return [];
    }, VEHICLE_QUESTION.source)
    .catch(() => []);

  for (const v of fromGroup) found.add(v);
  if (found.size) return [...found].sort();

  const cards = page.locator(
    'button, label, [role="radio"], [role="button"], [class*="card" i], [class*="option" i], [class*="tile" i]'
  );
  const n = Math.min(await cards.count(), 300);

  for (let i = 0; i < n; i++) {
    const el = cards.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const raw = (await el.innerText().catch(() => '')) || '';
    const t = raw.trim().replace(/\s+/g, ' ');
    if (!t || t.length > 40) continue;
    if (VEHICLE_WORDS.test(t)) found.add(t);
  }

  // Fallback: scan visible body text line by line.
  if (found.size === 0) {
    const body = (await page.innerText('body').catch(() => '')) || '';
    for (const line of body.split('\n')) {
      const t = line.trim().replace(/\s+/g, ' ');
      if (!t || t.length > 40) continue;
      if (VEHICLE_WORDS.test(t)) found.add(t);
    }
  }

  return [...found].sort();
}

// ---------------------------------------------------------------------------
// PER-CITY CHECK
// ---------------------------------------------------------------------------

async function checkCity(browser, city) {
  const ctx = await browser.newContext({
    locale: 'en-GB',
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  try {
    const url = `https://justeat.it/en/courier/form?city=${encodeURIComponent(city)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await dismissCookies(page);

    const cityError = await ensureCity(page, city);
    if (cityError) {
      await shot(page, `${city}-BADCITY`);
      return { city, error: cityError };
    }

    // Walk forward until we land on the vehicle step (max 8 hops).
    let reached = false;
    for (let step = 1; step <= 8; step++) {
      if (await onVehicleStep(page)) {
        reached = true;
        break;
      }
      await shot(page, `${city}-step${step}`);
      await fillStep(page);

      // Filling can reveal the vehicle question on the very same step.
      if (await onVehicleStep(page)) {
        reached = true;
        break;
      }

      const moved = await clickProceed(page);
      if (!moved) {
        log(`   [${city}] stuck at hop ${step} — no enabled Proceed button`);
        break;
      }
      await sleep(2500);
    }

    if (!reached) {
      await shot(page, `${city}-STUCK`);
      const errs = await validationErrors(page);
      const why = errs.length ? ` (form says: ${[...new Set(errs)].join(' / ')})` : '';
      return { city, error: `could not reach vehicle step${why}` };
    }

    await sleep(1000);
    await shot(page, `${city}-vehicle`);

    const all = await extractVehicles(page);
    const interesting = all.filter((v) => !IGNORED.test(v));

    return { city, all, interesting, url };
  } catch (err) {
    await shot(page, `${city}-ERROR`);
    return { city, error: String(err).slice(0, 200) };
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  const state = loadState();
  const browser = await chromium.launch({ headless: !HEADED });
  const alerts = [];

  for (const city of CITIES) {
    log(`checking ${city} ...`);
    const r = await checkCity(browser, city);

    if (r.error) {
      log(`   [${city}] ERROR: ${r.error}`);
      state[city] = { ...(state[city] || {}), lastError: r.error, lastRun: new Date().toISOString() };
      continue;
    }

    log(`   [${city}] options: ${r.all.join(' | ') || '(none)'}`);
    log(`   [${city}] interesting: ${r.interesting.join(' | ') || '(none)'}`);

    const previous = (state[city] && state[city].interesting) || [];
    const fresh = r.interesting.filter((v) => !previous.includes(v));

    if (fresh.length) {
      alerts.push(
        `🚴 <b>${r.city}</b> — new option available:\n` +
          fresh.map((v) => `   • <b>${v}</b>`).join('\n') +
          `\n\n<a href="${r.url}">Apply now →</a>`
      );
    }

    state[city] = {
      all: r.all,
      interesting: r.interesting,
      lastRun: new Date().toISOString(),
      lastError: null,
    };
  }

  await browser.close();

  if (alerts.length) {
    await telegram('<b>Just Eat rider — opening detected</b>\n\n' + alerts.join('\n\n'));
    log(`>> sent ${alerts.length} alert(s)`);
  } else {
    log('>> nothing new');
  }

  saveState(state);
}

main().catch(async (e) => {
  console.error(e);
  await telegram(`⚠️ Just Eat monitor crashed:\n<code>${String(e).slice(0, 300)}</code>`);
  process.exit(1);
});
