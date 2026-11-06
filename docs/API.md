# API documentation

For the MongoDB collection structure, field meanings, and practical Atlas/Compass inspection queries, see [DATASET.md](DATASET.md).

Base URL: `http://localhost:3000/api` · Format: JSON · Authentication: `Authorization: Bearer <JWT>`

All errors have the same shape:

```json
{ "error": "ValidationError", "message": "Invalid request",
  "details": [ { "path": "password", "message": "Password must contain a digit" } ] }
```

| Status | Meaning |
|---|---|
| 400 | validation error, malformed JSON, invalid id |
| 401 | missing, invalid or expired token; wrong e-mail/password |
| 403 | authenticated, but not allowed (e.g. a normal user calls an admin endpoint) |
| 404 | item / interaction / route not found |
| 409 | unique constraint violated (e-mail already registered, item already exists) |
| 429 | too many login/registration attempts |

Pagination parameters (`page` ≥ 1, `limit` 1–50, default 10) return
`{ data: [...], page, limit, total, totalPages }`.

Lists of allowed values:

* **category**: `nature, mountains, beach, heritage, museum, city, adventure, gastronomy, wellness, religious`
* **season**: `spring, summer, autumn, winter`
* **travelStyle**: `solo, couple, family, friends, business`
* **interaction type**: `view, bookmark, visit, booking, rating`
* **priceLevel / budgetLevel**: `1` budget · `2` moderate · `3` upscale · `4` luxury

---

## 1. Authentication

### `POST /auth/register`  — public

| Field | Type | Rules |
|---|---|---|
| `email` | string | valid e-mail, stored lower-case, unique |
| `password` | string | 8–72 characters, at least one letter and one digit |
| `profile.fullName` | string | **required**, 2–100 chars |
| `profile.age` | integer | **required**, 13–120 |
| `profile.city` | string | **required**, 2–80 chars; the user's home city |
| `profile.interests` | array of categories | max 10; saved as the user's declared travel interests |
| `profile.country` | string | |
| `profile.travelStyle` | enum | see above |
| `profile.budgetLevel` | integer | 1–4 |
| `profile.preferredSeasons` | array of seasons | |
| `profile.bio` | string | ≤ 500 |

Unknown fields (for example `role`) are rejected, so nobody can register as admin.

```bash
curl -X POST localhost:3000/api/auth/register -H 'Content-Type: application/json' -d '{
  "email": "aigul@example.com", "password": "Travel2026",
  "profile": { "fullName": "Aigul Sadykova", "age": 27, "city": "Astana", "country": "Kazakhstan",
               "travelStyle": "solo", "budgetLevel": 2, "interests": ["mountains", "heritage"] } }'
```

**201** → `{ "token": "<jwt>", "user": { "_id": "...", "email": "...", "role": "user", "profile": {...}, "tasteProfile": {}, "recentActivity": [], "createdAt": "..." } }`
(the password hash is never returned) · **400** · **409** e-mail exists.

### `POST /auth/login`  — public

Body: `{ "email": "...", "password": "..." }` → **200** `{ token, user }` · **401** `Invalid e-mail or password`
(the same message for an unknown e-mail and a wrong password).
The token is valid for `JWT_EXPIRES_IN` (default 2 h).

---

## 2. Users

All endpoints need a token.

### `GET /users/me`
Returns the current user including `profile`, `role`, `tasteProfile`, `recentActivity` (the last 20 events)
and `favoritePlaces` (an array embedded directly in the user document). Each favorite contains
`itemId`, `interactionId`, `name`, `city`, `country`, `category` and `likedAt`. Existing accounts
are backfilled from their bookmark history the first time this endpoint is read.

### `PUT /users/me`
Partial update of the profile. Body: any subset of the profile fields listed above.
Only the given fields change. Returns the updated user. **400** for empty body / invalid values.

```bash
curl -X PUT localhost:3000/api/users/me -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{ "age": 28, "budgetLevel": 3 }'
```

