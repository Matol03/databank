/**
 * Seeds the database with synthetic (non-personal) test data (drops and recreates the collections).
 *   npm run seed                       -> 64 destinations, 300 users, ~18k interactions
 *   node scripts/seed.js --users=2000  -> bigger data set for performance tests
 * The script is deterministic (--seed=42) so results are reproducible.
 */
import { config } from '../src/config.js';
import { connect, close } from '../src/db.js';
import { seedDatabase } from '../src/services/seed.js';

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : def;
};
const users = arg('users', 300);

const db = await connect(config.mongoUri, config.dbName);
console.log(`Seeding database "${config.dbName}" ...`);
await seedDatabase(db, { users, seed: arg('seed', 42), log: console.log });
console.log('\nTest accounts:');
console.log('  admin  admin@tourism.local   / Admin12345!');
console.log('  user   demo@tourism.local    / Demo12345!');
console.log('  user   traveller1@example.com ... traveller' + users + '@example.com / Password123!');
await close();
