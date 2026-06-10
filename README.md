# 🎰 JOHN'S SLOTS

A full-stack online casino-style web platform: user accounts, live admin-run lucky-draw wheel, a once-a-day personal spin, announcements, giveaways, and a game-downloads page. Neon-luxe design, real backend, real-time sync.

> ⚠️ **Read the "Important / Legal" section at the bottom before putting this online.** Balances and prizes are **virtual credits** — there is no real money or payment processing in this app.

---

## 🆕 What's new in this version

- **Email at signup** — optional email field, validated, shown to admin in the Users panel.
- **Auto-logout on tab close** — the login token now lives in sessionStorage by default, so closing the tab logs you out. Tick **"Keep me signed in on this device"** at login/signup to stay logged in.
- **Save password** — login/signup are now real forms, so the browser offers to save your credentials.
- **Feedbacks** — players send feedback from the Feed page; **only admins** can read them (Admin → 💬 Feedbacks).
- **Agent reports (Famous / Hulk / Travis)** — assign accounts to agents in Admin → Users. Agents get a **Reports** tab to submit daily cash in / cash out. Admin → 📊 Reports shows per-day totals (e.g. *JUNE 12 — TOTAL CASHIN / TOTAL CASHOUT / TOTAL PROFIT*) plus a month-to-date sum, and lets the admin enter or fix numbers for any agent/date.
- **Game Vault** — every player gets a private notepad to store game credentials (game, username, password, notes) with show/hide + copy.
- **Posts & 24h Stories** — admin publishes posts (caption + image) and Facebook-style stories that auto-expire after 24 hours (Admin → 📸 Posts & Stories). Players see them on the **Feed** page; tap a story bubble to view it. Images persist in `DATA_DIR/uploads`.
- **VIP badge** — admin grants/removes 💎 VIP per user (Admin → Users); the badge shows next to the username.
- **Deposit Bonus Wheel** — 10/12/15/17/20/22/25/30 %, one spin per day per player. The winner is told to claim it with an agent and the spin instantly appears in Admin → 🎡 Bonus Claims for the agent to mark claimed.
- **Cashout Rules** — shown in the Wallet: Min deposit $5 → cashout min/max **$50** · Deposit $10+ → cashout min **2.5×**, max **15×**.
- **Facebook links** — Admin → ⚙️ Settings holds Main Facebook page Link 1 & 2; buttons appear on everyone's Feed page once filled in.

---

## What's inside (your 6 requirements → features)

| # | You asked for | Where it lives |
|---|---------------|----------------|
| 1 | User login / signup | Auth screen on load. Passwords are hashed (bcrypt), sessions use signed tokens. |
| 2 | Announcement page | **News** tab. Admin posts/deletes; everyone sees updates live. |
| 3 | Giveaway announcement page | **Giveaways** tab. Title, prize, description, optional end date. |
| 4 | Daily lucky-draw wheel (admin adds ≤10 users, spins at a set time, everyone watches the **same** live spin + winner) | **Lucky Draw** tab. Admin sets participants + daily time in **Admin → Lucky Draw**. The server runs the draw and pushes the identical animation + winner to every connected browser in real time (Socket.IO). Admin can also hit **Spin now** to trigger it manually. |
| 5 | Hourly personal spin, $0.10–$3.00 in small amounts, added to balance, once/hour | **Home** tab → the slot reel + **SPIN** button. Server enforces one spin per user per hour and credits the win to their balance. Prize tiers: 0.10 / 0.20 / 0.30 / 0.50 / 0.75 / 1.00 / 1.50 / 2.00 / 3.00 (small wins are far more common). |
| 6 | Page with 10 game download links (admin fills later) | **Games** tab — 10 slots ready. Admin pastes label + URL in **Admin → Downloads**; empty ones show "coming soon". |

Plus a bonus **Admin → Users** panel to view every account and manually add/remove balance.

---

## 🆕 Latest updates (this round of changes)

| # | Change | Where it lives |
|---|--------|----------------|
| 1 | **Mobile / app view** — the site is now fully responsive and behaves like an app inside a phone webview. On phones the top tabs collapse into a fixed **bottom navigation bar**, inputs no longer zoom on focus, and it's installable to the home screen (PWA manifest + icons). | Everything; bottom bar appears at ≤720px. |
| 2 | **`john@` usernames** — new signups are stored and shown as `john@<name>` (e.g. `john@player`). The signup box shows a live preview. You can log in with **either** `player` **or** `john@player`. | Auth screen + `server.js`. |
| 3 | **New login text** — "18+ ONLY" + "WELCOME TO JOHN'S SLOTS. Play responsibly." | Auth card. |
| 4 | **Logo** — your uploaded artwork is now the logo on the auth screen, the top bar, the app icon, and the receipt. | `public/assets/`. |
| 5 | **Admin can change any user's password** — each player card in **Admin → Users** has a "Set password" field. | Admin → Users + `POST /api/admin/users/:username/password`. |
| 6 | **Redeem balance + printable receipt** — players tap **Redeem** in the **Wallet** tab. Minimum to redeem is **$1.00**. Redeeming zeroes the balance immediately and issues a **printable receipt** with a unique code (e.g. `JS-AB12-CD34`). The player shows that code to get the amount loaded into their game. A receipt **expires after 24 hours** if not claimed (the amount is then lost) — the player is clearly warned. Admins see every receipt under **Admin → Redemptions**, where they mark it **Loaded** (claimed) or **Refund** it back to the player's balance. | **Wallet** tab + **Admin → Redemptions** + `/api/redeem`, `/api/redemptions`, `/api/admin/redemptions...`. |

