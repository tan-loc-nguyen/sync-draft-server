import dotenv from 'dotenv';

// Single place that loads .env, so the banner is printed at most once (and not
// at all) regardless of module import order.
dotenv.config({ quiet: true });
