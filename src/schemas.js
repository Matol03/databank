import { z } from 'zod';
import { CATEGORIES, SEASONS, TRAVEL_STYLES, INTERACTION_TYPES, DEVICES } from './constants.js';

const unique = (arr) => [...new Set(arr)];

/* ---------- users ---------- */
const profileShape = {
  fullName: z.string().trim().min(2).max(100),
  age: z.number().int().min(13).max(120),
  country: z.string().trim().min(2).max(60),
  travelStyle: z.enum(TRAVEL_STYLES),
  budgetLevel: z.number().int().min(1).max(4),
  interests: z.array(z.enum(CATEGORIES)).max(10).transform(unique),
  preferredSeasons: z.array(z.enum(SEASONS)).max(4).transform(unique),
  bio: z.string().trim().max(500),
};

export const profileUpdateSchema = z
  .object(profileShape).partial().strict()
  .refine((o) => Object.keys(o).length > 0, 'At least one profile field is required');

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().min(8).max(72)
    .regex(/[A-Za-z]/, 'Password must contain a letter')
    .regex(/\d/, 'Password must contain a digit'),
  profile: z.object(profileShape).partial().required({ fullName: true }).strict(),
}).strict();

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase(),
  password: z.string().min(1).max(72),
}).strict();

/* ---------- items ---------- */
const itemShape = {
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().min(10).max(2000),
  category: z.enum(CATEGORIES),
  country: z.string().trim().min(2).max(60),
  city: z.string().trim().min(2).max(80),
  location: z.object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
  }).strict(),
  tags: z.array(z.string().trim().toLowerCase().min(2).max(30)).max(15).transform(unique),
  priceLevel: z.number().int().min(1).max(4),
  avgDailyCostUSD: z.number().min(0).max(100000),
  bestSeasons: z.array(z.enum(SEASONS)).max(4).transform(unique),
  attributes: z.object({
    recommendedDays: z.number().int().min(1).max(30),
    familyFriendly: z.boolean(),
    outdoor: z.boolean(),
  }).partial().strict(),
  imageUrl: z.url().max(500),
};

// "tags", "bestSeasons", "attributes" and "imageUrl" are optional on creation
export const createItemSchema = z.object(itemShape)
  .partial({ tags: true, bestSeasons: true, attributes: true, imageUrl: true }).strict();

export const updateItemSchema = z.object(itemShape).partial().strict()
  .refine((o) => Object.keys(o).length > 0, 'At least one field is required');

/* ---------- queries ---------- */
const page = z.coerce.number().int().min(1).default(1);
const limit = z.coerce.number().int().min(1).max(50).default(10);
const csv = (inner) =>
  z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).pipe(z.array(inner).min(1).max(20));

export const listSchema = z.object({
  category: csv(z.enum(CATEGORIES)).optional(),
  country: z.string().trim().min(1).max(60).optional(),
  sort: z.enum(['popular', 'rating', 'name', 'newest']).default('popular'),
  page, limit,
});

export const searchSchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  category: csv(z.enum(CATEGORIES)).optional(),
  country: z.string().trim().min(1).max(60).optional(),
  city: z.string().trim().min(1).max(80).optional(),
  tags: csv(z.string().trim().toLowerCase().min(2).max(30)).optional(),
  minPrice: z.coerce.number().int().min(1).max(4).optional(),
  maxPrice: z.coerce.number().int().min(1).max(4).optional(),
  season: z.enum(SEASONS).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(1).max(20000).default(100),
  sort: z.enum(['relevance', 'rating', 'popular', 'price', 'name', 'distance']).optional(),
  page, limit,
}).refine((o) => (o.lat === undefined) === (o.lon === undefined), 'lat and lon must be given together')
  .refine((o) => o.minPrice === undefined || o.maxPrice === undefined || o.minPrice <= o.maxPrice,
    'minPrice must not exceed maxPrice');

export const popularSchema = z.object({
  category: csv(z.enum(CATEGORIES)).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const historySchema = z.object({
  type: z.enum(INTERACTION_TYPES).optional(),
  page, limit,
});

/* ---------- interactions ---------- */
export const interactionSchema = z.object({
  itemId: z.string(),
  type: z.enum(INTERACTION_TYPES),
  rating: z.number().int().min(1).max(5).optional(),
  context: z.object({
    season: z.enum(SEASONS).optional(),
    device: z.enum(DEVICES).optional(),
  }).strict().optional(),
}).strict().superRefine((o, ctx) => {
  if (o.type === 'rating' && o.rating === undefined) {
    ctx.addIssue({ code: 'custom', path: ['rating'], message: 'rating (1-5) is required for type "rating"' });
  }
  if (o.type !== 'rating' && o.rating !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['rating'], message: 'rating is only allowed for type "rating"' });
  }
});
