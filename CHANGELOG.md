## [Unreleased]

### Security

- **Cross-tenant elicitation/confirmation misroute (gateway mode).** The
  "server reference" used by elicitation helpers (`src/utils/elicitation.ts`
  — `elicitSelection` / `elicitText` / `elicitConfirmation`) was stored in a
  module-level `let _server: Server | null` singleton in
  `src/utils/server-ref.ts`, set synchronously per request via
  `setServerRef(server)` (called from `createMcpServer()` in
  `src/mcp-server.ts`) and read back later via `getServerRef()` — including
  after `await` gaps inside async tool handlers (e.g. after awaiting a
  SuperOps.ai API call, before sending an elicitation or confirmation
  prompt back through "the" server).
  - **Impact:** in gateway (multi-tenant HTTP) mode — `AUTH_MODE=gateway` —
    a fresh `Server` instance is created per inbound request, so two
    concurrent tenant requests could race through the shared global:
    tenant A's request sets the ref and starts awaiting async work; before
    A resumes, tenant B's request runs and overwrites the module-level ref
    with B's server/transport; when A's awaited work resolves and it reads
    the ref back to call `elicitInput`, it gets B's server — so A's
    elicitation/confirmation prompt is sent down B's connection instead of
    A's (or vice versa, depending on timing). The same race existed even in
    non-gateway (env-credential) HTTP mode, since a fresh `Server` is
    created per request there too. Same shared-mutable-state-across-await
    -gaps bug class as the credential-leak fixes in liongard-mcp#58,
    ninjaone-mcp#71, sherweb-mcp#60, avanan-mcp#48, and salesbuildr-mcp#58,
    and the server-ref fix in halopsa-mcp#65, but in this repo's
    server/transport routing subsystem for elicitation, not
    credential/token caching.
  - **Fix:** replaced the module-level singleton with an
    `AsyncLocalStorage<Server>` context (`runWithServerRef` for per-request
    transports — Node HTTP, Workers — and `bindServerRef` for the single-
    session stdio transport), mirroring the existing per-request credential
    isolation pattern already used for SuperOps credentials
    (`credentialStore` / `runWithCredentials` in `src/client.ts`).
    `getServerRef()` now reads from the ALS context instead of a shared
    variable, so it is correctly scoped to the request that created it and
    survives arbitrary `await` gaps without observing a concurrent
    request's server. There is no module-level mutable server/transport
    state left in `src/utils/server-ref.ts`. Call sites updated:
    `src/mcp-server.ts` (`createMcpServer` no longer calls `setServerRef`),
    `src/index.ts` (Node HTTP `handleMcp` wraps both the gateway-mode and
    non-gateway-mode connect/handleRequest chains in `runWithServerRef`;
    stdio calls `bindServerRef` once at startup), `src/worker.ts`
    (Cloudflare Workers `handleMcp` wraps the connect/handleRequest chain
    in `runWithServerRef`).
  - **Regression test:** `src/utils/server-ref.test.ts` forces a
    deterministic interleave (a manually-resolved "gate" promise, not a
    timing stagger) where tenant A binds its server and suspends on an
    await gap, tenant B's entire request runs to completion in the
    meantime, and only then does tenant A resume and elicit. The test
    asserts by value which tenant's mock `elicitInput` actually received
    each message, plus explicit negative cross-checks. Verified to fail
    with the exact predicted symptom (`expected 'tenant-B' to be
    'tenant-A'`) against a reinstated module-singleton implementation, and
    to pass against the ALS-based fix.

### Added

