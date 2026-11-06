# databank — tourism recommendation platform (data layer + backend)

Backend of a tourism recommender system: a **MongoDB** data model for tourists (users), destinations (items)
and their interactions, a **REST API** (Node.js + Express) and a seed script with synthetic test data.
It is the foundation for the recommendation engine of the final project
(content-based, collaborative and hybrid algorithms for tourism).

* Users register, log in (JWT), keep a travel profile.
* Item catalogue of 64 real destinations (Kazakhstan, Central Asia, Europe, Asia, …) with full CRUD for admins.
* Interactions: views, bookmarks, visits, bookings and 1–5 ratings, stored as an event log.
* Search: full-text (weighted), prefix, filters (category, country, price, season, rating, tags) and geospatial "near me".
* 19 automated API tests, query plans checked with `explain()`.

Documentation: [`docs/API.md`](docs/API.md) (API reference) · [`docs/PROPOSAL.docx`](docs/PROPOSAL.docx) (project proposal,
data-model comparison, indexes, planned algorithm, relevance to the dissertation).

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
npm start                       # http://localhost:3000/api/health
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
```

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

## npm scripts

| Script | What it does |
|---|---|
| `npm start` / `npm run dev` | run the API (`dev` restarts on file changes) |
| `npm run seed` | rebuild the database with test data. `node scripts/seed.js --users=3000` creates a bigger set (≈180 000 interactions) for performance tests |
| `npm test` | 19 API tests (use a separate database `tourism_recsys_test`, which is dropped afterwards) |
| `npm run explain` | prints the query plan of the main queries (IXSCAN vs COLLSCAN) |
| `npm run inspect-db` | collection sizes, indexes and sample documents |
| `npm run indexes` | creates the indexes without changing the data |
| `npm run recompute` | rebuilds all denormalised counters from the interactions |

## Data model in one picture

```
users          { email*, passwordHash, role, profile{…}, tasteProfile{category: score}, recentActivity[≤20] }
items          { name, description, category, country, city, location(GeoJSON), tags[], priceLevel, … , stats{…} }
interactions   { userId, itemId, type, rating?, weight, context{}, createdAt }      (* unique)
```

* `interactions` is a separate collection (unbounded growth) – one document per event.
* Hot, small aggregates are denormalised (`items.stats`, `users.tasteProfile`, `users.recentActivity`) and kept
  up to date atomically on every interaction – the recommender never has to scan the whole event log for them.
* Indexes (see `src/db.js`): unique e-mail; `category + avgRating`; `country + city`; `popularity`; `tags`; `bestSeasons`;
  `city` prefix; unique `name + city`; `2dsphere` location; weighted text index; `user + createdAt`;
  `item + createdAt`; partial unique `user + item` for ratings.
  Details and trade-offs are in the proposal.

## Project structure

```
src/
  server.js, app.js, config.js, db.js     start-up (npm start), Express app (default export), settings, connection + indexes
  schemas.js, constants.js, errors.js     validation (zod), enums and weights, error helpers
  middleware/                             JWT authentication / roles, error handler
  routes/                                 auth, users, items, interactions
  services/                               items (search), interactions (counters, history), stats (recompute)
scripts/                                  seed, create-indexes, explain, inspect-db, recompute-stats
data/destinations.json                    the item catalogue (64 destinations; coordinates ≈ 1 km accuracy)
test/api.test.js                          API tests (node:test)
docs/                                     API reference, project proposal
```

## Notes and limitations

* Test data is **synthetic**: users and interactions are generated from traveller archetypes with a fixed
  random seed (reproducible). No personal data is used.
* A standalone MongoDB has no multi-document transactions. The counters are updated by atomic single-document
  operations and can be rebuilt with `npm run recompute` if an update is ever interrupted.
* Prefix search matches the beginning of the name or city only; use the full-text search for words inside a name.
* The recommendation algorithms (hybrid content-based + collaborative filtering) are planned for the final project;
  this backend provides the data, indexes and counters they need.
