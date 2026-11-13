# Recommendation engine

Wayfarer recommends destinations with **collaborative filtering (CF)**: a place is suggested because travellers who
behaved like you liked it, not because its description matches a keyword. The algorithms are implemented from scratch
in [`src/services/cf.js`](../src/services/cf.js) (pure functions, no database access) and connected to MongoDB in
[`src/services/recommendations.js`](../src/services/recommendations.js).

## 1. From events to preferences

The `interactions` collection is an event log. For every (user, place) pair the events are collapsed into one
preference value `p`:

| Evidence | Preference |
|---|---|
| explicit rating `r` (1–5) — wins over everything else | `r − 2` → 1★ = −1 (dislike), 2★ = 0, 3★ = 1, 4★ = 2, 5★ = 3 |
| implicit events only | `min(5, Σ weight)` with view 1, bookmark 3, visit 4, booking 5 |

Only positive preferences (`p > 0`) take part in the similarity computation.

## 2. Item-based CF (default)

Item-based CF (Sarwar et al., 2001) compares **places** with each other. Two places are similar when the same
travellers like them:

```
              Σ_u p(u,i) · p(u,j)              n_ij
sim(i, j) = ─────────────────────────── · ──────────────
            ‖p(·,i)‖ · ‖p(·,j)‖              n_ij + 10
```

* cosine similarity over the users who have a positive preference for the place;
* `n_ij` = number of users who like both places; the factor `n / (n + 10)` (significance weighting / shrinkage) lowers
  similarities that rest on very few travellers; pairs with fewer than 2 co-likers are ignored;
* only the **30 nearest neighbours** of each place are kept.

The model is **pre-computed** into the collection `item_similarities`:

```js
{ _id: <itemId>, neighbours: [ { itemId, score, common }, … ≤ 30 ], version, updatedAt }
```

A recommendation request then needs just two small reads: the user's own preferences and the neighbour lists of the
places they liked. The score of a candidate place `j` is

```
score(u, j) = Σ_{i liked by u} sim(i, j) · p(u, i)
```

The place `i` with the largest contribution is returned as the explanation ("Because you liked …"). Places the user
already interacted with are excluded.

**Model refresh.** The model is built by `npm run seed`, `npm run build-model`, `POST /api/recommendations/model/rebuild`
(admin), on the first request if it does not exist, and in the background once it is older than
`CF_MODEL_TTL_MINUTES` (default 60). New interactions of a user affect their recommendations immediately (their
preferences are read live and their cache is cleared); the similarities between places change slowly and are refreshed
with the model.

## 3. User-based CF (alternative)

User-based CF compares **travellers**. It is computed on request:

1. find the users who interacted with the places the target user liked, ranked by the number of shared places
   (aggregation on the covering index `item_user_prefs`), keep at most `CF_USER_CANDIDATES` (300) — *candidate pruning*;
2. read the full preference vectors of these candidates (covering index `user_item_prefs`);
3. cosine similarity with shrinkage `n / (n + 5)`, keep the 40 nearest travellers;
4. `score(u, j) = Σ_v sim(u, v) · p(v, j)`.

It is offered in the UI ("Similar travellers") and through `?algorithm=user`. It has no offline model, but its cost
grows with the size of the database (see [PERFORMANCE.md](PERFORMANCE.md)).

## 4. Cold start and top-up

A user without positive history (for example right after registration) gets the most popular places in the
categories they selected as interests during sign-up (`strategy: "cold-start"`). A CF list shorter than the requested
limit is topped up the same way (`strategy: "collaborative+popular"`, items marked `source: "popular"`).

## 5. Caching

| Level | Where | Scope | Invalidation |
|---|---|---|---|
| L1 | in-process LRU (5 000 entries) | one server instance | user's own interaction, new model version, TTL |
| L2 | collection `recommendation_cache` (`_id` = user + parameters) | all serverless instances | user's own interaction (`deleteMany({userId})`), new model version, TTL index on `expiresAt` |

## 6. Offline evaluation

`npm run evaluate` runs a hold-out test on the current database: for every user with at least 4 relevant places
(bookmarked, visited, booked or rated ≥ 4) 20 % of them are hidden, the models are trained on the rest and must find
the hidden places among 10 recommendations. Result on the seed database (300 synthetic travellers plus a few demo accounts, 288 test users,
545 hidden places; [`perf/evaluation.json`](perf/evaluation.json)):

| Algorithm | Precision@10 | Recall@10 | HitRate@10 | NDCG@10 | Catalogue coverage |
|---|---|---|---|---|---|
| Item-based CF | 0.102 | 0.512 | 0.674 | 0.338 | 81 % |
| User-based CF | 0.125 | 0.631 | 0.785 | 0.475 | 98 % |
| Most popular (baseline) | 0.073 | 0.363 | 0.552 | 0.206 | 50 % |
| Random (baseline) | 0.040 | 0.197 | 0.340 | 0.111 | 100 % |

Both CF variants clearly beat the baselines. User-based CF is slightly more accurate on this data set, item-based CF is
much cheaper to serve (pre-computed, cacheable) — therefore item-based is the default and user-based is an option.
The data are synthetic (generated from traveller archetypes), so the numbers show that the algorithms work, not how
real tourists would behave.