- **Interactive ticket card via MCP Apps (SEP-1865).** `superops_tickets_get` results now render as an interactive card in MCP Apps hosts (Claude Desktop/web, and other hosts advertising the `io.modelcontextprotocol/ui` extension), instead of a wall of JSON. The card shows status, priority, client, requester, assignee, tech group, category, and site as human-readable labels, key dates, and a plain-text description snippet — and includes a working "Add note" round-trip that calls `superops_tickets_add_note` from inside the card. Non-App hosts are unaffected: the tool's JSON payload is unchanged apart from a new `_card` field.
  - The two renderable tools advertise the UI via `_meta` (`ui/resourceUri`, plus the nested `ui.resourceUri` form) pointing at a new `ui://superops/ticket-card.html` resource served as `text/html;profile=mcp-app`. The card HTML is a self-contained vite single-file bundle embedded at build time (`src/generated/ticket-card-html.ts`, committed), so it serves identically from stdio, Node HTTP, and the fs-less Cloudflare Workers runtime. The server now declares the `resources` capability and answers `resources/list` / `resources/read` (`src/resources.ts`).
  - The card is neutral by default (system fonts, no vendor identity, no external fetches) and brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env vars (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, `MCP_BRAND_TEXT`): at serve time the server replaces the card's BRAND_INJECT marker with an inline, `<`-escaped `window.__BRAND__` script, so self-hosters can theme the card without rebuilding. No brand configured = HTML served unchanged.
  - The card's "Add note" round-trip always posts with `isPublic: false`. SuperOps controls note visibility with the `NotePrivacyType` enum (`PUBLIC`/`PRIVATE`); `superops_tickets_add_note` exposes that as an `isPublic` boolean and maps it, so an internal-only default keeps a note private unless someone opts in and the card never guesses visibility itself (`src/card.builder.ts`).
  - The card payload builder is best-effort: an unexpected ticket shape drops the card without affecting the tool result. 21 new contract tests in `src/mcp-apps.test.ts` pin the `_meta` advertisement, the `ui://` resource wire shape, the neutral-default/brand-injection behavior, and the card normalization.

- **`superops_technicians_lookups`.** SuperOps returns a technician's `role`,
  `team`, `designation` and `businessFunction` as opaque JSON, and filtering on
  them needs an id, which nothing exposed. This resolves all four vocabularies
  in one argument-less round trip.

- **Offline schema conformance tests.** `schema/superops.graphql` vendors the
  real SuperOps schema and `src/domains/graphql-schema.test.ts` validates every
  GraphQL document in `src/` against it on each test run — no API credentials
  required. The existing suite mocked the GraphQL client entirely, so 187 tests
  passed while all 16 operations were unusable; this closes that gap.

  `scripts/fetch-schema.mjs` regenerates the schema from **live introspection**
  when `SUPEROPS_API_TOKEN` and `SUPEROPS_SUBDOMAIN` are set — authoritative,
  since it is what the server will actually answer — and falls back to scraping
  the published API reference otherwise, so CI and outside contributors can
  still regenerate without credentials. The committed schema is now the
  introspected one.

  Prefer introspection: measured against the live API, the published docs
  declare 276 types / 76 queries / 63 mutations where introspection reports
  **404 / 116 / 83**. Every operation the docs declare does exist, so the
  scrape is a safe subset — but two *types* they declare do not: `FieldType`
  (live: `CustomFieldType`) and `TicketType` (live: `Ticket.ticketType` is a
  plain `String`, not an enum). Validating against those would have passed
  documents the API rejects, so the scrape path now repoints and drops them.
  The docs also omit deprecations entirely — 9 queries and 5 mutations are
  deprecated-but-served, which only introspection reveals.

### Fixed

- **HTTP error bodies:** non-2xx SuperOps responses now include a truncated,
  secret-scrubbed body and GraphQL `errors[].message` values, instead of only
  `HTTP error: 400 Bad Request`.
- **Tool failure logs:** domain and `superops_test_connection` failures write
  one JSON line to stdout, without secrets, credentials, tool arguments, or
  request headers.

