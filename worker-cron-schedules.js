/**
 * Cron schedule strings for this Worker.
 *
 * These are the single source of truth. Cloudflare sends back the exact
 * configured string in the `cf-cron-schedule` header, and the dispatcher
 * compares against these constants, so the two must never be written
 * independently.
 *
 * Note the day-of-week form: Cloudflare follows Quartz scheduler rules where
 * days of week are 1=Sunday through 7=Saturday, and 0 is not a valid value.
 * The three-letter acronym is used because it is unambiguous and cannot be
 * misread as an off-by-one week.
 */

const CRON_ALERT_ENGINE = '*/5 * * * *'; // every 5 minutes
const CRON_D1_METRICS = '*/30 * * * *'; // every 30 minutes
const CRON_PARTNER_RECONCILIATION = '0 2 * * *'; // daily 02:00 UTC
const CRON_WEEKLY_PAYOUTS = '0 0 * * SUN'; // Sunday 00:00 UTC
const CRON_T7_HOLD_RELEASE = '15 * * * *'; // hourly at :15 (T+7 maturity release)

module.exports = {
  CRON_ALERT_ENGINE,
  CRON_D1_METRICS,
  CRON_PARTNER_RECONCILIATION,
  CRON_WEEKLY_PAYOUTS,
  CRON_T7_HOLD_RELEASE,
};