> Note on "(hourly spin)": the redeem flow issues a receipt the player uses to **load credits into their game**, exactly as described. It does **not** add a separate hourly spin feature — if you actually want a recurring hourly spin (like the daily spin, but every hour), say the word and it can be added.

---

## Run it on your computer (3 steps)

You need **Node.js 18 or newer**. Check with `node -v`. If you don't have it, get it from <https://nodejs.org> (the "LTS" button).

Open a terminal **in this folder**, then:

```bash
npm install      # 1) download dependencies (one time, ~10s)
npm start        # 2) start the server
```

```
3) open your browser at  http://localhost:3000
```

Stop the server anytime with **Ctrl + C**.

### First login (admin)

On first start the server creates an admin account and prints it in the terminal:

```
username: admin
password: admin123
```

Log in with that. The **Admin** tab only appears for admin accounts.

> 🔐 **Change this immediately for any real use.** Set your own before first launch:
> ```bash
> ADMIN_USERNAME=myname ADMIN_PASSWORD='a-strong-password' npm start
> ```
> (These only take effect the **first** time, when the database is created. To reset later, stop the server, delete `data.json`, and start again — this wipes all data.)

---

## How to use the admin panel

Log in as admin → click **Admin**.

- **Lucky Draw** — type up to 10 usernames (one per line, or comma-separated) and a daily spin time like `20:00` (24-hour, server's local time). Click **Save**. The wheel then spins automatically once per day at that time for everyone watching. **Spin now** runs it on demand.
- **News** — write a title + message, click **Post**. Appears instantly for all users.
- **Giveaways** — title, prize, details, optional end date.
- **Downloads** — paste a name and link into any of the 10 slots, click **Save links**. These show up on the Games page.
- **Users** — see balances; type a number (e.g. `5` or `-2`) next to a user and apply it to adjust their balance.

---

## How the "everyone sees the same live spin" works

The wheel result is decided **on the server**, then broadcast to every connected browser with a shared start time, so all screens animate together and land on the same winner. This is fully implemented — you'll see it the moment **two or more browsers** are connected to the **same running server** (e.g. two tabs locally, or many people once it's deployed online — see below).

---

## Putting it online (so real users can join)

Running on your laptop only works for people on it. To let others reach it, deploy to any Node host:

- **Easiest:** [Render](https://render.com) or [Railway](https://railway.app) — create a "Web Service" from this folder/repo, build command `npm install`, start command `npm start`. They give you a public URL.
- **Your own server/VPS:** run `npm install` then `npm start` (keep it alive with `pm2` or a systemd service), and put it behind a reverse proxy with HTTPS.

Set these environment variables on the host:

- `ADMIN_USERNAME`, `ADMIN_PASSWORD` — your admin login (first run only).
- `JWT_SECRET` — any long random string (keeps logins secure). If omitted, one is generated and saved to `.secret`.
- `PORT` — most hosts set this for you automatically.

### Data storage note
Accounts, balances, and content are saved in a simple `data.json` file next to the server. That's perfect for testing and small groups. For a serious launch with many users, swap it for a real database (PostgreSQL, MongoDB, etc.) — the data layer is isolated in `server.js`, so it's a contained change.

---

## Project layout

```
johns-slots/
├─ server.js          backend: accounts, spins, draws, real-time sync, API
├─ package.json       dependencies + start scripts
├─ public/
│  ├─ index.html      the whole UI (all tabs)
│  ├─ styles.css      neon-luxe theme
│  └─ app.js          frontend logic + live wheel + slot animation
└─ (created on first run) data.json · .secret   ← your data; don't commit/share
```

---

## ⚠️ Important / Legal — please read

- **This is a demo / social-casino style app. Balances and prizes are VIRTUAL credits with no cash value.** It does **not** process payments or move real money, by design.
- **Real-money gambling is heavily regulated and outright illegal in many places.** Operating it for real wagers typically requires a gambling licence, identity/age (KYC) verification, anti-money-laundering checks, geo-restriction, a licensed payment processor, and legal counsel. Don't connect this to real money without all of that.
- **18+ / 21+ only**, per your jurisdiction. The UI carries an age notice; enforce real age verification before any real-stakes use.
- **Gamble responsibly.** If gambling stops being fun, seek help (e.g. in the US: 1-800-GAMBLER).
- **Security before public launch:** change the default admin password, set a strong `JWT_SECRET`, and serve over HTTPS.

---

Built with Node.js, Express, and Socket.IO. Enjoy — and ship it responsibly. 🎲
