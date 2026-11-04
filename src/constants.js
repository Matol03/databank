export const CATEGORIES = [
  'nature', 'mountains', 'beach', 'heritage', 'museum',
  'city', 'adventure', 'gastronomy', 'wellness', 'religious',
];
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
export const TRAVEL_STYLES = ['solo', 'couple', 'family', 'friends', 'business'];
export const INTERACTION_TYPES = ['view', 'bookmark', 'visit', 'booking', 'rating'];
export const DEVICES = ['web', 'mobile', 'other'];

// Implicit-feedback strength stored on every interaction (used later by the recommender).
export const weightOf = (type, rating) =>
  type === 'rating' ? rating : { view: 1, bookmark: 3, visit: 4, booking: 5 }[type];

// How much each interaction contributes to the item's popularity counter.
export const POPULARITY = { view: 1, bookmark: 3, visit: 4, booking: 5, rating: 2 };

// Signed contribution to the user's per-category taste profile.
// A rating of 3 is neutral; 1-2 are negative, 4-5 positive.
export const tasteSignal = (type, rating) =>
  type === 'rating' ? rating - 3 : { view: 1, bookmark: 3, visit: 4, booking: 5 }[type];
