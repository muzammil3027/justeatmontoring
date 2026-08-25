# Just Eat rider — bike opening monitor

Pisa, Livorno aur Viareggio ka Just Eat courier form har 15 min check karta hai.
Scooter / car ko ignore karta hai. Koi bhi doosra vehicle (Own Bike, Own Bicycle,
Own E-Bike, Walker, ...) list mein aate hi **Telegram par notification** aa jati hai.

Form kabhi submit nahi hota — script Step 4 (Vehicle) tak jaati hai, options
padhti hai, aur browser band kar deti hai. Koi application create nahi hoti.

---

## 1. Telegram bot banao (2 min)

1. Telegram par **@BotFather** kholo → `/newbot` → naam do
2. Jo token milega copy karo → `TELEGRAM_TOKEN`
3. Apne naye bot ko kholo aur usay **`/start`** bhejo (ye zaruri hai, warna bot
   tumhe message nahi bhej sakta)
4. Telegram par **@userinfobot** kholo → `/start` → jo `Id` number milega wo
   `TELEGRAM_CHAT_ID` hai

## 2. Local test (pehle yahi karo)

```bash
npm install
npx playwright install chromium

# Windows PowerShell
$env:TELEGRAM_TOKEN="123456:ABC..."; $env:TELEGRAM_CHAT_ID="12345678"
npm run debug
```

`npm run debug` browser **visible** kholta hai aur har step ka screenshot
`debug/` folder mein save karta hai. Terminal mein ye line dekho:

```
[Pisa] options: Own Scooter
[Pisa] interesting: (none)
```

- Agar `options` sahi aa rahe hain → sab theek hai, step 3 par jao.
- Agar `stuck at hop N` aaya → neeche "Agar phans jaye" padho.

Test karne ke liye `CITIES=Trieste` set karke chalao — wahan `Own E-Bike`
detect hona chahiye aur ek Telegram message aana chahiye.

## 3. GitHub par deploy

1. **Public** repo banao aur ye teen files push karo
   (public isliye ke public repos par Actions minutes unlimited hain —
   private repo ka 2000 min/month quota 15-min cron se 3 din mein khatam ho jayega)
2. Repo → Settings → Secrets and variables → Actions → **New repository secret**
   - `TELEGRAM_TOKEN`
   - `TELEGRAM_CHAT_ID`
3. Actions tab → workflow select karo → **Run workflow** (manual test)
4. Ho gaya. Ab har 15 min khud chalega.

---

## Cities badalne ke liye

`.github/workflows/monitor.yml` mein:

```yaml
CITIES: Pisa,Livorno,Viareggio,Lucca
```

Naam wahi likhna jo URL mein chalta hai: `justeat.it/en/courier/form?city=Pisa`

## Ignore list badalne ke liye

`check.mjs` ke top par `IGNORED` regex hai. Abhi scooter aur car ignore hote hain.
Agar e-bike bhi nahi chahiye to usme `|e-bike` add kar do.

---

## Agar phans jaye (`stuck at hop N`)

Matlab Step 2 ya 3 ka koi field auto-fill nahi ho paya (custom dropdown /
date picker / radio card). `debug/` folder ke screenshot se dikh jayega kahan
ruka. Fix karne ka fastest tareeqa:

```bash
npm run codegen
```

Browser khulega — tum manually Step 1→4 bharo, Playwright exact selectors ke
saath code khud generate kar dega. Wo generated code `fillStep()` ki jagah
paste kar do (ya us specific step ke liye ek special case add kar do).

## Notes

- GitHub free-tier cron 5–20 min late ho sakta hai. Time-critical lage to
  interval `*/10` kar do, ya Railway/Fly.io par node-cron se chala do.
- Agar repo 60 din tak inactive rahe to GitHub scheduled workflows disable kar
  deta hai — mahine mein ek dummy commit kar dena.
- `state.json` khud commit hoti rehti hai — isi se pata chalta hai kya "naya" hai,
  taake ek hi opening par baar baar notification na aaye.
