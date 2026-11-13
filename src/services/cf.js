/**
 * Pure collaborative-filtering algorithms (no database access), so the same code is used by the
 * API, the offline evaluation (scripts/evaluate.js) and the unit tests.
 *
 * Input everywhere: "preference triples" { u, i, p } = user key, item key, preference strength (> 0).
 *
 * Preference of a user for an item (implicit + explicit feedback, see preferenceOf):
 *   - an explicit rating r wins:  p = r - 2           (1 -> -1, 2 -> 0, 3 -> 1, 4 -> 2, 5 -> 3)
 *   - otherwise implicit weights:  p = min(5, sum of weights)   (view 1, bookmark 3, visit 4, booking 5)
 * Only pairs with p > 0 take part in the similarity computation (a 1-star rating is a dislike).
 */

/** Collapses raw interaction events of ONE (user, item) pair into a single preference value. */
export function preferenceOf(events) {
  let implicit = 0;
  let rating = null;
  for (const e of events) {
    if (e.type === 'rating') rating = e.weight ?? e.rating;
    else implicit += e.weight;
  }
  if (rating !== null) return rating - 2;
  return Math.min(5, implicit);
}

/** Groups raw events {userId, itemId, type, weight} into preference triples. */
export function toPreferences(events) {
  const byPair = new Map();
  for (const e of events) {
    const key = `${e.userId}|${e.itemId}`;
    let entry = byPair.get(key);
    if (!entry) byPair.set(key, (entry = { u: String(e.userId), i: String(e.itemId), events: [] }));
    entry.events.push(e);
  }
  return [...byPair.values()].map(({ u, i, events: ev }) => ({ u, i, p: preferenceOf(ev) }));
}

const groupBy = (prefs, key) => {
  const m = new Map();
  for (const x of prefs) {
    if (x.p <= 0) continue;
    let v = m.get(x[key]);
    if (!v) m.set(x[key], (v = new Map()));
    v.set(key === 'u' ? x.i : x.u, x.p);
  }
  return m;
};

/**
 * Item-based CF model (Sarwar et al., 2001): cosine similarity between item vectors over users,
 * damped by a significance weight n / (n + shrink) so that pairs seen by very few users count less.
 * Returns Map(item -> [{ i, s, n }]) with the top `k` neighbours of every item, best first.
 */
export function buildItemModel(prefs, { k = 30, shrink = 10, minCommon = 2 } = {}) {
  const byUser = groupBy(prefs, 'u');
  const norm = new Map();
  const dot = new Map(); // "a|b" (a < b) -> [sum of products, co-raters]
  for (const items of byUser.values()) {
    const list = [...items];
    for (const [i, p] of list) norm.set(i, (norm.get(i) || 0) + p * p);
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const [i, pi] = list[a];
        const [j, pj] = list[b];
        const key = i < j ? `${i}|${j}` : `${j}|${i}`;
        const acc = dot.get(key);
        if (acc) { acc[0] += pi * pj; acc[1] += 1; } else dot.set(key, [pi * pj, 1]);
      }
    }
  }
  const neighbours = new Map();
  const add = (from, to, s, n) => {
    let arr = neighbours.get(from);
    if (!arr) neighbours.set(from, (arr = []));
    arr.push({ i: to, s, n });
  };
  for (const [key, [d, n]] of dot) {
    if (n < minCommon) continue;
    const [i, j] = key.split('|');
    const s = (d / Math.sqrt(norm.get(i) * norm.get(j))) * (n / (n + shrink));
    if (s <= 0) continue;
    add(i, j, s, n);
    add(j, i, s, n);
  }
  for (const [i, arr] of neighbours) {
    arr.sort((x, y) => y.s - x.s);
    neighbours.set(i, arr.slice(0, k));
  }
  return neighbours;
}

/**
 * Scores candidate items for one user with an item-based model.
 *   score(j) = sum over items i the user liked of sim(i, j) * p(u, i)
 * The item that contributed most is kept as the explanation ("because you liked ...").
 * userPrefs: Map(item -> p).  getNeighbours(i) -> [{ i, s }].
 */
export function scoreItemBased(userPrefs, getNeighbours, { limit = 10, exclude = new Set() } = {}) {
  const scores = new Map();
  for (const [i, p] of userPrefs) {
    if (p <= 0) continue;
    for (const nb of getNeighbours(i) || []) {
      if (userPrefs.has(nb.i) || exclude.has(nb.i)) continue;
      const contribution = nb.s * p;
      let e = scores.get(nb.i);
      if (!e) scores.set(nb.i, (e = { i: nb.i, score: 0, because: [] }));
      e.score += contribution;
      e.because.push({ i, c: contribution });
    }
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => ({ i: e.i, score: e.score, because: e.because.sort((a, b) => b.c - a.c).slice(0, 2).map((x) => x.i) }));
}

/**
 * User-based CF (computed on request): cosine similarity between the target user and every user who
 * shares at least one positively rated item, top `k` neighbours, then
 *   score(j) = sum over neighbours v of sim(u, v) * p(v, j)
 * candidatePrefs: preference triples of the users who interacted with the target user's items.
 */
export function scoreUserBased(userKey, userPrefs, candidatePrefs, { k = 40, shrink = 5, limit = 10, exclude = new Set() } = {}) {
  const byUser = groupBy(candidatePrefs, 'u');
  byUser.delete(userKey);
  let normU = 0;
  for (const p of userPrefs.values()) if (p > 0) normU += p * p;
  if (!normU) return [];
  const sims = [];
  for (const [v, items] of byUser) {
    let d = 0;
    let n = 0;
    let normV = 0;
    for (const [i, p] of items) {
      normV += p * p;
      const pu = userPrefs.get(i);
      if (pu > 0) { d += pu * p; n += 1; }
    }
    if (!n) continue;
    sims.push({ v, s: (d / Math.sqrt(normU * normV)) * (n / (n + shrink)), items });
  }
  sims.sort((a, b) => b.s - a.s);
  const scores = new Map();
  for (const { s, items } of sims.slice(0, k)) {
    for (const [j, p] of items) {
      if (userPrefs.has(j) || exclude.has(j)) continue;
      let e = scores.get(j);
      if (!e) scores.set(j, (e = { i: j, score: 0, neighbours: 0 }));
      e.score += s * p;
      e.neighbours += 1;
    }
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