- **Every GraphQL operation was invalid against the SuperOps API.** All 16
  queries and mutations had been written against an invented schema, so no tool
  in this server could complete a call. `superops_clients_list` and
  `superops_test_connection` both failed with
  `Validation error ... Field 'phone' in type 'Client' is undefined` — but
  `phone` was only the *first* of ten errors on that one query, and every other
  operation was broken too. Specifically:
  - **Fields that do not exist.** `Client` has no `phone`, `website`,
    `industry`, `employeeCount`, `annualRevenue`, `address`, `sites`,
    `createdTime` or `lastUpdatedTime`. `Ticket` has no `ticketNumber`
    (it is `displayId`), no `assignee` (it is `technician`), no
    `lastUpdatedTime` (it is `updatedTime`) and no readable `description`.
    `Asset` has no `ipAddress`, `macAddress` (it is `primaryMac`), `hostname`
    (it is `hostName`), `osName`/`osVersion`/`osBuild`/`architecture` (they are
    `platform*`), CPU/memory/disk fields, `tags` or `lastSeen`. `Technician`
    has no `id` (it is `userId`), no `phone` (it is `contactNumber`), and none
    of `isActive`/`department`/`teams`/`manager`/`skills`/`ticketCount`/
    `lastLoginTime`.
  - **Subselections on JSON scalars.** `client`, `site`, `requester`,
    `technician`, `techGroup`, `accountManager`, `primaryContact`,
    `customFields` and friends are the `JSON` scalar. The old queries selected
    subfields on them (`client { id name }`), which GraphQL rejects outright.
  - **The wrong pagination model.** The server sent Relay-style
    `first`/`after`/`filter`/`orderBy` and selected `hasNextPage`/`endCursor`.
    SuperOps uses offset pagination: `ListInfoInput { page, pageSize,
    condition, sort }` and `ListInfo { page, pageSize, totalCount, hasMore }`.
  - **Operations that do not exist.** `getTechnician` (use a filtered
    `getTechnicianList`), `getTechGroupList` (it is `getTechnicianGroupList`,
    which takes no arguments), `addTicketNote` (it is `createNote`), and
    `addTicketTimeEntry` (it is `createWorklogEntries`, which takes a list).
    The `AssetSoftwareListInput` and `AssetPatchInput` types do not exist
    either; both asset detail queries take `AssetDetailsListInput`.

  All operations have been rewritten against the real schema and verified
  against a live SuperOps tenant. Tool names are unchanged, but list tools now
  take `page`/`pageSize` instead of `max`/`cursor`.

- **`superops_tickets_add_note` used a deprecated mutation.** `createTicketNote`
  is still served, but carries `@deprecated(reason: "Use createNote")`. Notes
  now go through `createNote(input: CreateNoteInput!)`, addressed by
  `workItem { workId, module: TICKET }` rather than `ticket { ticketId }`.
  (SuperOps deprecates rather than removes: `createClient`, `createWorklog` and
  `createServiceItem` are all still live behind newer replacements.)

- **`getTicketList` returned nothing unless `ticketId` was selected.** Omitting
  `ticketId` from the selection set yields an empty `tickets` array alongside a
  correct, filter-aware `totalCount`, with no error. The query selects it and a
  test now pins that it always will.

- **Ticket field values that do not exist.** `superops_tickets_list` and the
  elicitation prompt offered statuses `In Progress` and `Pending`; neither is
  real. The tenant's values are `Open`, `On Hold`, `Resolved`, `Closed` and
  `Waiting on third party`. `priority` was missing `Very Low`, and the
  `TicketSource` enum shipped 6 of the API's 10 values (missing `SCHEDULE`,
  `CONTRACT_REMINDER`, `CONTRACT`, `INSTANT_MESSAGING`). Values now come from
  `getAllFields`, which returns a module's authoritative option lists in one
  call; only `source` ships as an `enum`, because it is a real GraphQL enum —
  the rest are per-tenant lookup lists typed `String`, where a hardcoded enum
  would reject values the API accepts.

- **Filters that silently matched nothing.** Live testing found three filters
  that returned an empty list with no error — the worst failure mode, because
  an empty result is indistinguishable from an empty tenant:
  - `superops_clients_list` advertised stage `Lead/Prospect/Customer/Churned`
    and status `Active/Inactive/Archived`. The tenant's real values are stage
    `Active/Inactive/Prospect` and status
    `Paid/Unpaid/New/Negotiation/Won/Lost` (status is scoped to its parent
    stage). Every filter using an advertised value returned zero rows.
  - `superops_assets_list` filtered `platform` with `includes: ["Windows"]`.
    `includes` matches a value whole, and SuperOps stores the full OS string
    (`"Microsoft Windows 10 Pro"`), so it matched nothing; it now uses
    `contains`.
  - `superops_assets_software` filtered the `software` JSON column instead of
    the `software.name` path inside it, which the API accepts and answers with
    an empty list.

- **`hasMore` is tri-state.** It is `true` when another page exists and `null`
  — never `false` — when it does not, so paging until `hasMore === false` never
  terminates. Documented on `ListInfo`, and `totalCount` is the safer basis.

- **Only the first GraphQL error was reported.** `SuperOpsClient.query` threw
  `errors[0]` and discarded the rest, so a query with ten schema violations
  surfaced as a single complaint about `phone` and sent debugging down the
  wrong path. It now reports every error and exposes them on
  `SuperOpsError.errors`.

- **`superops_test_connection` could prompt the user.** It delegated to
  `superops_clients_list`, which elicits a search term when called without
  filters. A connectivity check must never block on a prompt, so it now issues
  its own minimal query.