### `GET /users/me/history`
The user's interactions, newest first, each joined with basic item data. Bookmark documents also store a `destinationSnapshot` (`name`, `city`, `country`, `category`) at the moment the user saves the place. This makes liked destinations and their cities directly queryable in the `interactions` collection, even if catalogue details later change.

| Query | Description |
|---|---|
| `type` | filter: `view`, `bookmark`, `visit`, `booking`, `rating` |
| `page`, `limit` | pagination |

```json
{ "data": [ { "_id": "...", "type": "bookmark", "weight": 3, "createdAt": "...",
              "itemId": "...", "destinationSnapshot": { "name": "Charyn Canyon", "category": "nature",
                                         "city": "Charyn", "country": "Kazakhstan" },
              "item": { "name": "Charyn Canyon", "category": "nature", "city": "Charyn", "country": "Kazakhstan" } } ],
  "page": 1, "limit": 10, "total": 4, "totalPages": 1 }
```

---

## 3. Item catalogue

An item is a tourist destination / attraction.

```json
{
  "_id": "6aea…", "name": "Charyn Canyon",
  "description": "A 90-kilometre red-rock canyon …",
  "category": "nature", "country": "Kazakhstan", "city": "Charyn",
  "location": { "type": "Point", "coordinates": [79.08, 43.35] },      // GeoJSON: [lon, lat]
  "tags": ["canyon", "hiking"], "priceLevel": 1, "avgDailyCostUSD": 50,
  "bestSeasons": ["spring", "autumn"],
  "attributes": { "recommendedDays": 2, "familyFriendly": true, "outdoor": true },
  "stats": { "viewCount": 120, "ratingCount": 31, "ratingSum": 120, "avgRating": 3.87, "popularity": 410 },
  "createdAt": "...", "updatedAt": "..."
}
```

`stats` is maintained by the server and cannot be written by clients.
In **requests** the location is sent as `"location": { "lat": 43.35, "lon": 79.08 }`.

### Read — public

| Endpoint | Description |
|---|---|
| `GET /items` | catalogue listing. Query: `category` (comma list), `country`, `sort` = `popular` (default) \| `rating` \| `name` \| `newest`, `page`, `limit` |
| `GET /items/search` | search, see section 4 |
| `GET /items/popular` | top items by popularity. Query: `category`, `limit` (≤ 50) → `{ data: [...] }` |
| `GET /items/:id` | one item · **400** invalid id · **404** |

### Write — admin only

| Endpoint | Description |
|---|---|
| `POST /items` | create → **201** item. Required: `name, description, category, country, city, location, priceLevel, avgDailyCostUSD`. Optional: `tags, bestSeasons, attributes, imageUrl` |
| `PUT /items/:id` | partial update (any subset of the fields above) → **200** item |
| `DELETE /items/:id` | deletes the item **and its interactions** → `{ "deleted": true, "removedInteractions": n }` |

**401** without a token · **403** for a normal user · **409** if an item with the same name and city exists.

```bash
curl -X POST localhost:3000/api/items -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{
  "name": "Demo Yurt Camp", "description": "Overnight yurt stay in the mountains near Saty.",
  "category": "adventure", "country": "Kazakhstan", "city": "Saty",
  "location": { "lat": 42.99, "lon": 78.3 }, "tags": ["yurt-stay"], "priceLevel": 2, "avgDailyCostUSD": 90 }'
```

---

## 4. Search — `GET /items/search`  (public)

All parameters are optional and can be combined.

| Parameter | Description |
|---|---|
| `q` | free text (1–100 chars). Searches name, tags, city, country and description with weights (name ×10, tags ×5, city ×3, country ×2, description ×1). Multi-word queries match any word; results are ranked by relevance (`score`). If nothing matches, the query is treated as a **prefix** of the name or city (`alma` → *Almaty …*). |
| `category` | comma-separated list (OR) |
| `country`, `city` | exact match, case-insensitive |
| `tags` | comma-separated list, at least one must match |
| `minPrice`, `maxPrice` | `priceLevel` range, 1–4 |
| `season` | items whose `bestSeasons` contain the season |
| `minRating` | minimum average rating (0–5) |
| `lat`, `lon`, `radiusKm` | only items within the radius (default 100 km). `lat` and `lon` must be given together. Without `q`, the result is sorted by distance and every item has `distanceKm`. |
| `sort` | `relevance` (default with `q`), `rating`, `popular`, `price`, `name`, `distance` (only without `q`) |
| `page`, `limit` | pagination |

