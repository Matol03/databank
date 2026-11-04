import { toObjectId, AppError } from '../errors.js';

const HIDDEN = { nameLower: 0, countryLower: 0, cityLower: 0 };
const EARTH_RADIUS_KM = 6378.1;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Fields derived from user input; kept in the document to make equality/prefix searches index-friendly. */
export function derivedFields({ name, country, city, location }) {
  const d = {};
  if (name !== undefined) d.nameLower = name.toLowerCase();
  if (country !== undefined) d.countryLower = country.toLowerCase();
  if (city !== undefined) d.cityLower = city.toLowerCase();
  if (location !== undefined) d.location = { type: 'Point', coordinates: [location.lon, location.lat] };
  return d;
}

export function buildItemDoc(input) {
  const now = new Date();
  return {
    tags: [],
    bestSeasons: [],
    ...input,
    ...derivedFields(input),
    stats: { viewCount: 0, ratingCount: 0, ratingSum: 0, avgRating: 0, popularity: 0 },
    createdAt: now,
    updatedAt: now,
  };
}

const SORTS = {
  popular: { 'stats.popularity': -1, _id: 1 },
  rating: { 'stats.avgRating': -1, 'stats.ratingCount': -1, _id: 1 },
  price: { priceLevel: 1, 'stats.avgRating': -1, _id: 1 },
  name: { nameLower: 1 },
  newest: { createdAt: -1, _id: 1 },
};

function buildFilter(p) {
  const f = {};
  if (p.category) f.category = { $in: p.category };
  if (p.country) f.countryLower = p.country.toLowerCase();
  if (p.city) f.cityLower = p.city.toLowerCase();
  if (p.tags) f.tags = { $in: p.tags };
  if (p.minPrice !== undefined || p.maxPrice !== undefined) {
    f.priceLevel = {};
    if (p.minPrice !== undefined) f.priceLevel.$gte = p.minPrice;
    if (p.maxPrice !== undefined) f.priceLevel.$lte = p.maxPrice;
  }
  if (p.season) f.bestSeasons = p.season;
  if (p.minRating !== undefined) f['stats.avgRating'] = { $gte: p.minRating };
  return f;
}

/**
 * One entry point for catalogue listing and search.
 *   q given                  -> $text search (relevance), falls back to name/city prefix match
 *   lat/lon given, no q      -> $geoNear aggregation (distance in the result)
 *   otherwise                -> filtered, sorted listing
 */
export async function searchItems(db, p) {
  const col = db.collection('items');
  const filter = buildFilter(p);
  const skip = (p.page - 1) * p.limit;
  const hasGeo = p.lat !== undefined;
  const radiusRad = (p.radiusKm ?? 100) / EARTH_RADIUS_KM;
  const geoWithin = hasGeo
    ? { location: { $geoWithin: { $centerSphere: [[p.lon, p.lat], radiusRad] } } }
    : {};

  let mode = 'filter';
  let data;
  let total;

  if (p.q) {
    const textFilter = { ...filter, ...geoWithin, $text: { $search: p.q } };
    total = await col.countDocuments(textFilter);
    if (total > 0) {
      mode = 'text';
      const sortKey = p.sort && p.sort !== 'relevance' && SORTS[p.sort];
      const sort = sortKey || { score: { $meta: 'textScore' } };
      data = await col.find(textFilter, { projection: { ...HIDDEN, score: { $meta: 'textScore' } } })
        .sort(sort).skip(skip).limit(p.limit).toArray();
    } else {
      // partial words ("alma") do not match a text index -> prefix match on helper fields
      const prefix = new RegExp('^' + escapeRegex(p.q.toLowerCase()));
      const prefixFilter = { ...filter, ...geoWithin, $or: [{ nameLower: prefix }, { cityLower: prefix }] };
      total = await col.countDocuments(prefixFilter);
      mode = 'prefix';
      data = await col.find(prefixFilter, { projection: HIDDEN })
        .sort(SORTS[p.sort] || SORTS.popular).skip(skip).limit(p.limit).toArray();
    }
  } else if (hasGeo) {
    mode = 'geo';
    total = await col.countDocuments({ ...filter, ...geoWithin });
    const pipeline = [{
      $geoNear: {
        near: { type: 'Point', coordinates: [p.lon, p.lat] },
        distanceField: 'distanceMeters',
        maxDistance: (p.radiusKm ?? 100) * 1000,
        spherical: true,
        query: filter,
      },
    }];
    if (p.sort && p.sort !== 'distance' && SORTS[p.sort]) pipeline.push({ $sort: SORTS[p.sort] });
    pipeline.push({ $skip: skip }, { $limit: p.limit }, { $project: HIDDEN });
    data = (await col.aggregate(pipeline).toArray()).map(({ distanceMeters, ...rest }) => ({
      ...rest,
      distanceKm: Math.round(distanceMeters / 100) / 10,
    }));
  } else {
    total = await col.countDocuments(filter);
    data = await col.find(filter, { projection: HIDDEN })
      .sort(SORTS[p.sort] || SORTS.popular).skip(skip).limit(p.limit).toArray();
  }

  return {
    data,
    page: p.page,
    limit: p.limit,
    total,
    totalPages: Math.ceil(total / p.limit),
    mode,
  };
}

export async function getItem(db, id) {
  const item = await db.collection('items').findOne({ _id: toObjectId(id, 'item id') }, { projection: HIDDEN });
  if (!item) throw new AppError(404, 'Item not found', 'NotFound');
  return item;
}

export async function popularItems(db, { category, limit }) {
  const filter = category ? { category: { $in: category } } : {};
  return db.collection('items').find(filter, { projection: HIDDEN })
    .sort({ 'stats.popularity': -1, _id: 1 }).limit(limit).toArray();
}
