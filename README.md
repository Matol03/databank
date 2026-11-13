# Wayfarer — tourism recommendation platform

Wayfarer is a tourism discovery website backed by a **MongoDB** data model for tourists (users), destinations (items),
and their interactions. The project includes a responsive **frontend**, a **REST API** (Node.js + Express), a
**collaborative-filtering recommendation engine**, performance tests, and a seed script with synthetic test data.

* **Personalised recommendations** (final project): item-based collaborative filtering with a pre-computed
  item–item similarity model, user-based collaborative filtering on request, cold-start fallback, two-level cache,
  "travellers who liked this also liked", offline evaluation (Precision/Recall/NDCG) and a benchmark from 300 to
  10 000 users. See [`docs/RECOMMENDATIONS.md`](docs/RECOMMENDATIONS.md) and [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).
* Users register with **e-mail verification** (6-digit code or link, SMTP or demo delivery), log in (JWT), keep a travel profile.
* Item catalogue of 64 real destinations (Kazakhstan, Central Asia, Europe, Asia, …) with full CRUD for admins.
* Interactions: views, bookmarks, visits, bookings and 1–5 ratings, stored as an event log.
* Search: full-text (weighted), prefix, filters (category, country, price, season, rating, tags) and geospatial "near me".
* 34 automated tests (incl. end-to-end e-mail delivery through a local SMTP server), query plans checked with `explain()`.

Documentation: [`docs/API.md`](docs/API.md) (API reference) · [`docs/RECOMMENDATIONS.md`](docs/RECOMMENDATIONS.md) (algorithms) · [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) (performance tests and optimisation) · [`docs/DATASET.md`](docs/DATASET.md) (MongoDB collections, data fields, and inspection queries) · [`docs/PROPOSAL.docx`](docs/PROPOSAL.docx) (project proposal,
data-model comparison, indexes, planned algorithm, relevance to the dissertation).

## Website frontend

The Wayfarer frontend is served at `/` from `public/`. It supports destination discovery, filters, nearby search, account registration with e-mail verification and sign-in, a personalised "Recommended for you" list (item- or user-based CF, with the reason for each place), "travellers who liked this also liked" in the detail view, saved destinations, ratings, and visit history. It uses the existing `/api` endpoints and requires no frontend build step. See [`docs/FRONTEND.md`](docs/FRONTEND.md) for details.

## Requirements

* Node.js **20+**
* MongoDB **6+** (tested with 8.x) running locally, in Docker, or in MongoDB Atlas

## Quick start

```bash
git clone https://github.com/Matol03/databank.git
cd databank
npm install
cp .env.example .env            # (Windows: copy .env.example .env)

# 1) start MongoDB – choose one:
docker compose up -d            # Docker
#   or install MongoDB Community and run `mongod`
#   or put an Atlas connection string into MONGO_URI in .env

# 2) load test data (drops and recreates the collections + indexes)
npm run seed

# 3) start the API
npm start                       # website: http://localhost:3000/ · API health: http://localhost:3000/api/health
```

Test accounts created by the seed:

| Role | E-mail | Password |
|---|---|---|
| admin | `admin@tourism.local` | `Admin12345!` |
| user | `demo@tourism.local` | `Demo12345!` |
| 300 synthetic users | `traveller1@example.com` … `traveller300@example.com` | `Password123!` |

First requests:

```bash
curl localhost:3000/api/health
curl 'localhost:3000/api/items/popular?limit=3'
curl -G localhost:3000/api/items/search --data-urlencode 'q=lake mountains'
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login -H 'Content-Type: application/json' \
        -d '{"email":"demo@tourism.local","password":"Demo12345!"}' | jq -r .token)
curl localhost:3000/api/users/me/history?limit=3 -H "Authorization: Bearer $TOKEN"
curl 'localhost:3000/api/recommendations?limit=5' -H "Authorization: Bearer $TOKEN"
curl 'localhost:3000/api/recommendations?limit=5&algorithm=user' -H "Authorization: Bearer $TOKEN"
```

### E-mail verification

New accounts must confirm their e-mail address (6-digit code or one-time link, valid 15 min, max. 5 wrong tries,
one new code per minute) before they can sign in. The server picks the first configured provider:

| Provider | Variables | Notes |
|---|---|---|
| **SMTP** (recommended) | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, optional `MAIL_FROM` | Gmail: `smtp.gmail.com`, port `465`, your Gmail address and a 16-character **App Password** (Google Account → Security → 2-Step Verification → App passwords). Sends to any address; the sender is your Gmail address. Brevo, Mailgun, Outlook etc. work the same way. |
| **Resend** (HTTP API) | `RESEND_API_KEY`, optional `MAIL_FROM` | No SMTP ports needed. Without a verified domain Resend only delivers to your own account address (sender `onboarding@resend.dev`); verify a domain to send to anyone. |
| demo (none set) | – | The code is returned by the API and shown in the sign-up dialog; `EMAIL_DEMO_MODE=false` forbids this. |

