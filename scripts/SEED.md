# Database Seed Script

Populate ApexOS database with demo data for development and testing.

## Usage

1. Start wrangler dev in one terminal:
   ```bash
   wrangler dev
   ```

2. Run seed script in another terminal:
   ```bash
   pnpm seed
   # or
   tsx scripts/seed-db.ts
   ```

## What It Creates

- **Admin user** with profile and referral tree entry
- **5 demo affiliates** with profiles, affiliate codes, and referral tree relationships
- **3 demo deals** (Binance, Bybit, OKX offers)
- **Sample deal clicks** with sessions and referrers
- **Sample conversions** with approved status
- **Earnings** from conversions (direct tier 1 commissions)

## Data Schema

The script inserts into these tables:
- `users` - Better Auth users
- `profiles` - Extended profile with role/plan
- `referral_tree` - Multi-level relationships
- `affiliate_codes` - Unique referral codes
- `deals` - Affiliate offers
- `deal_clicks` - Click attribution
- `conversions` - Verified trades
- `earnings` - Commission ledger

## Cleanup

The script automatically clears previous seed data (records with:
- `email LIKE "%@test.com"`
- `customer_id LIKE "seed-%"`)
- `session_id LIKE "seed-%"`

## Notes

- Uses `globalThis.DB` binding from wrangler dev
- All timestamps use ISO format for SQLite compatibility
- Commission rate: 30% for direct referrals
- All conversions are `approved` status for immediate visibility