- **`superops_test_connection` returned 500 from that minimal query.** Asking
  `getClientList` for `listInfo` alone — without also selecting `clients` — is
  valid GraphQL that SuperOps answers with an internal server error. Verified
  against a live tenant; schema validation cannot catch it, so the ping now
  selects one client id alongside the count and the query carries a comment
  warning against "simplifying" it.

- **deploy:** authenticate GitHub Packages in one-click cloud builds. Added the
  `_authToken` line to `.npmrc`, a build-time `GITHUB_TOKEN` secret to the
  DigitalOcean app template, and `ARG GITHUB_TOKEN` + temporary authenticated
  `.npmrc` to the Dockerfile so `npm ci` can resolve `@wyre-ai/*`
  packages during Cloudflare/DigitalOcean deploys.

### Changed

- **Filters compose again.** The published docs describe `RuleConditionInput`
  as a single flat `{attribute, operator, value}` clause, and the tools were
  narrowed to match — `superops_clients_search` dropped its email-domain leg,
  and the list tools applied one filter by precedence while silently discarding
  the rest. Live introspection shows the type is recursive: it also carries
  `joinOperator` and `operands`. Compound filtering is restored, so search
  matches across fields again and list tools apply every filter given.

  `joinOperator` must be **uppercase** (`"AND"`/`"OR"`). Anything the API does
  not recognise — lowercase `"and"`, or junk — is silently ignored and the
  operands are joined with `OR`, returning a superset with no error. The
  `RuleConditionInput` type is deliberately typed `"AND" | "OR"` to make that
  unrepresentable, and each domain's tests assert the emitted casing at every
  nesting depth, since a regression would return plausible-looking rows.

- **release:** this server ships as a container image
  (`ghcr.io/wyre-ai/superops-mcp`) and an MCP Registry entry, not as an npm
  package — `npmPublish` is `false` (ae107a6), which also avoids the 401/403
  the publish step hit. An earlier Unreleased entry claimed GitHub Packages
  publishing had been turned on; that change was reverted before release, so
  the claim is corrected here rather than shipped. The `.npmrc` / Dockerfile /
  DigitalOcean token plumbing above is still needed — it authenticates
  *installing* `@wyre-ai/*` build dependencies, which is a separate concern
  from publishing this package.

## [1.2.5](https://github.com/WYRE-AI/superops-mcp/compare/v1.2.4...v1.2.5) (2026-04-07)


### Bug Fixes

