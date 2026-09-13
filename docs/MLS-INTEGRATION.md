# Pronoia Realty — Stellar MLS Integration

How live Stellar MLS listings get onto www.pronoiarealty.com, and why the pipeline
is shaped the way it is.

---

## The rules that decide the architecture

From the MLS Grid IDX Rules and the MLS Grid AI Use Addendum. None of these are optional.

| Rule | Consequence for this site |
|---|---|
| IDX displays must refresh **at least once every 12 hours** and drop listings removed from the feed | A hardcoded `LISTINGS` array can never comply. A scheduled sync is mandatory. |
| Displays must carry **"Based on information submitted to the MLS GRID as of \_\_\_"** plus the listing brokerage name | `listings.json` carries `generatedAt`; the page renders it and "Listed by {ListOfficeName}" on every card. |
| "Listings courtesy of Stellar MLS as distributed by MLS GRID" must appear on the first page displaying listings | Rendered under the results grid and in the footer. |
| Participants must make reasonable efforts to **prevent scraping** | Never point automation at Stellar Central. The feed is the only legitimate source. |
| MLS Grid data **may not be used for AI training** without express authorization | Do not feed `listings.json`, photos, or remarks into model training. Sign the AI Use Addendum before using any AI tool against this data. |
| An AI tool **may not cache, store or retain** MLS Grid data beyond one user query | Any future AI search feature must be stateless per query. |

---

## Three technical constraints

1. **Auth is a token, not a login.** MLS Grid uses `Authorization: Bearer <token>`. The
   token lives under the **Access Token** tab at app.mlsgrid.com.

2. **The browser cannot call the API.** Putting the token in `index.html` publishes it in
   view-source and breaks the license. MLS Grid blocks browser-origin requests anyway.

3. **MLS photos cannot be hot-linked.** Media downloads must send the access token in the
   `User-Agent` header, and the signed URLs are single-use and expire in about an hour. An
   `<img src>` can do neither. Photos are mirrored into `photos/` and served from our origin.

---

## The pipeline

```
GitHub Actions — every 8 hours (margin against the 12-hour rule)
   │  MLSGRID_TOKEN held as an encrypted repository secret
   ▼
scripts/sync-listings.mjs
   ├─ GET /v2/Property?$filter=…&$expand=Media    → active listings, filtered to PR in code
   └─ GET each MediaURL with User-Agent: <token>  → photos, resized to 1200px
   ▼
writes  listings.json  +  photos/<ListingKey>/0..4.jpg
   ▼
commits to main (only when something actually changed)
   ▼
Render auto-deploys (~2 min)
   ▼
index.html fetches listings.json, renders listings + attribution + "as of" timestamp
```

The site stays a static site on Render's free tier. Nothing about hosting changes. This
also replaces the Zapier → GitHub hop that kept failing on the SHA issue.

---

## Setup — three steps

### 1. Add the token to GitHub

`github.com/Marauder67/Pronoia-Realty` → **Settings → Secrets and variables → Actions →
New repository secret**

| Name | Value |
|---|---|
| `MLSGRID_TOKEN` | the token from the **Access Token** tab at app.mlsgrid.com |

Never paste the token into a file, a chat, or the project notes. The secret box is the
only place it belongs.

### 2. Confirm the originating system

Every MLS Grid query names exactly one `OriginatingSystemName`. Stellar MLS is `MFRMLS`.
If the subscription page shows something else, add a repository **variable** named
`ORIGINATING_SYSTEM` with that value.

### 3. Run it once by hand

**Actions** tab → **Sync MLS listings** → **Run workflow**. The log prints records per
page, how many were in Puerto Rico, and how many are Pronoia's own. Then it commits and
Render deploys.

Locally:

```bash
MLSGRID_TOKEN=your_token node scripts/sync-listings.mjs
MLSGRID_TOKEN=your_token DRY_RUN=1 node scripts/sync-listings.mjs   # data only, no photos
MOCK=1 node scripts/sync-listings.mjs                               # no token, fake data
```

