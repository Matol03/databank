# Wayfarer dataset structure and inspection guide

This guide describes the MongoDB data used by Wayfarer, where it lives, how the application writes it, and how to inspect it with MongoDB Atlas, MongoDB Compass, the REST API, or the local inspection script.

Related references:
- [API reference](API.md)
- [Frontend guide](FRONTEND.md)
- [Destination source dataset](../data/destinations.json)
- Database schema, validation, and indexes: `src/schemas.js`, `src/db.js`, `src/constants.js`

---

## 1. Where the data lives

Wayfarer uses MongoDB as its persistent datastore. Vercel hosts the web application and API; it is not the database.

The application selects its MongoDB database using the `DB_NAME` environment variable. The default and expected database name for this project is:

```text
tourism_recsys
```

The MongoDB Atlas connection is configured through `MONGO_URI`. These are server-side environment variables; do not put their values in frontend code, documentation, screenshots, or chat messages.

### Open the production database in MongoDB Atlas

1. Sign in to [MongoDB Atlas](https://cloud.mongodb.com/).
2. Select the Atlas project that contains the cluster used by the Wayfarer deployment.
3. Open **Database** (or **Clusters**, depending on the Atlas UI version).
4. Find the cluster and click **Browse Collections**.
5. Open the `tourism_recsys` database.
6. Inspect the collections described below.

For the live site, the application is deployed at [databank-tawny.vercel.app](https://databank-tawny.vercel.app). The public health endpoint is [`/api/health`](https://databank-tawny.vercel.app/api/health). It reports the connected database name and document counts for `items`, `users`, and `interactions`; it does not expose individual user records.

### Open the same database in MongoDB Compass

1. In Atlas, open the cluster's **Connect** dialog and choose **Compass** (or copy the connection string).
2. Open MongoDB Compass and connect to that cluster.
3. Expand the `tourism_recsys` database.
4. Select `users`, `items`, or `interactions`, then use the **Documents**, **Aggregations**, and **Indexes** tabs.

Use the connection string privately. Do not commit it to Git or share it. A database user should have only the permissions required for the work being performed.

---

## 2. Collection overview

The main collections are:

| Collection | What it contains | Typical use |
|---|---|---|
| `users` | Accounts, registration profile, declared interests, derived taste profile, recent activity | User segmentation and personalisation |
| `items` | Destination catalogue and aggregate popularity/rating statistics | Search, destination details, catalogue analytics |
| `interactions` | User events: views, bookmarks (likes/saves), visits, bookings, ratings | Behaviour analysis and recommendation model training |
| `meta` | Optional automatic-seeding state/lock document | Operational status when `AUTO_SEED` is enabled |

The three main collections are connected by MongoDB ObjectIds:

```text
users._id ───────────────┐
                         │ interactions.userId
items._id ───────────────┴─ interactions.itemId
```

An interaction is an event linking one user to one destination. The database is document-oriented: these references are not relational SQL foreign keys, but the application uses them to join records.

---

## 3. User records — `users`

A user document is created when someone registers. The registration form collects a full name, age, home city, email, password, and optional travel-interest categories.

Example shape (illustrative values):

```javascript
{
  _id: ObjectId("..."),
  email: "aigul@example.com",
  passwordHash: "<bcrypt password hash>",
  role: "user",
  profile: {
    fullName: "Aigul Sadykova",
    age: 27,
    city: "Astana",
    country: "Kazakhstan",
    interests: ["mountains", "heritage"],
    preferredSeasons: ["spring", "autumn"],
    travelStyle: "solo",
    budgetLevel: 2
  },
  tasteProfile: {
    mountains: 6,
    heritage: 3
  },
  recentActivity: [
    {
      itemId: ObjectId("..."),
      type: "bookmark",
      at: ISODate("2026-11-06T11:00:00.000Z")
    }
  ],
  createdAt: ISODate("2026-11-06T10:00:00.000Z"),
  lastLoginAt: ISODate("2026-11-06T11:30:00.000Z")
}
```

### User fields

| Field | Meaning |
|---|---|
| `_id` | MongoDB-generated user identifier |
| `email` | Normalised to lowercase; unique |
| `passwordHash` | bcrypt password hash; the original password is never stored |
| `role` | `user` or `admin` |
| `profile.fullName` | User's full name; required for new registrations |
| `profile.age` | Integer from 13 to 120; required for new registrations |
| `profile.city` | User's home/residential city; required for new registrations |
| `profile.country` | Optional profile country |
| `profile.interests` | Explicit categories the user selected during registration or profile editing |
| `profile.preferredSeasons` | Optional preferred travel seasons |
| `profile.travelStyle` | Optional style: `solo`, `couple`, `family`, `friends`, or `business` |
| `profile.budgetLevel` | Optional budget level: 1 (budget) through 4 (luxury) |
| `profile.bio` | Optional biography |
| `tasteProfile` | Derived category scores calculated from the user's interaction history |
| `recentActivity` | Small denormalised list of the latest 20 events |
| `createdAt`, `lastLoginAt` | Account creation and most recent login timestamps |

The profile schema is defined in `src/schemas.js`; registration is handled in `src/routes/auth.js`.

### Declared interests vs. behavioural interests

These fields represent different kinds of information:

- **`profile.interests`** contains the categories the user explicitly selected. For example, `["mountains", "heritage"]`.
- **`tasteProfile`** is calculated from observed events. Views, bookmarks, visits, bookings, and ratings change a numeric score for the category of the destination involved.

Do not treat them as interchangeable. `profile.interests` represents stated preferences; `tasteProfile` represents behaviour-based implicit feedback.

A user's home city (`profile.city`) is also different from the destination city in `items.city` or an interaction's `destinationSnapshot.city`.

### Compatibility note for existing accounts

The current registration form requires full name, age, and home city for new users. Existing user documents are not automatically rewritten when the application is deployed. Older accounts and synthetic seed accounts may therefore have missing fields (for example, the seeded administrator does not have an age or home city). Missing fields do not imply a failed database write.

---

## 4. Destination records — `items`

The `items` collection is the destination catalogue. The source file for the catalogue is `data/destinations.json`; the seed service turns those records into MongoDB documents.

Example shape:

```javascript
{
  _id: ObjectId("..."),
  name: "Charyn Canyon",
  description: "A red-rock canyon in southeastern Kazakhstan.",
  category: "nature",
  country: "Kazakhstan",
  city: "Charyn",
  location: {
    type: "Point",
    coordinates: [79.08, 43.35]
  },
  tags: ["canyon", "hiking"],
  priceLevel: 1,
  avgDailyCostUSD: 50,
  bestSeasons: ["spring", "autumn"],
  attributes: {
    recommendedDays: 2,
    familyFriendly: true,
    outdoor: true
  },
  stats: {
    viewCount: 120,
    ratingCount: 31,
    ratingSum: 120,
    avgRating: 3.87,
    popularity: 410
  },
  nameLower: "charyn canyon",
  countryLower: "kazakhstan",
  cityLower: "charyn",
  createdAt: ISODate("2026-01-01T00:00:00.000Z"),
  updatedAt: ISODate("2026-01-01T00:00:00.000Z")
}
```

### Destination fields

| Field | Meaning |
|---|---|
| `name`, `description` | Destination title and description |
| `category` | Main category: `nature`, `mountains`, `beach`, `heritage`, `museum`, `city`, `adventure`, `gastronomy`, `wellness`, or `religious` |
| `country`, `city` | Destination location labels |
| `location` | GeoJSON point. Coordinates are ordered **[longitude, latitude]** |
| `tags` | Searchable descriptive tags |
| `priceLevel` | Integer 1–4 |
| `avgDailyCostUSD` | Approximate daily cost in USD |
| `bestSeasons` | Array of seasons: `spring`, `summer`, `autumn`, `winter` |
| `attributes` | Optional trip attributes such as recommended days, family friendliness, and outdoor status |
| `imageUrl` | Optional destination image URL |
| `stats` | Server-maintained interaction and rating aggregates |
| `nameLower`, `countryLower`, `cityLower` | Lowercase helper fields for case-insensitive and prefix searches |
| `createdAt`, `updatedAt` | Record timestamps |

### Meaning of `stats`

| Field | Meaning |
|---|---|
| `viewCount` | Number of recorded view events |
| `ratingCount` | Number of current rating records for the destination |
| `ratingSum` | Sum of current ratings |
| `avgRating` | `ratingSum / ratingCount`, rounded to two decimals; zero when there are no ratings |
| `popularity` | Weighted popularity score from interaction types |

These fields are maintained by the backend; clients cannot write them directly. They can be rebuilt from the interaction log with `npm run recompute`.

---

## 5. User events — `interactions`

The `interactions` collection is the detailed behavioural event log. Each document normally references one user and one destination.

Supported values of `type`:

| Type | Meaning | Weight used for implicit feedback |
|---|---|---:|
| `view` | User viewed a destination | 1 |
| `bookmark` | User liked/saved a destination | 3 |
| `visit` | User marked a destination as visited | 4 |
| `booking` | Booking-related event | 5 |
| `rating` | User submitted a 1–5 rating | The rating value |

Example bookmark (like/save):

```javascript
{
  _id: ObjectId("..."),
  userId: ObjectId("..."),
  itemId: ObjectId("..."),
  type: "bookmark",
  weight: 3,
  destinationSnapshot: {
    name: "Charyn Canyon",
    city: "Charyn",
    country: "Kazakhstan",
    category: "nature"
  },
  context: {
    season: "autumn",
    device: "web"
  },
  createdAt: ISODate("2026-11-06T11:00:00.000Z")
}
```

Example rating:

```javascript
{
  _id: ObjectId("..."),
  userId: ObjectId("..."),
  itemId: ObjectId("..."),
  type: "rating",
  rating: 5,
  weight: 5,
  context: {
    season: "summer",
    device: "mobile"
  },
  createdAt: ISODate("2026-11-06T11:05:00.000Z"),
  updatedAt: ISODate("2026-11-06T11:10:00.000Z")
}
```

### Important interaction behaviour

- **Views, bookmarks, visits, and bookings are appended** as event records.
- **Ratings are upserted**: a user has one current rating per destination. Submitting a new rating updates that record instead of adding another current rating.
- The database has a partial unique index on `(userId, itemId)` for records whose `type` is `rating`.
- `context.season` and `context.device` are optional.
- Each event has a `weight`, a timestamp, and references to the user and destination.
- New bookmark events created through the application also contain `destinationSnapshot`: the destination's name, city, country, and category at the time of the like.

### Why a bookmark stores a destination snapshot

The snapshot makes the city and category of a newly liked destination directly available on the bookmark document. It also preserves the destination details as they were when the user liked it.

**Historical-data caveat:** older bookmarks and synthetic bookmark events written directly by the seed script may not contain `destinationSnapshot`. For those records, join `interactions.itemId` to `items._id` to retrieve the destination city and category. The examples below do this fallback lookup.

### How interactions update other documents

When an event is recorded, the backend also updates denormalised summaries:

1. `items.stats` is updated for the destination.
2. `users.tasteProfile` receives a category signal.
3. `users.recentActivity` receives a compact event entry; it is limited to the latest 20 events.

The full interaction history is in `interactions`; `recentActivity` is not a substitute for it.

The category signal is positive for views, bookmarks, visits, and bookings. A rating contributes `rating - 3`: ratings 1–2 reduce the category score, 3 is neutral, and 4–5 increase it.

---

## 6. Optional operational collection — `meta`

When `AUTO_SEED` is enabled, the seed service uses a document in `meta` to coordinate automatic demo-data loading. The marker uses `_id: "seed"` and may contain:

- `status`: `running`, `failed`, or `done`
- `startedAt`, `finishedAt`, `lockedUntil`
- `result`: number of seeded items, users, and interactions
- `error`: a short error message if seeding failed

This is operational metadata, not user behaviour or destination content.

---

## 7. Inspect data in Atlas or Compass

In the MongoDB Atlas **Browse Collections** view or the MongoDB Compass **Documents** tab, select a collection and use the filter bar.

### A. Inspect user profiles

All user profiles, excluding password hashes:

```javascript
db.users.find(
  {},
  {
    email: 1,
    role: 1,
    "profile.fullName": 1,
    "profile.age": 1,
    "profile.city": 1,
    "profile.country": 1,
    "profile.interests": 1,
    createdAt: 1
  }
)
```

Find one user by email:

```javascript
db.users.findOne(
  { email: "aigul@example.com" },
  {
    email: 1,
    "profile.fullName": 1,
    "profile.age": 1,
    "profile.city": 1,
    "profile.interests": 1,
    tasteProfile: 1,
    recentActivity: 1
  }
)
```

Find older records without a home city:

```javascript
db.users.find(
  { "profile.city": { $exists: false } },
  { email: 1, role: 1, "profile.fullName": 1 }
)
```

Count users by explicitly selected interest:

```javascript
db.users.aggregate([
  { $unwind: "$profile.interests" },
  {
    $group: {
      _id: "$profile.interests",
      users: { $sum: 1 }
    }
  },
  { $sort: { users: -1 } }
])
```

### B. Inspect destinations

Find destinations in a city:

```javascript
db.items.find(
  { city: "Almaty" },
  { name: 1, city: 1, country: 1, category: 1, stats: 1 }
)
```

Inspect the most popular destinations:

```javascript
db.items.find(
  {},
  { name: 1, city: 1, country: 1, category: 1, stats: 1 }
).sort({ "stats.popularity": -1 }).limit(20)
```

### C. Inspect likes/bookmarks

List the latest bookmarks:

```javascript
db.interactions.find(
  { type: "bookmark" },
  { userId: 1, itemId: 1, destinationSnapshot: 1, createdAt: 1 }
).sort({ createdAt: -1 }).limit(50)
```

To inspect bookmarks for one user, first obtain that user's `_id` from `users`, then use it as an ObjectId:

```javascript
db.interactions.find(
  {
    userId: ObjectId("PUT_USER_OBJECT_ID_HERE"),
    type: "bookmark"
  },
  {
    itemId: 1,
    destinationSnapshot: 1,
    createdAt: 1
  }
).sort({ createdAt: -1 })
```

### D. Get the cities a particular user has liked

This aggregation handles both new bookmarks (which have a snapshot) and historical/seeded bookmarks (which may not). It joins the destination catalogue as a fallback.

```javascript
db.interactions.aggregate([
  {
    $match: {
      userId: ObjectId("PUT_USER_OBJECT_ID_HERE"),
      type: "bookmark"
    }
  },
  {
    $lookup: {
      from: "items",
      localField: "itemId",
      foreignField: "_id",
      as: "destination"
    }
  },
  { $set: { destination: { $first: "$destination" } } },
  {
    $project: {
      name: { $ifNull: ["$destinationSnapshot.name", "$destination.name"] },
      city: { $ifNull: ["$destinationSnapshot.city", "$destination.city"] },
      country: { $ifNull: ["$destinationSnapshot.country", "$destination.country"] },
      category: { $ifNull: ["$destinationSnapshot.category", "$destination.category"] },
      createdAt: 1
    }
  },
  {
    $group: {
      _id: { city: "$city", country: "$country" },
      likes: { $sum: 1 },
      destinations: { $addToSet: "$name" }
    }
  },
  { $sort: { likes: -1 } }
])
```

### E. Find the most-liked cities across all users

```javascript
db.interactions.aggregate([
  { $match: { type: "bookmark" } },
  {
    $lookup: {
      from: "items",
      localField: "itemId",
      foreignField: "_id",
      as: "destination"
    }
  },
  { $set: { destination: { $first: "$destination" } } },
  {
    $project: {
      userId: 1,
      city: { $ifNull: ["$destinationSnapshot.city", "$destination.city"] },
      country: { $ifNull: ["$destinationSnapshot.country", "$destination.country"] },
      name: { $ifNull: ["$destinationSnapshot.name", "$destination.name"] }
    }
  },
  {
    $group: {
      _id: { city: "$city", country: "$country" },
      likes: { $sum: 1 },
      users: { $addToSet: "$userId" },
      destinations: { $addToSet: "$name" }
    }
  },
  {
    $set: { uniqueUsers: { $size: "$users" } }
  },
  { $project: { users: 0 } },
  { $sort: { likes: -1 } }
])
```

Here, **likes** counts bookmark events, while **uniqueUsers** counts distinct users who bookmarked a destination in that city.

### F. Inspect the full interaction mix

```javascript
db.interactions.aggregate([
  { $group: { _id: "$type", events: { $sum: 1 } } },
  { $sort: { events: -1 } }
])
```

---

## 8. Inspect data through the REST API

The API is useful when you want to inspect data as the application sees it.

### Health and collection counts (public)

```bash
curl https://databank-tawny.vercel.app/api/health
```

The response includes the database name and counts for `items`, `users`, and `interactions`.

### Get the authenticated user's profile

First log in and retain the returned JWT securely:

```bash
curl -X POST https://databank-tawny.vercel.app/api/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"email":"YOUR_EMAIL","password":"YOUR_PASSWORD"}'
```

Then use the token:

```bash
curl https://databank-tawny.vercel.app/api/users/me \\
  -H "Authorization: Bearer YOUR_JWT"
```

### Get the user's saved places and bookmark history

```bash
curl "https://databank-tawny.vercel.app/api/users/me/history?type=bookmark&limit=50" \\
  -H "Authorization: Bearer YOUR_JWT"
```

The response joins each interaction to basic destination data under `item`. New bookmarks also include `destinationSnapshot`. This API returns only the authenticated user's history.

Other useful endpoints are documented in [API.md](API.md), including profile updates, search, and ratings.

---

## 9. Local inspection utilities

When running the repository locally with a valid `.env` connection to the intended database:

```bash
npm install
npm run inspect-db
```

The `inspect-db` script prints:
- counts and approximate data sizes for `users`, `items`, and `interactions`;
- indexes on those collections;
- a sample destination, a sample user (with `passwordHash` excluded), and a sample interaction.

It does not print every document. It also does not list the optional `meta` collection.

Other database scripts:

| Command | Effect |
|---|---|
| `npm run indexes` | Creates indexes; does not intentionally change documents |
| `npm run recompute` | Rebuilds destination statistics, user taste profiles, and recent activity from `interactions` |
| `npm run seed` | **Destructive:** drops and recreates `users`, `items`, and `interactions` with synthetic demo data |

**Do not run `npm run seed` against the production database unless you intentionally want to delete and replace its user, destination, and interaction data.** Take a backup before any destructive database operation.

---

## 10. Seed data vs. real application data

The repository includes synthetic data for demos and development:

- `data/destinations.json` supplies the destination catalogue (64 destinations in the current source data).
- `npm run seed` creates the catalogue, a demo account, an administrator, and synthetic traveller accounts and events.
- Vercel's optional `AUTO_SEED` mode can populate an empty database with demo data. Its default synthetic-user count is controlled by `AUTO_SEED_USERS`.

Seed-generated accounts and interactions are test data, not real customer behaviour. Newly registered accounts and interactions created through the live application are application-collected data.

The seed process writes interaction documents directly. Therefore seed-generated bookmarks may not have `destinationSnapshot`; use the aggregation in section 7D or 7E to fall back to the related `items` document.

---

## 11. Data quality, interpretation, and privacy

1. **Home city vs. liked city:** `users.profile.city` is where the user says they live. `destinationSnapshot.city` (or the joined `items.city` for older records) is the city of a destination they liked.
2. **Declared vs. inferred interests:** `profile.interests` is self-reported. `tasteProfile` is calculated from the event log and may change as the user interacts with destinations.
3. **Full log vs. recent summary:** `interactions` is the detailed event log. `users.recentActivity` stores only the latest 20 events.
4. **Ratings vs. repeated actions:** ratings are one current record per user and destination; views, bookmarks, visits, and bookings are appended events.
5. **Historical records:** older users may not have all new profile fields. Older or synthetic bookmarks may not have a destination snapshot.
6. **Sensitive fields:** age, full name, home city, email, and password hashes are personal or security-sensitive data. Restrict database access, avoid exporting real user documents unnecessarily, and never publish `passwordHash`, JWTs, passwords, or MongoDB connection strings.

For schema validation and index definitions, consult `src/schemas.js` and `src/db.js`. For event weights and category-score rules, consult `src/constants.js` and `src/services/interactions.js`.
