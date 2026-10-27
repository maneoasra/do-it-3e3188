# Architecture

This is the Barney’s Czech attendance application on Netlify. Keep its dark brown/gold visual design and Czech copy. It uses plain HTML with inline CSS and browser JavaScript, without a frontend build step.

- `public/index.html`: complete frontend, Netlify Identity login and account activation, dashboard, attendance, scheduling, employees, events, revenue and CSV export.
- `public/assets/`: original supplied logo and restaurant photograph.
- `netlify/functions/team.ts`: Web API Netlify Function, POST action dispatcher for `/api/team`.
- `db/schema.ts`: Drizzle source of truth. Each business record has a stable key, kind and JSONB payload.
- `db/index.ts`: native Netlify Database Drizzle adapter.
- `netlify/database/migrations/`: generated SQL and schema snapshots. Netlify applies migrations on deployment.
- `netlify.toml`: static publish directory, function bundling, API rewrite and response headers.

# Conventions and decisions

This is an authenticated employee system using `@netlify/identity`. Never trust `X-Demo-Account`, client-supplied roles, or employee IDs as authentication. Verify the session and confirmed email on the server. The manager account is matched server-side; employee access comes from active profiles with a matching verified email. A profile without an email cannot log in. Never embed passwords or other credentials. Employees can inspect their own attendance and revenues and submit revenues; only the manager can manage other records.

Do not seed fictitious shifts, revenues, plans, or events. Do not collect or fabricate location data; browser geolocation remains disabled by response policy. Keep numeric inputs finite and nonnegative, validate dates and escape interpolated text in frontend HTML.

The authorized one-time production reset is transactional with the `meta:production-v1` sentinel. Never change that sentinel to repeat the reset; subsequent visits and deployments must preserve real records. Initial profiles are Martin (net rate 150 Kč/h) and Daniela (email to be added later). Clock actions lock the employee row to prevent overlapping open shifts. Server timestamps are authoritative. PostgreSQL is the persistent source of truth; do not replace it with local files or process memory.

Use `drizzle-orm@beta` and `drizzle-kit@beta` for the Netlify adapter. Generate schema migrations using `npx drizzle-kit generate --name descriptive_name` and never apply them manually. Local development uses `netlify dev --port 8889`. The deployment pipeline handles validation and deployment.