```bash
# .env — Gmail example
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@gmail.com
SMTP_PASS=abcdefghijklmnop
APP_URL=http://localhost:3000        # base of the verification link (Vercel: the production URL is used automatically)
```

Check the configuration and send yourself a test message:

```bash
npm run email:test -- you@example.com
```

`GET /api/health` reports the active provider (`"email": "smtp" | "resend" | "demo"`). As soon as a provider is
configured the code is no longer returned by the API. The seeded accounts are already verified.

## Deploying to Vercel (serverless)

Vercel detects the Express app automatically (`src/app.js` exports it as the default export and connects to the database on the first request). Vercel has **no database**, so a hosted MongoDB is required.

1. **MongoDB Atlas** (free M0 cluster): create a database user, and under *Network Access* allow `0.0.0.0/0`
   (Vercel uses changing IP addresses). Copy the connection string (`mongodb+srv://user:password@cluster.../`).
2. **Load the data into Atlas**, using either option:
   * **Easiest:** add the Vercel variable `AUTO_SEED` = `true` (step 3). On the first request, a completely empty database is
     filled with the demo data (64 destinations, about 100 synthetic users); a database that already has data is never touched.
     Only one serverless instance seeds (a lock document in the `meta` collection), and a `done` marker prevents re-seeding.
     If an earlier attempt left the database **half-filled** (for example `items` > 0 but `users` = 0), set `AUTO_SEED` = `reset`
     once: it drops and reloads the demo data, then marks it done. `reset` is destructive, use it only on a demo database.
     `/api/health` shows the progress (`counts` and `seed`: running / done / failed).
   * **From your computer** (full data set, 300 users; this drops and recreates the collections):
   ```bash
   MONGO_URI="mongodb+srv://user:password@cluster.mongodb.net" npm run seed
   # Windows PowerShell:  $env:MONGO_URI="mongodb+srv://..."; npm run seed
   ```
3. **Vercel project → Settings → Environment Variables**, then redeploy:

   | Name | Value |
   |---|---|
   | `MONGO_URI` | the Atlas connection string |
   | `DB_NAME` | `tourism_recsys` |
   | `JWT_SECRET` | a long random string |
   | `AUTO_SEED` | `true` (optional, see step 2) |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (or `RESEND_API_KEY`), optional `MAIL_FROM` | real verification e-mails (otherwise demo delivery) — see *E-mail verification* above |
   | `APP_URL` | optional: public URL for the verification link (defaults to the Vercel production URL) |

4. Open `https://<your-project>.vercel.app/api/health`. A configuration error (missing variable, wrong password,
   Atlas network access) is shown as readable JSON (HTTP 503) instead of a bare 500; the Vercel *Logs* tab has details.

**Troubleshooting.** Open `/api/health`: it shows the database name and the number of items, users and interactions.
`"items":0` means the database is empty, so run the seed (step 2) with the *same* `MONGO_URI` and `DB_NAME` as in Vercel.
The indexes are created automatically on the first request. A 500 response contains a short `detail` label
(for example `MongoServerError: IndexNotFound`); the full error is in the Vercel *Logs* tab.

Notes: the rate limiter and the database connection live per function instance.

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `MONGO_URI` | `mongodb://127.0.0.1:27017` | MongoDB connection string |
| `DB_NAME` | `tourism_recsys` | database name |
| `JWT_SECRET` | dev value | **set a long random string** (required when `NODE_ENV=production`) |
| `JWT_EXPIRES_IN` | `2h` | token lifetime |
| `AUTH_RATE_LIMIT` | `50` | max login/register requests per IP per 15 min |
| `MONGO_POOL_SIZE` | `10` | MongoDB connection pool size |
| `AUTO_SEED` | unset | `true`: fill a completely empty database with demo data on the first request (`AUTO_SEED_USERS`, default 100); `reset`: also repair a half-filled demo database (destructive) |
| `APP_URL` | `http://localhost:PORT` (Vercel: production URL) | public website URL used in the verification e-mail link |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | unset / `587` | SMTP server for verification e-mails |
| `RESEND_API_KEY` | unset | Resend HTTP API instead of SMTP |
| `MAIL_FROM` | SMTP login if it is an address, else `Wayfarer <no-reply@wayfarer.local>` (Resend: `onboarding@resend.dev`) | sender address |
| `EMAIL_DEMO_MODE` | `true` if no provider is configured | return the code in the API response / show it in the UI (demo only) |
| `EMAIL_CODE_TTL_MINUTES` | `15` | lifetime of a verification code |
| `CF_MODEL_TTL_MINUTES` | `60` | age after which the item–item model is rebuilt in the background |
| `CF_NEIGHBOURS` | `30` | neighbours stored per place |
| `CF_USER_CANDIDATES` | `300` | max. candidate travellers in user-based CF |
| `REC_CACHE` | on | `off` disables the recommendation cache |
| `REC_CACHE_TTL_SECONDS` | `600` | lifetime of a cached recommendation list |

