# CF Activity Observatory

[简体中文](./README.md) · [Archive schema](./docs/ARCHIVE_SCHEMA.md) · [Security policy](./SECURITY.md)

CF Activity Observatory is a self-hosted HTTP activity and security analytics tool for Cloudflare Workers. It accepts native Logpush HTTP and firewall logs in private R2, retains GraphQL sampled collection, and stores sampling-adjusted trends in hourly R2 objects. D1 holds manifests, cursors, and settings; the browser queries the archives.

> This project is not affiliated with or endorsed by Cloudflare, Inc. Cloudflare is a trademark of its respective owner.

## Data boundary

Native `http_requests` and `firewall_events` logs are supported. Their coverage depends on the job's filters and sampling configuration; a Logpush source label does not imply exhaustive delivery. The following GraphQL datasets provide sampled compatibility collection and adjusted trends:

- `httpRequestsAdaptive`: sampled detail for HTTP activity, including requests that triggered no security action.
- `httpRequestsAdaptiveGroups`: sampling-adjusted HTTP counts and trends.
- `firewallEventsAdaptive`: sampled events processed or labelled by security products.
- `firewallEventsAdaptiveGroups`: sampling-adjusted trends by action, product, and rule.

Detail rows represent real requests, but not every request. Trend charts use Groups estimates rather than counting sampled rows. For each zone, the application discovers available fields, page limits, history boundaries, and maximum query duration through GraphQL `settings`; plan retention is not hard-coded. See Cloudflare's [dataset settings](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/) and [Adaptive Sampling](https://developers.cloudflare.com/analytics/graphql-api/features/sampling/) documentation.

## Features

- Per-zone enablement and polling from 1 to 1440 minutes; 5 minutes by default.
- Initial backfill from the discovered `notOlderThan` boundary and durable resume cursors.
- Five-minute data stability delay and hourly repair queries for late arrivals.
- Recursive window splitting for saturated pages and visible gap records when completeness cannot be guaranteed.
- Direct-to-R2 hourly sampled detail with browser-local decompression, filtering, keyset pagination, and CSV/JSON/NDJSON export.
- Combined filters, URL restoration, saved views, and Cloudflare-style detail drawers.
- Adjusted request/mitigation trends, action distribution, country map, and separate high-cardinality cubes for path, IP, ASN, User-Agent, and rules.
- Schema v2 camelCase records with browser-side compatibility for existing schema v1 R2 archives.
- Event-driven Logpush indexing, per-dataset source switching after verified receipt, and resumable R2 reconciliation.
- Hourly R2 trend objects replace per-dimension D1 writes. Historical rows are backed up and verified before bounded D1 cleanup.
- Free-tier guards: 240 GraphQL calls per five minutes, 20% Queue reserve, and collection pause when the application-counted D1 writes reach 70% of the daily budget.
- Cloudflare Access JWT verification, same-origin protection for writes, and strict security headers.
- SMTP alerts over implicit TLS on 465 or STARTTLS on 587, with AES-GCM encrypted passwords.
- Simplified Chinese and English, light/dark/system themes, responsive layout, and reduced-motion support.

## Architecture

Logpush delivers directly to R2 independently of the application. Object-created notifications use the serialized collector Queue to index each file. Cron continues GraphQL Groups collection into hourly R2 snapshots. Maintenance migrates legacy trends and evaluates alerts. The Access-protected API streams private archives; the SPA decompresses, filters, paginates, and aggregates locally. All charts for one range share a single archive scan.

All persisted/API timestamps are UTC. The UI renders them in the browser's timezone.

## Required Cloudflare API Token permissions

- Account — Account Analytics — Read
- Zone — Analytics — Read
- Zone — Zone — Read
- Resources — only the accounts or zones you intend to observe

The token is supplied only as a Worker Secret or local `.dev.vars` value. It is never stored in D1, R2, the browser, or application logs.

## Local development

Node.js 22+ and pnpm 10 are required.

```bash
pnpm install
cp .dev.vars.example .dev.vars
node ./node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --local
pnpm cf-typegen
pnpm dev
```

Generate `CONFIG_ENCRYPTION_KEY` with `openssl rand -base64 32`. Run the full verification suite with `pnpm check`.

If the repository is inside a parent directory containing `:`, the project scripts already avoid POSIX `PATH` ambiguity by calling local Node CLI entry points directly. The Cloudflare Vite development server itself may still reject such absolute paths; use `pnpm build && pnpm preview` in that case.

## Deployment

Create the resources:

```bash
node ./node_modules/wrangler/bin/wrangler.js login
node ./node_modules/wrangler/bin/wrangler.js d1 create cf-activity-observatory
node ./node_modules/wrangler/bin/wrangler.js r2 bucket create cf-activity-observatory-archives
node ./node_modules/wrangler/bin/wrangler.js queues create cf-activity-observatory
node ./node_modules/wrangler/bin/wrangler.js queues create cf-activity-observatory-dlq
```

If D1 creation returns a `database_id`, add it to the D1 entry in `wrangler.jsonc`. New Wrangler releases may provision by name with the current configuration.

Set secrets interactively:

```bash
node ./node_modules/wrangler/bin/wrangler.js secret put CLOUDFLARE_API_TOKEN
node ./node_modules/wrangler/bin/wrangler.js secret put CONFIG_ENCRYPTION_KEY
node ./node_modules/wrangler/bin/wrangler.js secret put ACCESS_TEAM_DOMAIN
node ./node_modules/wrangler/bin/wrangler.js secret put ACCESS_AUD
```

Apply migrations and deploy:

```bash
node ./node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --remote
pnpm check
pnpm wrangler:dry-run
pnpm run deploy
```

Add a custom domain, then create a Cloudflare Access Self-hosted application for that hostname. Configure GitHub OAuth or another identity provider and an Allow policy. Store the Team domain and application AUD in the two Access secrets. The Worker validates RS256 signature, issuer, and AUD according to Cloudflare's [Access JWT validation guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

`workers.dev` and Preview URLs are disabled to prevent an Access bypass.

## First run

1. Sign in and open Settings & Health.
2. Discover Cloudflare zones.
3. Enable the desired zones and set their polling interval.
4. Review the discovered capabilities for all four datasets.
5. Optionally configure SMTP and send a test message.
6. Wait for two live polling cycles and confirm cursors, adjusted trends, and R2 sampled-detail archives in the explorer.

## Free-tier estimate

One zone, four datasets, and a five-minute polling interval is estimated at about 3,744 Queue operations per day including send/receive/ack accounting. The UI estimates all enabled zones and rejects configurations above the 8,000/day safety budget, leaving room for repair, retries, and other account activity.

Neither new detail nor trend dimensions are stored in D1. GraphQL retains its 20,000-write backfill and 70,000-write overall safety guards. Historical cleanup stops at 50,000 counted writes. Logpush delivery remains independent; failed indexes can be rebuilt. Logpush subscriptions, R2, and Queue charges are separate; see [setup and migration instructions](./docs/LOGPUSH.md) and [Cloudflare pricing](https://developers.cloudflare.com/logs/logpush/pricing/).

Cloudflare limits can change; verify current limits before deployment. The application's counters estimate only its own usage, not other workloads in the account.

## Archives and upgrades

R2 keys use:

```text
archives/{zone_id}/{dataset}/YYYY/MM/DD/HH.ndjson.gz
```

The first line contains schema metadata; each following line is one deduplicated sampled-detail record. The Access-protected API streams private objects for local browser analysis, while raw gzip downloads remain available. See [docs/ARCHIVE_SCHEMA.md](./docs/ARCHIVE_SCHEMA.md) for checksums and compatibility details.

Back up D1/R2, install the locked dependencies, apply migration 0006, and deploy. Configure an R2 object-created notification filtered to `logpush/`, then set up HTTP/firewall Logpush jobs using the prefixes and fields shown in Settings. Switch sources only after recent files have been indexed. A single scan downloads at most 64 MiB; oversized scans fail explicitly and require a narrower range or zone.

Hourly maintenance backs up legacy trend rows older than seven days to `migration-backups/metrics/`, verifies the copy, merges an active R2 snapshot, and removes at most 500 D1 rows. Backups are retained. **Code-only rollback is unsafe after cleanup**: restore the old D1 table from the pre-upgrade backup or hourly original-row backups before running the old collector. Preserve post-upgrade data before restoring. See [migration and rollback](./docs/LOGPUSH.md#历史迁移与回滚).

## Security and privacy

- Request bodies, Cookies, Authorization, and other request headers are not collected.
- IP addresses, full query strings, and User-Agent values are investigation data; configure R2 lifecycle rules and access according to applicable law.
- Sensitive request fields are excluded from structured logs, error summaries, and alert messages.
- SMTP passwords are AES-GCM encrypted with the 32-byte `CONFIG_ENCRYPTION_KEY`. Losing that key requires re-entering the password.
- A completely stopped Cron cannot alert on itself. Monitor `/api/v1/health` externally using an Access Service Token.
- Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).

## License

[GNU Affero General Public License v3.0 only](./LICENSE).