Response: pagination fields plus `mode`: `text`, `prefix`, `geo` or `filter` — it tells how the query was executed.

```bash
# free text
curl -G localhost:3000/api/items/search --data-urlencode 'q=lake mountains'
# filters
curl -G localhost:3000/api/items/search -d 'category=heritage,religious' -d 'maxPrice=2' -d 'season=autumn' -d 'minRating=3.5' -d 'sort=rating'
# nearby (Astana, 400 km)
curl -G localhost:3000/api/items/search -d 'lat=51.13' -d 'lon=71.43' -d 'radiusKm=400'
```

---

## 5. Interactions

### `POST /interactions`  — authenticated

| Field | Type | Rules |
|---|---|---|
| `itemId` | string | existing item, otherwise **404** |
| `type` | enum | `view`, `bookmark`, `visit`, `booking`, `rating` |
| `rating` | integer 1–5 | **required** for `rating`, forbidden for other types |
| `context.season` / `context.device` | optional | `spring…winter` / `web, mobile, other` |

Behaviour:

* `view`, `visit` and `booking` are **appended** to the event log.
* `bookmark` is an idempotent like: one user/place bookmark is kept, and the destination snapshot is also
  added to that user's `favoritePlaces` array in `users`. Repeated like requests do not create duplicates.
* `rating` is an **upsert**: a user has exactly one rating per item. Sending a new rating replaces the old value
  (average rating is corrected, the number of ratings does not change).
* Each interaction gets an implicit-feedback `weight` (view 1, bookmark 3, visit 4, booking 5, rating = the rating).
* Side effects include the item's `stats` counters, the user's `tasteProfile` and `recentActivity`
  (last 20 events). Removing a bookmark also removes the corresponding entry from `users.favoritePlaces`.

**201** → the stored interaction `{ _id, userId, itemId, type, weight, rating?, context?, createdAt }`.
For a bookmark, the corresponding user document also receives a `favoritePlaces` entry with the destination
snapshot and the bookmark's `interactionId`.

```bash
curl -X POST localhost:3000/api/interactions -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{ "itemId": "6aea…", "type": "rating", "rating": 5 }'
```

### Querying saved account data in MongoDB Compass

Registered profile fields are stored in each document in the `users` collection under `profile`. User-selected interests can be inspected with:

```javascript
db.users.find({}, {
  email: 1,
  "profile.fullName": 1,
  "profile.age": 1,
  "profile.city": 1,
  "profile.interests": 1
})
```

Favorites are embedded directly in each user's `favoritePlaces` array, so you can inspect the places attached to a specific account without joining collections:

```javascript
db.users.find(
  { email: "traveller@example.com" },
  { email: 1, favoritePlaces: 1 }
)
```

Each array entry contains an item reference, the bookmark interaction ID, a readable destination snapshot and the like timestamp. The interaction is also retained in `interactions` for recommendation analytics and activity history. To inspect every user's favorite places:

```javascript
db.users.find(
  { "favoritePlaces.0": { $exists: true } },
  { email: 1, favoritePlaces: 1 }
)
```

Existing records can be populated from old bookmark interactions by running `npm run backfill-favorites` with the production `MONGO_URI` and `DB_NAME` configured.

### `DELETE /interactions/:id`  — owner or admin

Only `bookmark` and `rating` can be removed (views, visits and bookings are an immutable log → **400**).
The counters are reverted. **204** · **403** for someone else's interaction · **404**.

---

## 6. Health

`GET /health` → `{ "status": "ok", "database": "up", "time": "…" }`
