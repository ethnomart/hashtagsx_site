# HASHTAGSX API

Small Node server that receives orders from the store and lets the admin portal read and update them.

## Environment variables
| Name | Meaning |
|---|---|
| `ADMIN_PASSWORD` | Required. Password for the admin portal. |
| `DATABASE_URL` | Postgres connection string. The `orders` table is created automatically. |
| `ALLOWED_ORIGINS` | Comma-separated store and admin addresses allowed to call the API. |
| `PORT` | Set by the host automatically. |

## Deploy on Render (or Railway)
1. Push this folder to its own GitHub repo.
2. Render > New > Web Service > pick the repo. Build command `npm install`, start command `npm start`.
3. Add the three environment variables above.
4. Open `https://YOUR-API/health`. It should answer `{"ok":true,...}`.

## Run locally
```
npm install
ADMIN_PASSWORD=test ALLOWED_ORIGINS=* npm start
```
