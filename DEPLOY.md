# Deploying JOHN'S SLOTS (Render Blueprint + Namecheap domain)

This repo includes a `render.yaml` Blueprint that sets up everything in one shot:
a Node web service, an auto-generated `JWT_SECRET`, a prompt for your admin login,
and a 1 GB persistent disk so accounts and balances survive restarts.

## 1. Put this folder on GitHub
From a terminal inside this folder:

    git init
    git add .
    git commit -m "initial"

Create a new empty repo at github.com, then run the two commands GitHub shows you
(`git remote add origin ...` and `git push -u origin main`).
`node_modules`, `data.json`, and `.secret` are git-ignored, so no secrets are uploaded.

## 2. Deploy on Render
1. Sign up at https://render.com and connect your GitHub.
2. Click **New +** -> **Blueprint**.
3. Select this repository. Render reads `render.yaml` and shows what it will create.
4. It will prompt you for the two `sync: false` values:
   - `ADMIN_USERNAME` — your admin login name
   - `ADMIN_PASSWORD` — a strong password (replaces the default `admin123`)
5. Click **Apply** / **Deploy Blueprint**.

In a couple of minutes you get a URL like `https://johns-slots.onrender.com`.
Open it, log in with the admin credentials you set, and confirm it works.

> Plan note: `render.yaml` uses `plan: starter` (~$7/mo) because the persistent disk
> requires a paid instance. If you'd rather run free and don't mind ALL data resetting
> on every restart, change `plan: starter` to `plan: free` and delete the `disk:` block.

## 3. Point your Namecheap domain at it
1. In Render: your service -> **Settings** -> **Custom Domains** -> add `yourdomain.com`
   and/or `www.yourdomain.com`. Render shows the exact DNS record(s) to add.
2. In Namecheap: **Domain List** -> **Manage** -> **Advanced DNS**. Add what Render gave you:
   - A **CNAME** record, host `www`, value = your `xxxx.onrender.com` target.
   - For the root domain, add the record Render specifies for the apex (an ALIAS/ANAME,
     or the A record value they provide).
3. **Delete Namecheap's default parking records** (the pre-filled CNAME + URL-redirect
   entries) so they don't conflict.

Render issues HTTPS automatically once the DNS verifies. Propagation takes anywhere
from a few minutes to a couple of hours.

## Notes
- Single instance only: the live wheel (Socket.IO) and the JSON-file storage assume one
  instance. Don't scale the service to multiple instances. (The persistent disk enforces
  this anyway — a disk attaches to a single instance.)
- For a large launch, swap the JSON file for a real database; the data layer is isolated
  in `server.js`.