---

## Knobs

Repository **variables** (Settings → Secrets and variables → Actions → Variables), or env
vars when running locally.

| Variable | Default | What it does |
|---|---|---|
| `ORIGINATING_SYSTEM` | `MFRMLS` | Which MLS to query |
| `LIST_AGENT_MLS_ID` | `743524024` | Coral's member ID — flags her listings `isOwn`, badges them "Pronoia Realty Listing", sorts them first |
| `ONLY_OWN` | off | `1` shows **only** Pronoia's listings instead of the full market |
| `LIST_OFFICE_MLS_ID` | unset | Restrict to one office by office MLS ID |
| `MAX_LISTINGS` | 100 | Cap on listings kept — guards repo size |
| `MAX_PHOTOS` | 5 | Photos kept per listing |
| `PHOTO_WIDTH` | 1200 | Resize width in px |
| `DRY_RUN` | off | Skip photo downloads |

**Repo size.** Photos are synced incrementally — a photo already on disk is never
re-downloaded, and listings that leave the feed have their folders pruned. Each run's git
delta is only the listings that actually changed. At 100 × 5 × ~150 KB the steady state is
roughly 75 MB. If the repo passes ~1 GB, move photos to object storage (Cloudflare R2 free
tier is 10 GB) and point `listings.json` at those URLs — a small change to the script, none
to the site.

---

## Data mapping

`scripts/sync-listings.mjs` maps RESO fields onto the exact shape `index.html` already
rendered, so the swap is transparent.

| Site field | Source |
|---|---|
| `ListPrice`, `BedroomsTotal`, `City`, `YearBuilt`, … | straight from RESO |
| `PublicRemarks` | the listing description, verbatim |
| `PropertyType` | `PropertySubType` normalized, falling back to `PropertyType` |
| `LivingArea` | `LivingArea`, falling back to `BuildingAreaTotal` |
| `features` | derived from `PoolFeatures`, `View`, `WaterfrontYN`, and remarks text |
| `pricePerSqft` | computed |
| `photos` | local paths written by the sync |
| `ListOfficeName` | **required attribution** — shown on every card and in the modal |
| `isOwn` | `ListAgentMlsId` matches `LIST_AGENT_MLS_ID` |

`StateOrProvince` is not a filterable field on MLS Grid, so the script pulls actives and
filters to Puerto Rico in code.

---

## Failure behavior

If `listings.json` is missing, empty, or unreachable, the site falls back to the 18 sample
listings **and labels them plainly**: "Sample properties shown for demonstration — these
are not MLS listings." The MLS Grid attribution block stays hidden in that state, because
showing MLS attribution over non-MLS data would itself be a violation. A failed sync never
takes the site down and never misrepresents sample data as MLS data.

---

## Open item: the password gate

Gating listings behind a password turns the site from **IDX** into a **VOW**, and VOW rules
are different:

- A VOW requires its own authorization from Stellar MLS, separate from IDX.
- A VOW generally requires **individual registration** — each consumer supplies a name and
  a valid email, agrees to terms, and establishes a broker–consumer relationship with
  Coral. One shared password handed to everyone is not compliant.
- A password checked in JavaScript on a static site is not a gate. Anyone can read it in
  view-source or request `listings.json` directly.

A real gate means a small Render Web Service (still free tier) holding the data behind a
session check. Get IDX live first, confirm the data and photos look right, then add
registration once Stellar confirms Coral's VOW authorization.

---

## Housekeeping

The GitHub personal access token is written in plain text in the Claude project notes.
Rotate it (GitHub → Settings → Developer settings → Tokens) and keep the replacement out
of any document.

---

*Sources: MLS Grid IDX Rules · MLS Grid AI Use Addendum · MLS Grid API v2.0 docs ·
Changes to MLS Grid Media Access*
