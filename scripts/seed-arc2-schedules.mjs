import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '..', 'store', 'messages.db'));

const TZ = 'UTC';
const now = new Date().toISOString();

const FOC_INBOX_GATE = `#!/bin/bash
set -u
resp=$(curl -sG "https://api.airtable.com/v0/\${AIRTABLE_BASE}/\${AIRTABLE_FOC_QUEUE_TABLE}" \\
  -H "Authorization: Bearer \${AIRTABLE_TOKEN}" \\
  --data-urlencode "filterByFormula={Status}='Pending'" \\
  --data-urlencode "fields[]=Distributor" \\
  --data-urlencode "pageSize=10" 2>/dev/null)
count=$(echo "$resp" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log((j.records||[]).length)}catch{console.log(0)}})")
if [ "$count" -gt 0 ]; then
  echo "{\\"wakeAgent\\":true,\\"data\\":{\\"pendingCount\\":\${count}}}"
else
  echo '{"wakeAgent":false}'
fi
`;

const WATCHER_HOURLY_GATE = `#!/bin/bash
set -u
resp=$(curl -sG "https://api.airtable.com/v0/\${AIRTABLE_BASE}/\${AIRTABLE_INV_TABLE}" \\
  -H "Authorization: Bearer \${AIRTABLE_TOKEN}" \\
  --data-urlencode "filterByFormula=AND({Sale Date}, IS_AFTER({Sale Date}, DATEADD(NOW(),-65,'minutes')))" \\
  --data-urlencode "fields[]=SKU" \\
  --data-urlencode "maxRecords=1" 2>/dev/null)
count=$(echo "$resp" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log((j.records||[]).length)}catch{console.log(0)}})")
if [ "$count" = "1" ]; then
  echo '{"wakeAgent":true,"data":{"hasNewSales":true}}'
else
  echo '{"wakeAgent":false}'
fi
`;

const TASKMASTER_SALES_SYNC_PROMPT = `Autonomous 30-min store pulse. You operate 24/7 toward your north star: every item priced right, listed well, and moving. No human triggers this; no ack needed.

1. eBay sales sync: query Trading API for sold orders in the last ~35 min. For each sold order, match to AIRTABLE_INV_TABLE by Series + Issue + Variant (and SKU when eBay exposes it) via filterByFormula. On match: PATCH Status=Sold, Sale Date, Sale Price, Sale Platform=eBay. On no match: POST a new inventory row with what eBay knows, flagged for reconciliation.
2. For each sale, POST a sale notification to DISCORD_WEBHOOK_INVENTORY.
3. Append a line to /workspace/group/actions.md for every PATCH/POST (Watcher and Oracle read this file).
4. Before deciding prices, read /workspace/extra/oracle/signals.md — if Oracle has flagged a title as BUY and you hold copies, prioritize listing / reprice aggressively toward the lower end of your market-price range.
5. Log every pricing call to recommendations.md with confidence score. Your ledger accuracy is how you earn full store autonomy — never hide misses.

Push back in AIRTABLE_REC_TABLE.Agent 2 Market Data on any live Oracle call that contradicts today's comp data.`;

const TASKMASTER_STORE_AUDIT_PROMPT = `Autonomous hourly store audit. You execute end-to-end; no human triggers or acks this.

Two sweeps in one run:

A. Stale listing audit — pull all active ARC2 listings via Trading API GetMyeBaySelling. For each listing:
   - Age: days since ListingStartTime
   - Views, watchers, add-to-cart counts
   Flag anything crossing Loss Protocol thresholds:
   - 30 days, <5 views → flag in Discord with context (market shift? bad photos? wrong title?)
   - 45 days → post a specific 15% reduction recommendation with break-even math and comp evidence
   - 60 days → post the liquidation-price math honestly. Dead inventory is the enemy — say so directly when the data says so.

B. Competitor pricing sweep — for every active ARC2 bundle listing, query Browse API for comparable listings (same series/issue/variant, same condition tier, FIXED_PRICE). If ARC2's total price (price + shipping) is no longer $1 under the lowest competitor's total, post a repricing recommendation to Discord and append it to actions.md.

Post actionable findings to this channel. Append every flag and recommendation to /workspace/group/actions.md with timestamp + reasoning + confidence. Log pricing calls to recommendations.md.`;

