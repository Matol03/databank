# Wayfarer frontend

A responsive, dependency-free travel-discovery interface for the tourism recommendation API.

## Run locally

```bash
npm install
cp .env.example .env
docker compose up -d
npm run seed
npm start
```

Open http://localhost:3000/. The REST API remains available under `/api`; see [API.md](./API.md).

## Features

- Destination discovery with full-text and prefix search.
- Filters for country, category, season, and price level.
- Sorting by popularity, rating, estimated daily cost, or name.
- Nearby search using browser geolocation (requires permission and HTTPS or localhost).
- Destination detail views with tags, recommended stay, season, estimated daily cost, and a map link when coordinates exist.
- Registration and sign-in using the existing JWT API.
- Saved places, ratings, and visit tracking using the interactions API.
- Responsive layout, accessible controls, and loading/error states.

## Implementation notes

The frontend is in `public/` and is served by Express from the same origin as the API. It uses plain HTML, CSS, and JavaScript; no frontend build step or additional npm dependency is required.

Destination records may not contain `imageUrl`. In that case, the UI uses category-based illustrative photography as a visual fallback. These images are not necessarily photographs of the exact destination. When an admin adds a valid HTTPS `imageUrl`, it is used instead.

Static files are served before the API's MongoDB initialization middleware. This allows the website shell and assets to load even when the database is unavailable; data-dependent API requests still require a working MongoDB connection.