## npm scripts

| Script | What it does |
|---|---|
| `npm start` / `npm run dev` | run the API (`dev` restarts on file changes) |
| `npm run seed` | rebuild the database with test data. `node scripts/seed.js --users=3000` creates a bigger set (≈180 000 interactions) for performance tests |
| `npm test` | 34 tests: API, recommendations, and e-mail delivery through a real local SMTP server (separate test databases, dropped afterwards) |
| `npm run email:test -- you@example.com` | check the e-mail provider and send a test verification e-mail |
| `npm run build-model` | (re)build the item–item collaborative-filtering model |
| `npm run evaluate` | offline accuracy test (hold-out): Precision/Recall/HitRate/NDCG@10 of item-CF, user-CF and baselines |
| `npm run benchmark` | performance test on growing data sets (`--sizes=300,1000,3000,10000`), writes `docs/perf/benchmark.json` |
| `npm run explain` | prints the query plan of the main queries (IXSCAN vs COLLSCAN) |
| `npm run inspect-db` | collection sizes, indexes and sample documents |
| `npm run indexes` | creates the indexes without changing the data |
| `npm run recompute` | rebuilds all denormalised counters from the interactions |

## Data model in one picture

```
users                { email*, passwordHash, role, emailVerified, emailVerification?{codeHash, tokenHash, expiresAt},
                       profile{…}, tasteProfile{category: score}, recentActivity[≤20], favoritePlaces[] }
items                { name, description, category, country, city, location(GeoJSON), tags[], priceLevel, … , stats{…} }
interactions         { userId, itemId, type, rating?, weight, context{}, createdAt }      (* unique)
item_similarities    { _id: itemId, neighbours[≤30]{ itemId, score, common }, version }   (pre-computed CF model)
recommendation_cache { _id: user+params, userId, modelVersion, result, expiresAt }         (TTL cache)
```

* `interactions` is a separate collection (unbounded growth) – one document per event.
* Hot, small aggregates are denormalised (`items.stats`, `users.tasteProfile`, `users.recentActivity`) and kept
  up to date atomically on every interaction – the recommender never has to scan the whole event log for them.
* Indexes (see `src/db.js`): unique e-mail; `category + avgRating`; `country + city`; `popularity`; `tags`; `bestSeasons`;
  `city` prefix; unique `name + city`; `2dsphere` location; weighted text index; `user + createdAt`;
  `item + createdAt`; partial unique `user + item` for ratings and bookmarks; covering indexes
  `user + item + type + weight` and `item + user + type + weight` for the recommender; TTL index on the cache.
  Details and trade-offs are in the proposal.

## Project structure

```
src/
  server.js, app.js, config.js, db.js     start-up (npm start), Express app (default export), settings, connection + indexes
  schemas.js, constants.js, errors.js     validation (zod), enums and weights, error helpers
  middleware/                             JWT authentication / roles, error handler
  routes/                                 auth (+ e-mail verification), users, items, interactions, recommendations
  services/                               items (search), interactions (counters, history), stats (recompute),
                                          cf (CF algorithms), recommendations (model, cache, API logic), mailer
scripts/                                  seed, create-indexes, explain, inspect-db, recompute-stats,
                                          build-model, evaluate, benchmark
data/destinations.json                    the item catalogue (64 destinations; coordinates ≈ 1 km accuracy)
test/api.test.js                          API tests (node:test)
docs/                                     API reference, recommender design, performance report (+ perf/*.json, charts), proposal
```

## Notes and limitations

* Test data is **synthetic**: users and interactions are generated from traveller archetypes with a fixed
  random seed (reproducible). No personal data is used.
* A standalone MongoDB has no multi-document transactions. The counters are updated by atomic single-document
  operations and can be rebuilt with `npm run recompute` if an update is ever interrupted.
* Prefix search matches the beginning of the name or city only; use the full-text search for words inside a name.
* The recommendation quality is measured on synthetic data; it demonstrates that the algorithms work, not how real
  tourists behave. The benchmark numbers depend on the machine (see `docs/perf/benchmark.json` for the environment).
* Without an SMTP server the verification code is shown in the UI (demo delivery); configure SMTP for real use.