const ORACLE_TREND_SCAN_PROMPT = `Autonomous 3h market intelligence sweep. North stars: grow ARC2's buying budget and earn full purchasing autonomy. No human triggers this; no ack needed.

Before each run, read /workspace/extra/watcher/feedback.md — any Watcher calibration note must shape today's calls.

Each run, sweep for movement since your last run:
- WebSearch: trending comics, first appearances, movie/TV/streaming announcements, creator news, pop culture crossovers, adjacent collectible markets (Pokemon, sports cards, MtG crossovers, toys).
- eBay Browse API: sold comps for any title you've previously flagged — validate or kill your own calls with data. Say "I got that wrong, adjusting" when the comps turn against you.
- Read AIRTABLE_CASH_TABLE for current bank + eBay pending + Whatnot pending + FOC due this week before making any spend recommendation.

For every Buy/Watch/Skip call you make:
- POST a row to AIRTABLE_REC_TABLE with Title, FOC Date (if applicable), Recommendation Date, Agent 1 Signal, Agent 1 Reasoning, Copies Suggested, Estimated Cost, Estimated Return.
- If the signal is BUY, append to /workspace/group/signals.md: \`YYYY-MM-DDTHH:MM | BUY | <title> | conf=<%> | <one-line thesis> | rec_id=<airtable rec id>\`. Taskmaster reads this file before building listings.

Post the briefing to DISCORD_WEBHOOK_MARKET. Lead with actionable signals; if nothing material has moved since your last run, post a one-liner and exit — do not pad.

Your accuracy ledger is how autonomy is earned. The Watcher scores it weekly — ship clean, verifiable calls.`;

const ORACLE_BREAKING_NEWS_PROMPT = `Autonomous 3h breaking-news alert (offset 30 min from the trend scan). You are the first voice on ARC2 for anything market-moving. No human triggers this; speed > polish.

Focus narrowly on high-signal breaking news in the last ~3h:
- Movie / TV / streaming announcements that reprice first appearances
- Creator news — death, exit, exclusive switch, major signing, retirement, return
- Crossover events, surprise variants, shock cancellations, rights/OA news
- Category-spanning collectible moves that pull capital away from or into comics

If nothing material: POST "no material moves since <ISO timestamp>" to DISCORD_WEBHOOK_MARKET and exit. If material: POST immediately with the specific affected titles, your suggested action, confidence score, and links. Log each call to AIRTABLE_REC_TABLE and append BUY signals to /workspace/group/signals.md (same format as the trend scan).

Your advantage is timing. Accurate fast calls compound your autonomy ledger.`;

const ORACLE_MONDAY_FOC_PROMPT = `Autonomous Monday 7am UTC full FOC briefing (weekly — runs alongside the 06:00 trend scan and 06:30 alert). No human triggers this; no ack needed.

Before starting, read /workspace/extra/watcher/feedback.md for last week's calibration.

Comprehensive Final Order Cutoff briefing for the week's Lunar + Penguin solicitations:
- Every title with FOC this week
- Your Buy / Watch / Skip signal + reasoning
- Confidence score (40-90%)
- Suggested copies + ratio-variant targets
- Estimated cost, expected return, break-even sell-through

Write each signal to AIRTABLE_REC_TABLE (Title, FOC Date, Recommendation Date, Agent 1 Signal, Agent 1 Reasoning, Copies Suggested, Estimated Cost, Estimated Return). Append each BUY to /workspace/group/signals.md. Post the full briefing to DISCORD_WEBHOOK_MARKET in scannable table/bullet form.

FOC-ordering autonomy is earned on this ledger. Execute without waiting for approval.`;

const ORACLE_FOC_INBOX_PROMPT = `Autonomous FOC queue processor. The gating script already confirmed there is at least one row in AIRTABLE_FOC_QUEUE_TABLE (tbl4sAX5BbnjkJZLv) with Status='Pending'. No human triggers this; process everything and move on.

1. Pull every pending queue row:
   curl -sG "https://api.airtable.com/v0/\${AIRTABLE_BASE}/\${AIRTABLE_FOC_QUEUE_TABLE}" \\
     -H "Authorization: Bearer \${AIRTABLE_TOKEN}" \\
     --data-urlencode "filterByFormula={Status}='Pending'" \\
     --data-urlencode "fields[]=Distributor" --data-urlencode "fields[]=Content" --data-urlencode "fields[]=FOC Date"
   Paginate with offset if present. Capture each row's id, Distributor, Content, FOC Date.

2. For each queue row, parse Content as CSV. Distributor is authoritative — use the Lunar parser when Distributor='Lunar' and the Penguin parser when Distributor='Penguin'. Do not sniff columns. Infer title, issue, variant, vendor code, FOC date from the distributor's schema.

3. For each title, run a short analysis in parallel where possible:
   - WebSearch for buzz, signings, upcoming adaptations, creator milestones
   - eBay Browse API for previous-issue sold comps (3 and 6 issues back if the series is ongoing)
   - Read AIRTABLE_INV_TABLE for past sell history on this series (how fast did ARC2 move previous issues? at what margin?)
   - Read AIRTABLE_CASH_TABLE — check FOC Due This Week and cash headroom before every BUY

4. Produce a ranked buy list per queue row: Buy / Watch / Skip with confidence (40-90%), copies suggested, estimated cost, estimated return.

5. POST every call (Buy, Watch, Skip) to AIRTABLE_REC_TABLE (tbl4bzCh0abF0ow1o) with the full-field payload; capture rec_id. Append each BUY to /workspace/group/signals.md with the rec_id.

6. POST the ranked list for each queue row to DISCORD_WEBHOOK_MARKET. Lead with the Top 5 BUYs by confidence × expected return.

7. PATCH the queue row to Status='Done' with Processed At set to the current UTC timestamp:
   curl -s -X PATCH "https://api.airtable.com/v0/\${AIRTABLE_BASE}/\${AIRTABLE_FOC_QUEUE_TABLE}/\${QUEUE_ID}" \\
     -H "Authorization: Bearer \${AIRTABLE_TOKEN}" -H "Content-Type: application/json" \\
     -d "{\\"fields\\":{\\"Status\\":\\"Done\\",\\"Processed At\\":\\"$(date -u +%FT%TZ)\\"}}"

If parsing fails on any row, PATCH that row to Status='Failed' with the error written to Notes, and flag it in Discord. Never leave a failed row as Pending — the gate will keep waking you otherwise.`;

