# IPAS — Linux VM run notes

## ✅ The ONE correct command to start the app

```bash
./run-web-app.sh
```

Then open: **http://192.168.66.74:3000**

The script starts the Express server (`tsx server.ts`) which handles BOTH:
- Serving the built React app (`dist/`)
- ALL `/api/*` routes (login, OCR, upload, save, PDF, etc.)

---

## ❌ Do NOT run these — they break the API

| Wrong command | Why it breaks |
|---|---|
| `npx vite preview` | Static-file server only — has NO API routes. Login returns empty response. |
| `npm run preview` *(old)* | Was an alias for `vite preview`. Now fixed to call `./run-web-app.sh`. |
| `vite preview --port 3000` | Conflicts with Express; falls back to 3001 where API calls fail. |

---

## How the server works

```
Browser → port 3000 → Express (tsx server.ts)
                         ├── GET /           → serves dist/index.html
                         ├── GET /assets/*   → serves dist/assets/*
                         └── /api/*          → all backend logic (auth, OCR, DB, PDF…)
```

`vite preview` only handles the first two rows and returns empty 404s for `/api/*`.

---

## Start options

```bash
# Production (default — port 3000)
./run-web-app.sh

# Custom port
PORT=3001 ./run-web-app.sh

# Development mode (HMR)
./run-web-app.sh dev
```

The script automatically kills any stale `vite preview` or old server before starting.

---

## Verify it's up

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3000/
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"2015-3357","password":"1234"}'
```

Expected: `HTTP 200` and a JSON user object.

---

## ⚠️ Port 3000 already in use?

```bash
# See what's holding it
ss -tlnp | grep ':3000'

# If it's a resty-owned process (vite or old tsx):
pgrep -f "vite preview" | xargs kill 2>/dev/null
pgrep -f "tsx server.ts" | xargs kill 2>/dev/null

# Then start normally
./run-web-app.sh
```

If it's a **root-owned** process you can't kill, use a different port:

```bash
PORT=3001 ./run-web-app.sh
```