* **ci:** deploy :latest tag, force revision via env var bump ([77b2448](https://github.com/WYRE-AI/superops-mcp/commit/77b24487047acba1bafa64f1e8763ae18f93569c))

## [1.2.4](https://github.com/WYRE-AI/superops-mcp/compare/v1.2.3...v1.2.4) (2026-03-31)


### Bug Fixes

* **deploy:** replace node_compat with nodejs_compat for Wrangler v4 ([5151468](https://github.com/WYRE-AI/superops-mcp/commit/515146842d1c8802de6e4f4ed0446371c100a71e))

## [1.2.3](https://github.com/WYRE-AI/superops-mcp/compare/v1.2.2...v1.2.3) (2026-03-10)


### Bug Fixes

* **ci:** strip scope prefix from MCPB bundle filename ([a036691](https://github.com/WYRE-AI/superops-mcp/commit/a0366916f6b5c1696b26d6f17f131c5e60f55298))

## [1.2.2](https://github.com/WYRE-AI/superops-mcp/compare/v1.2.1...v1.2.2) (2026-03-10)


### Bug Fixes

* **ci:** add npm ci before MCPB pack and grant contents:write to Docker job ([f692c4e](https://github.com/WYRE-AI/superops-mcp/commit/f692c4e543e87fd4fdd96a197be72136bf467eda))

## [1.2.1](https://github.com/WYRE-AI/superops-mcp/compare/v1.2.0...v1.2.1) (2026-03-10)


### Bug Fixes

* **ci:** rename pack-mcpb.js to .cjs to fix require() in ESM scope ([f743d68](https://github.com/WYRE-AI/superops-mcp/commit/f743d6862e04f54931838f9120ff806c781bb913))

# [1.2.0](https://github.com/WYRE-AI/superops-mcp/compare/v1.1.3...v1.2.0) (2026-03-10)


### Features

* **elicitation:** add MCP elicitation support with graceful fallback ([#1](https://github.com/WYRE-AI/superops-mcp/issues/1)) ([ceb51d9](https://github.com/WYRE-AI/superops-mcp/commit/ceb51d91f1509e7022bfda1f119c60131d7baf0b))

## [1.1.3](https://github.com/WYRE-AI/superops-mcp/compare/v1.1.2...v1.1.3) (2026-03-02)


### Bug Fixes

* **ci:** fix broken YAML in Discord notification step ([ccfb0f0](https://github.com/WYRE-AI/superops-mcp/commit/ccfb0f0969266d8b64f2bc8598d725904408f5d9))

## [1.1.2](https://github.com/WYRE-AI/superops-mcp/compare/v1.1.1...v1.1.2) (2026-02-26)


### Bug Fixes

* **ci:** move Discord notification into release workflow ([8193c5f](https://github.com/WYRE-AI/superops-mcp/commit/8193c5f8e46ca27edde1fb3342ed18d23dd2f708))

## [1.1.1](https://github.com/WYRE-AI/superops-mcp/compare/v1.1.0...v1.1.1) (2026-02-23)


### Bug Fixes

* quote MCPB bundle filename to prevent shell glob expansion failure ([7d0845c](https://github.com/WYRE-AI/superops-mcp/commit/7d0845c4cad3a4d723ac72c49bf7e87b39b21ed6))
* rename duplicate step id 'version' to 'release-version' in docker job ([e8b035b](https://github.com/WYRE-AI/superops-mcp/commit/e8b035b9d8f3a1a1b0dca1d096993563686b1d65))

# [1.1.0](https://github.com/WYRE-AI/superops-mcp/compare/v1.0.0...v1.1.0) (2026-02-18)


### Bug Fixes

* **ci:** fix release workflow failures ([c8fa4b8](https://github.com/WYRE-AI/superops-mcp/commit/c8fa4b8f5a2166c819b490315c4d378ef81f74be))
* **docker:** drop arm64 platform to fix QEMU build failures ([5a2f713](https://github.com/WYRE-AI/superops-mcp/commit/5a2f7137e74d8640124cd6c3104e8c61e60ed010))
* escape newlines in .releaserc.json message template ([cfeb0e8](https://github.com/WYRE-AI/superops-mcp/commit/cfeb0e80070b17b39129d988accb2dd98baa8fa5))
* update Node.js to 22 for semantic-release compatibility ([654083a](https://github.com/WYRE-AI/superops-mcp/commit/654083a7a57c243ad68928c27f8335c0d263781e))
* update Node.js to 22 in ci.yml release job ([2218c24](https://github.com/WYRE-AI/superops-mcp/commit/2218c248ffde3a4cb513d38ffe727007985ad13f))


### Features

* add MCPB manifest for desktop installation ([ecbc3c2](https://github.com/WYRE-AI/superops-mcp/commit/ecbc3c26f244cf51841f2e16e68512dfea1836db))
* add MCPB pack script ([209a183](https://github.com/WYRE-AI/superops-mcp/commit/209a1832760edb1cc9c1099c16528221318fea3f))
* add mcpb packaging support ([4823ed4](https://github.com/WYRE-AI/superops-mcp/commit/4823ed41f7bf774955069d09b5fbec5894b4fcaf))
* add mcpb packaging support ([830bb96](https://github.com/WYRE-AI/superops-mcp/commit/830bb968bc6afa1a05ca056997cc66123541c854))
* add mcpb packaging support ([08ed8f2](https://github.com/WYRE-AI/superops-mcp/commit/08ed8f2feda0de6f4debcab49ae85a95505df139))
* add mcpb packaging support ([5b74455](https://github.com/WYRE-AI/superops-mcp/commit/5b74455e1196b5def987eae34561645bddf544a4))
* add mcpb packaging support ([15f7488](https://github.com/WYRE-AI/superops-mcp/commit/15f7488437a3a7bc046c4c91d80e32fd6931608f))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial release of SuperOps.ai MCP Server
- Decision tree architecture for tool navigation
- Lazy loading of domain modules
- Navigation tools: `superops_navigate`, `superops_back`, `superops_test_connection`
- Clients domain with list, get, and search tools
- Tickets domain with list, get, create, update, add_note, and log_time tools
- Assets domain with list, get, software, and patches tools
- Technicians domain with list, get, and groups tools
- Custom domain for advanced GraphQL queries and mutations
- Support for US and EU API regions
- Bearer token authentication
- Rate limit aware error handling