const WATCHER_HOURLY_PROMPT = `Autonomous hourly audit + per-sale attribution. The gating script has already confirmed new Airtable sales in the last hour. No human triggers this; no ack needed.

For each AIRTABLE_INV_TABLE row with Sale Date in the last 65 minutes (65 = 60 + 5 min script-run buffer), run the 8-point sale analysis:

  1. Title / SKU / Series / Issue / Variant
  2. Sale: date, price, platform
  3. Days-to-sale (Sale Date - Listed On, or - Added Date if not listed on ARC2)
  4. Cost basis breakdown: Purchase Price, Bag Board, Top Loader, Grading Fee, Signature Fee, Services Cost
  5. eBay fee (Sale Price × 0.13), Label Cost, Shipping Cost
  6. Net = Sale Price - break_even - Label Cost - Shipping Cost; margin_pct = Net / Sale Price
  7. Oracle attribution — query AIRTABLE_REC_TABLE for a recommendation on this title: was there a signal? which one (Buy/Watch/Skip)? did Kyle/Justin follow it (Decision field)? If matched, PATCH that rec row with Actual Sale Price, Days to Sell, Net Profit, Outcome (Sold Fast / Sold Slow / Loss).
  8. Verdict: if Oracle called BUY and it sold above break-even → credit Oracle; if Kyle/Justin overrode to Skip and it sold profitably → flag the override as a miss; if Oracle called SKIP and Kyle/Justin bought it anyway and it lost → flag the override; otherwise neutral.

Post one 8-point summary per sale to DISCORD_WEBHOOK_INVENTORY and append to /workspace/group/sales_log.md (full math shown).

Update taskmaster_scorecard.md and oracle_scorecard.md rolling numbers. Post a consolidated note only if something material shifted: margin collapse on a category, velocity swing, attribution streak, override concern. Credibility depends on not crying wolf.

You measure. You do not advise.`;

const WATCHER_DAILY_DIGEST_PROMPT = `Autonomous daily 9am UTC digest. No human triggers this; no ack needed.

Compile yesterday's roll-up (last 24h):
- Sales count, gross revenue, total net, average margin, margin distribution (winners / losers)
- Fastest mover (shortest days-to-sale), slowest mover, biggest single-sale net, biggest loss
- Inventory health: current active listings, 7-day velocity trend, aging buckets (0-30 / 30-45 / 45-60 / 60+ days)
- Cash position update from AIRTABLE_CASH_TABLE (Bank Balance, eBay Pending, Whatnot Pending, FOC Due This Week, Realized Profit delta vs 7 days ago)
- Oracle attribution summary for the 24h window: hit rate, override rate, net $ attributable

POST the digest to DISCORD_WEBHOOK_INVENTORY. Lead with headline numbers, then margin analysis, inventory health, cash, attribution.

Append the day's roll-up to sales_log.md. Do not touch recommendations — you measure, you don't advise.`;

const WATCHER_WEEKLY_SCORECARD_PROMPT = `Autonomous Monday 9am UTC weekly scorecard. Runs in the same slot as the daily digest — produce BOTH: first post the daily digest, then the weekly scorecard in a second message. No human triggers this.

Scorecard for the past 7 days:
- Oracle accuracy: calls / hits / misses / pending; rolling 30-day accuracy %; progress toward the 80% autonomy threshold
- Taskmaster performance: sell-through rate vs target, median days-to-sale, stale-listing rate, loss-protocol compliance; progress toward its autonomy thresholds
- Kyle / Justin override rate: how often they overrode Oracle, how often the override paid off, net $ impact of overrides
- Autonomy ladder progress: where each agent sits relative to its milestones in their CLAUDE.md, with calendar-date ETA at current accuracy trend
- Anomalies / flags: anything the calibration loop should address next week

Write the full scorecard to /workspace/group/feedback.md with this week's ISO date header — Oracle reads this before making new calls. Post a condensed version to DISCORD_WEBHOOK_INVENTORY. Include sharp, specific calibration notes (not platitudes) in feedback.md — Oracle will act on them.

Update taskmaster_scorecard.md and oracle_scorecard.md with the week's numbers.`;

