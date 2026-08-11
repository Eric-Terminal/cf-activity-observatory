# CF Activity Observatory

[简体中文](./README.md) · [Archive schema](./docs/ARCHIVE_SCHEMA.md) · [Security policy](./SECURITY.md)

CF Activity Observatory is a self-hosted HTTP activity and security analytics tool for Cloudflare Workers. It periodically reads the Cloudflare GraphQL Analytics API, persists short-lived sampled detail and sampling-adjusted trends in D1 and R2, and provides a Web UI for reviewing activity across days, weeks, and months.

> This project is not affiliated with or endorsed by Cloudflare, Inc. Cloudflare is a trademark of its respective owner.

## Data boundary

This is not a replacement for Enterprise Logpush/Logpull and does not claim to store exhaustive, unsampled request logs.

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
- Combined filters, URL restoration, saved views, keyset pagination, and Cloudflare-style detail drawers.
- Adjusted request/mitigation trends, action distribution, country map, and separate high-cardinality cubes for path, IP, ASN, User-Agent, and rules.
- D1 online detail retention (90 days by default) and verified hourly gzip NDJSON archives in R2.
- Five-minute, hourly, and daily trend retention with a 400 MB D1 safety waterline.
- Free-tier guards: 240 GraphQL calls per five minutes, 20% Queue reserve, and D1 write pause at 80% of the daily budget.
- Cloudflare Access JWT verification, same-origin protection for writes, and strict security headers.
- SMTP alerts over implicit TLS on 465 or STARTTLS on 587, with AES-GCM encrypted passwords.
- Simplified Chinese and English, light/dark/system themes, responsive layout, and reduced-motion support.

## Architecture

The every-minute Cron dispatches bounded per-zone/per-dataset jobs to a Queue. Collectors query GraphQL and write detail, metrics, cursors, usage, and gaps to D1. Maintenance jobs aggregate metrics, write deterministic hourly archives to R2, verify object size/checksum metadata, and only then permit D1 detail pruning. The React/Vite SPA calls a Hono `/api/v1` API protected by Access.

All persisted/API timestamps are UTC. The UI renders them in the browser's timezone.

## Required Cloudflare API Token permissions

- Account — Analytics — Read
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
pnpm deploy
```

Add a custom domain, then create a Cloudflare Access Self-hosted application for that hostname. Configure GitHub OAuth or another identity provider and an Allow policy. Store the Team domain and application AUD in the two Access secrets. The Worker validates RS256 signature, issuer, and AUD according to Cloudflare's [Access JWT validation guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

`workers.dev` and Preview URLs are disabled to prevent an Access bypass.

## First run

1. Sign in and open Settings & Health.
2. Discover Cloudflare zones.
3. Enable the desired zones and set polling/online retention.
4. Review the discovered capabilities for all four datasets.
5. Optionally configure SMTP and send a test message.
6. Wait for two live polling cycles and confirm cursors, adjusted trends, sampled rows, and an R2 archive.

## Free-tier estimate

One zone, four datasets, and a five-minute polling interval is estimated at about 3,456 Queue operations per day including send/receive/ack accounting. The UI estimates all enabled zones and rejects configurations above the 8,000/day safety budget, leaving room for repair, retries, archives, and other account activity.

Cloudflare limits can change; verify current limits before deployment. The application's counters estimate only its own usage, not other workloads in the account.

## Archives and upgrades

R2 keys use:

```text
archives/{zone_id}/{dataset}/YYYY/MM/DD/HH.ndjson.gz
```

The first line contains schema metadata; each following line is one exported D1 row. See [docs/ARCHIVE_SCHEMA.md](./docs/ARCHIVE_SCHEMA.md) for checksums and restore guidance.

To upgrade, back up D1/R2, pull the new tag, install the locked dependencies, apply remote migrations, and deploy. Roll back code by deploying the previous Git tag. Release Notes will call out any data migration that cannot be reversed safely.

## Security and privacy

- Request bodies, Cookies, Authorization, and other request headers are not collected.
- IP addresses, full query strings, and User-Agent values are investigation data; configure retention and access according to applicable law.
- Sensitive request fields are excluded from structured logs, error summaries, and alert messages.
- SMTP passwords are AES-GCM encrypted with the 32-byte `CONFIG_ENCRYPTION_KEY`. Losing that key requires re-entering the password.
- A completely stopped Cron cannot alert on itself. Monitor `/api/v1/health` externally using an Access Service Token.
- Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).

## License

[GNU Affero General Public License v3.0 only](./LICENSE).
