# Predictos — Live Soccer Pro Bets

A PWA that scrapes live soccer from Betika, tracks matches from kickoff, and sends push notifications when a game qualifies as a **Pro Bet**.

## How it works

The server polls `live.betika.com` every 30 seconds and records each match in a local SQLite database from the moment it kicks off. When a tracked game reaches half time and still meets all criteria it fires a **half-time alert**. If no goal is scored in the first 10 minutes of the second half the match reaches the **55-minute stage** and a second alert fires.

### Pro Bet criteria (all must be true)

| # | Rule |
|---|------|
| 1 | Match was tracked from within the first 5 minutes of kick-off |
| 2 | First goal scored after the 15th minute, **or** no goal in the 1st half at all |
| 3 | Fewer than 3 yellow cards total across both teams at any point |
| 4 | No red cards at any point |
| 5 | No goal scored between the 45th and 55th minute (early 2nd-half goal voids the bet) |

Virtual / Zoom / eSport leagues are excluded entirely.

## Stack

- **Node.js** + Express — API server
- **better-sqlite3** — match tracking database
- **web-push** — VAPID push notifications
- **Vanilla JS PWA** — installable on desktop and mobile

## Running locally

```bash
cd betika-live
npm install
node server.js
```

Open `http://localhost:3000`

## Running with Docker

```bash
cd betika-live
docker build -t predictos .
docker run -p 3000:3000 predictos
```

## Deploying to Render

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → **New → Web Service**
3. Connect your GitHub repo
4. Set these options:

| Setting | Value |
|---------|-------|
| Root Directory | `betika-live` |
| Environment | `Docker` |
| Instance Type | Starter (512 MB RAM is enough) |

5. Click **Deploy** — Render will build the Docker image and start the server

> **Note:** The SQLite database is ephemeral on Render's free tier (resets on redeploy). Match tracking restarts automatically on boot. For persistence, upgrade to a paid instance with a disk mount at `/app/matches.db`.

## PWA install

Open the site in Chrome on desktop or Android and click **⬇️ Install App** in the header. On iOS, use Safari → Share → Add to Home Screen.

## Push notifications

Click **🔕 Enable Alerts** to subscribe. Notifications are delivered via the Web Push protocol even when the browser is in the background.

## Track Pro Bets button

Click **🔍 Track Pro Bets** at any time to immediately lock in all matches currently in minute 0–5. The server will track them for the rest of the game and alert you when they qualify.

## Environment variables

No required environment variables — VAPID keys are baked in. To rotate them run:

```bash
node -e "const wp=require('web-push'); console.log(JSON.stringify(wp.generateVAPIDKeys()))"
```

Then replace `VAPID_PUBLIC` and `VAPID_PRIVATE` in `server.js`.