const tasks = [
  {
    id: 'arc2-taskmaster-sales-sync-30min',
    group_folder: 'discord_arc2-taskmaster',
    chat_jid: 'dc:1494068408902221895/taskmaster',
    prompt: TASKMASTER_SALES_SYNC_PROMPT,
    schedule_value: '*/30 * * * *',
    script: null,
  },
  {
    id: 'arc2-taskmaster-store-audit-hourly',
    group_folder: 'discord_arc2-taskmaster',
    chat_jid: 'dc:1494068408902221895/taskmaster',
    prompt: TASKMASTER_STORE_AUDIT_PROMPT,
    schedule_value: '15 * * * *',
    script: null,
  },
  {
    id: 'arc2-oracle-trend-scan-3h',
    group_folder: 'discord_arc2-oracle',
    chat_jid: 'dc:1494068408902221895/oracle',
    prompt: ORACLE_TREND_SCAN_PROMPT,
    schedule_value: '0 */3 * * *',
    script: null,
  },
  {
    id: 'arc2-oracle-breaking-news-alert-3h',
    group_folder: 'discord_arc2-oracle',
    chat_jid: 'dc:1494068408902221895/oracle',
    prompt: ORACLE_BREAKING_NEWS_PROMPT,
    schedule_value: '30 */3 * * *',
    script: null,
  },
  {
    id: 'arc2-oracle-monday-foc-briefing',
    group_folder: 'discord_arc2-oracle',
    chat_jid: 'dc:1494068408902221895/oracle',
    prompt: ORACLE_MONDAY_FOC_PROMPT,
    schedule_value: '0 7 * * 1',
    script: null,
  },
  {
    id: 'arc2-oracle-foc-inbox-check-hourly',
    group_folder: 'discord_arc2-oracle',
    chat_jid: 'dc:1494068408902221895/oracle',
    prompt: ORACLE_FOC_INBOX_PROMPT,
    schedule_value: '45 * * * *',
    script: FOC_INBOX_GATE,
  },
  {
    id: 'arc2-watcher-sales-check-hourly',
    group_folder: 'discord_arc2-watcher',
    chat_jid: 'dc:1494068408902221895/the-watcher',
    prompt: WATCHER_HOURLY_PROMPT,
    schedule_value: '5 * * * *',
    script: WATCHER_HOURLY_GATE,
  },
  {
    id: 'arc2-watcher-daily-digest-9am',
    group_folder: 'discord_arc2-watcher',
    chat_jid: 'dc:1494068408902221895/the-watcher',
    prompt: WATCHER_DAILY_DIGEST_PROMPT,
    schedule_value: '0 9 * * *',
    script: null,
  },
  {
    id: 'arc2-watcher-weekly-scorecard-monday',
    group_folder: 'discord_arc2-watcher',
    chat_jid: 'dc:1494068408902221895/the-watcher',
    prompt: WATCHER_WEEKLY_SCORECARD_PROMPT,
    schedule_value: '5 9 * * 1',
    script: null,
  },
];

const upsert = db.prepare(`
  INSERT INTO scheduled_tasks
    (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
  VALUES (?, ?, ?, ?, ?, 'cron', ?, 'isolated', ?, 'active', ?)
  ON CONFLICT(id) DO UPDATE SET
    group_folder = excluded.group_folder,
    chat_jid = excluded.chat_jid,
    prompt = excluded.prompt,
    script = excluded.script,
    schedule_type = excluded.schedule_type,
    schedule_value = excluded.schedule_value,
    context_mode = excluded.context_mode,
    next_run = excluded.next_run,
    status = excluded.status
`);

const tx = db.transaction(() => {
  for (const t of tasks) {
    const nextRun = CronExpressionParser.parse(t.schedule_value, { tz: TZ }).next().toISOString();
    upsert.run(t.id, t.group_folder, t.chat_jid, t.prompt, t.script, t.schedule_value, nextRun, now);
  }
});
tx();

const verify = db.prepare(`
  SELECT id, group_folder, schedule_value, next_run, status, CASE WHEN script IS NULL THEN 0 ELSE 1 END AS gated
  FROM scheduled_tasks WHERE id LIKE 'arc2-%' ORDER BY next_run
`).all();
console.table(verify);
db.close();
