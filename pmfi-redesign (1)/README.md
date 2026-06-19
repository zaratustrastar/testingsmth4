# PMFI V2.2 dApp

Static, framework-free frontend for the PMFI V2.2 option-backed lending protocol on Base.
Plain HTML + ES modules + vanilla JS. `ethers` loads from a CDN at runtime, so there is
no bundler — the only "build" is copying files into `dist/`.

## Local

```bash
npm test          # runs the node:test suite (no install needed)
npm run dev       # serves the app at http://localhost:5173
npm run build     # copies the app into dist/
npm run preview   # serves dist/ at http://localhost:4173
```

Open `preview.html` directly in a browser for a wallet-free visual mock of all three tabs.

---

## 1 · Push to a NEW GitHub repo (your existing repo/site is untouched)

A new repository is fully independent — pushing here cannot affect your other repo or your
live website. The live site only changes when *you* deploy (step 2).

1. On github.com, create a new **empty** repo (no README, no .gitignore). Copy its URL.
2. In this project folder:

```bash
git init
git add .
git commit -m "PMFI V2.2 frontend overhaul"
git branch -M main
git remote add origin https://github.com/<you>/<new-repo>.git
git push -u origin main
```

---

## 2 · Deploy on the VPS WITHOUT touching the current website

The golden rule for not disturbing the existing site: **new directory + new URL**. Never
edit or remove the existing site's files or its web-server config — only *add* alongside it.

Clone into a fresh directory:

```bash
cd /var/www
git clone https://github.com/<you>/<new-repo>.git pmfi
cd pmfi
npm run build        # produces dist/  (optional — you can also serve the repo root)
```

Then expose it at a URL that is separate from the current site. Pick ONE:

### Option A — Subdomain (recommended, cleanest)

e.g. `app.yourdomain.com`. Add a **new** nginx server block in its own file
(`/etc/nginx/sites-available/pmfi`), leaving the existing one alone:

```nginx
server {
    listen 80;
    server_name app.yourdomain.com;
    root /var/www/pmfi/dist;
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/pmfi /etc/nginx/sites-enabled/pmfi
sudo nginx -t          # validate — does not touch the running config until reload
sudo systemctl reload nginx
sudo certbot --nginx -d app.yourdomain.com   # optional HTTPS
```

Add an `A`/`CNAME` DNS record for `app` pointing at the VPS.

### Option B — Separate port (fastest way to "just look at it")

```nginx
server {
    listen 8080;
    server_name _;
    root /var/www/pmfi/dist;
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
}
```

Reach it at `http://YOUR_SERVER_IP:8080` (open the port in your firewall). Or, for a
throwaway look without nginx at all:

```bash
npm run preview      # http://YOUR_SERVER_IP:4173  (uses the bundled static server)
```

### Option C — Subpath on the existing domain, e.g. `yourdomain.com/pmfi/`

Asset paths are relative, so this works. Add a `location` block to the **existing**
server (this is the only option that edits the current site's config, so be careful):

```nginx
location /pmfi/ {
    alias /var/www/pmfi/dist/;
    try_files $uri $uri/ /pmfi/index.html;
}
```

### Caddy alternative (subdomain)

```
app.yourdomain.com {
    root * /var/www/pmfi/dist
    file_server
    try_files {path} /index.html
}
```

---

## Updating later

```bash
cd /var/www/pmfi && git pull && npm run build
```

No web-server reload is needed for content changes — only when you change the server block.

## Notes

- Serve over HTTP(S), not `file://` — ES module imports need a real origin.
- The protocol contract addresses live in `src/config.js` and are intentionally fixed.
- See `NOTES.md` for what changed in this overhaul.
