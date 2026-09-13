#!/usr/bin/env node
/**
 * Pronoia Realty — MLS Grid → listings.json sync
 *
 * Pulls active Puerto Rico listings from the MLS Grid RESO Web API, downloads and
 * resizes the photos, and writes a static listings.json that index.html renders.
 *
 * Why this exists: MLS Grid IDX rules require displays to refresh at least once
 * every 12 hours and to drop listings that have left the feed. A hardcoded array
 * in index.html can never satisfy that. This script is run on a schedule by
 * .github/workflows/sync-listings.yml.
 *
 * The access token must never reach the browser. It lives only in the GitHub
 * Actions secret MLSGRID_TOKEN.
 *
 * Usage:
 *   MLSGRID_TOKEN=xxx node scripts/sync-listings.mjs
 *   MLSGRID_TOKEN=xxx DRY_RUN=1 node scripts/sync-listings.mjs   # skip photo downloads
 *   MOCK=1 node scripts/sync-listings.mjs                        # no token, fake data
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

// ───────────────────────── config ─────────────────────────

const TOKEN = process.env.MLSGRID_TOKEN || '';
const MOCK = process.env.MOCK === '1';
const DRY_RUN = process.env.DRY_RUN === '1';

const ORIGINATING_SYSTEM = process.env.ORIGINATING_SYSTEM || 'MFRMLS'; // Stellar MLS
const MAX_LISTINGS = parseInt(process.env.MAX_LISTINGS || '100', 10);
const MAX_PHOTOS = parseInt(process.env.MAX_PHOTOS || '5', 10);
const PHOTO_WIDTH = parseInt(process.env.PHOTO_WIDTH || '1200', 10);

// Coral's Stellar MLS member ID. Listings where the list agent matches are
// flagged `isOwn` and sorted to the top — Pronoia's own listings lead, the rest
// of the market follows as standard IDX.
const LIST_AGENT_MLS_ID = process.env.LIST_AGENT_MLS_ID || '743524024';

// Optional hard filter: set ONLY_OWN=1 to show nothing but Pronoia's listings.
const ONLY_OWN = process.env.ONLY_OWN === '1';

// Optional: restrict to one office's listings by office MLS ID.
// Leave unset for a full IDX display of every active PR listing.
const LIST_OFFICE_MLS_ID = process.env.LIST_OFFICE_MLS_ID || '';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PHOTO_DIR = path.join(ROOT, 'photos');
const OUT_FILE = path.join(ROOT, 'listings.json');

const API = 'https://api.mlsgrid.com/v2/Property';

// ───────────────────────── helpers ─────────────────────────

const log = (...a) => console.log('[sync]', ...a);

function bearerHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/json',
  };
}

async function getJSON(url) {
  const res = await fetch(url, { headers: bearerHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}\n${body.slice(0, 500)}`);
  }
  return res.json();
}

/**
 * Pull every page of active listings for the originating system.
 * StateOrProvince is not filterable on MLS Grid, so we filter to PR in code.
 */
async function fetchAllListings() {
  const filter = [
    `OriginatingSystemName eq '${ORIGINATING_SYSTEM}'`,
    `StandardStatus eq Odata.Models.StandardStatus'Active'`,
  ].join(' and ');

  let url =
    `${API}?$filter=${encodeURIComponent(filter)}` +
    `&$expand=Media&$top=200&$orderby=ModificationTimestamp desc`;

  const out = [];
  let page = 0;

  while (url && out.length < MAX_LISTINGS * 6) {
    page += 1;
    const data = await getJSON(url);
    const batch = data.value || [];
    const pr = batch.filter((r) => (r.StateOrProvince || '').toUpperCase() === 'PR');
    out.push(...pr);
    log(`page ${page}: ${batch.length} records, ${pr.length} in PR (running total ${out.length})`);
    url = data['@odata.nextLink'] || null;
    if (out.length >= MAX_LISTINGS) break;
  }

  return out;
}

// ───────────────────────── photos ─────────────────────────

let sharp = null;
async function loadSharp() {
  if (sharp !== null) return sharp;
  try {
    ({ default: sharp } = await import('sharp'));
    log('sharp loaded — photos will be resized');
  } catch {
    sharp = false;
    log('sharp not available — photos will be saved at original size');
  }
  return sharp;
}

/**
 * MLS Grid media URLs are signed, single-use, and expire in about an hour, and
 * the download must carry the access token in the User-Agent header. A browser
 * <img src> can do neither — which is why photos are mirrored here and served
 * from our own origin.
 */
async function downloadPhoto(mediaUrl, destPath) {
  const res = await fetch(mediaUrl, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'User-Agent': TOKEN,
    },
  });
  if (!res.ok) throw new Error(`media ${res.status} ${res.statusText}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const s = await loadSharp();

  if (s) {
    await s(buf)
      .resize({ width: PHOTO_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 78, progressive: true })
      .toFile(destPath);
  } else {
    await fs.writeFile(destPath, buf);
  }
}

/**
 * Incremental: a photo already on disk is never re-downloaded. Keeps each
 * scheduled run's git delta to the listings that actually changed.
 */
async function syncPhotos(listing) {
  const key = listing.ListingKey;
  const dir = path.join(PHOTO_DIR, key);
  const media = (listing.Media || [])
    .filter((m) => m.MediaURL && (m.MediaCategory || 'Photo') === 'Photo')
    .sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0))
    .slice(0, MAX_PHOTOS);

  if (!media.length) return [];
  if (DRY_RUN) return media.map((_, i) => `photos/${key}/${i}.jpg`);

  await fs.mkdir(dir, { recursive: true });
  const paths = [];

  for (let i = 0; i < media.length; i++) {
    const rel = `photos/${key}/${i}.jpg`;
    const abs = path.join(ROOT, rel);
    if (fsSync.existsSync(abs)) {
      paths.push(rel);
      continue;
    }
    try {
      await downloadPhoto(media[i].MediaURL, abs);
      paths.push(rel);
    } catch (err) {
      log(`  photo ${key}/${i} failed: ${err.message}`);
    }
  }
  return paths;
}

// ───────────────────────── mapping ─────────────────────────

const EMOJI = {
  'Single Family': '🏡',
  'Condo / Apartment': '🏢',
  Townhouse: '🏘',
  'Multi-Family': '🏰',
  Land: '🌴',
};

function deriveFeatures(r) {
  const f = new Set();
  const text = [
    ...(r.PoolFeatures || []),
    ...(r.View || []),
    ...(r.WaterfrontFeatures || []),
    r.PublicRemarks || '',
  ]
    .join(' ')
    .toLowerCase();

  if ((r.PoolPrivateYN === true) || /pool/.test(text)) f.add('Pool');
  if (/ocean|sea view|water view|atlantic|caribbean/.test(text)) f.add('Ocean View');
  if (/gated|controlled access|24.?hour security/.test(text)) f.add('Gated Community');
  if (r.WaterfrontYN === true || /beachfront|beach front|oceanfront/.test(text)) f.add('Beachfront');
  if (/mountain|cordillera|hillside/.test(text)) f.add('Mountain View');

  return [...f];
}

function normalizeType(r) {
  const sub = r.PropertySubType || r.PropertyType || 'Other';
  const s = sub.toLowerCase();
  if (/condo|apartment/.test(s)) return 'Condo / Apartment';
  if (/townhouse|town home/.test(s)) return 'Townhouse';
  if (/single family|residential detached|house/.test(s)) return 'Single Family';
  if (/multi|duplex|triplex|income/.test(s)) return 'Multi-Family';
  if (/land|lot|acreage/.test(s)) return 'Land';
  return sub;
}

function mapListing(r, photos) {
  const type = normalizeType(r);
  const livingArea = r.LivingArea || r.BuildingAreaTotal || 0;
  const price = r.ListPrice || 0;

  return {
    ListingKey: r.ListingKey,
    ListingId: r.ListingId,
    ListPrice: price,
    PropertyType: type,
    BedroomsTotal: r.BedroomsTotal || 0,
    BathroomsTotalInteger: r.BathroomsTotalInteger || 0,
    LivingArea: livingArea,
    LotSizeAcres: r.LotSizeAcres ?? null,
    City: r.City || '',
    StreetNumber: r.StreetNumber || '',
    StreetName: [r.StreetDirPrefix, r.StreetName, r.StreetSuffix].filter(Boolean).join(' '),
    SubdivisionName: r.SubdivisionName || '',
    PublicRemarks: r.PublicRemarks || '',
    YearBuilt: r.YearBuilt ?? null,
    GarageSpaces: r.GarageSpaces || 0,
    StandardStatus: r.StandardStatus || 'Active',
    DaysOnMarket: r.DaysOnMarket ?? 0,
    features: deriveFeatures(r),
    pricePerSqft: livingArea > 0 ? Math.round(price / livingArea) : 0,
    emoji: EMOJI[type] || '🏠',

    // Required IDX attribution — must be displayed with the listing.
    ListOfficeName: r.ListOfficeName || '',
    ListAgentFullName: r.ListAgentFullName || '',
    ModificationTimestamp: r.ModificationTimestamp || null,

    // True when Coral is the list agent — drives the "Pronoia Realty Listing"
    // badge and top-of-results placement.
    isOwn: String(r.ListAgentMlsId || '') === String(LIST_AGENT_MLS_ID),
    photos,
  };
}

// ───────────────────────── mock ─────────────────────────

function mockRecords() {
  const cities = ['Dorado', 'San Juan', 'Rincón', 'Guaynabo', 'Fajardo'];
  return cities.map((city, i) => ({
    ListingKey: `MOCK-${1000 + i}`,
    ListingId: `MFR${1000 + i}`,
    ListPrice: 450000 + i * 275000,
    PropertySubType: i % 2 ? 'Condominium' : 'Single Family Residence',
    BedroomsTotal: 2 + (i % 4),
    BathroomsTotalInteger: 2 + (i % 3),
    LivingArea: 1200 + i * 600,
    LotSizeAcres: i % 2 ? null : 0.4,
    City: city,
    StreetNumber: `${10 + i}`,
    StreetName: 'Calle Ejemplo',
    SubdivisionName: 'Sample Subdivision',
    PublicRemarks:
      'Mock record generated locally for testing the render path. Ocean view, private pool, gated community.',
    YearBuilt: 2005 + i,
    GarageSpaces: i % 3,
    StandardStatus: 'Active',
    StateOrProvince: 'PR',
    DaysOnMarket: 5 + i * 7,
    ListOfficeName: i < 2 ? 'Pronoia Realty' : 'Sample Brokerage of PR',
    ListAgentFullName: i < 2 ? 'Coral X. Santiago Quiles' : 'Another Agent',
    ListAgentMlsId: i < 2 ? LIST_AGENT_MLS_ID : '000000',
    ModificationTimestamp: new Date().toISOString(),
    Media: [],
  }));
}

// ───────────────────────── prune ─────────────────────────

async function prunePhotos(activeKeys) {
  if (!fsSync.existsSync(PHOTO_DIR)) return 0;
  const dirs = await fs.readdir(PHOTO_DIR);
  let removed = 0;
  for (const d of dirs) {
    if (!activeKeys.has(d)) {
      await fs.rm(path.join(PHOTO_DIR, d), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

// ───────────────────────── main ─────────────────────────

async function main() {
  if (!MOCK && !TOKEN) {
    console.error(
      'MLSGRID_TOKEN is not set.\n' +
        'Add it as a GitHub Actions secret, or run with MOCK=1 to test the render path.'
    );
    process.exit(1);
  }

  let records = MOCK ? mockRecords() : await fetchAllListings();

  if (LIST_OFFICE_MLS_ID) {
    records = records.filter((r) => r.ListOfficeMlsId === LIST_OFFICE_MLS_ID);
    log(`filtered to office ${LIST_OFFICE_MLS_ID}: ${records.length} listings`);
  }

  if (ONLY_OWN) {
    records = records.filter((r) => String(r.ListAgentMlsId || '') === String(LIST_AGENT_MLS_ID));
    log(`filtered to member ${LIST_AGENT_MLS_ID}: ${records.length} listings`);
  }

  // Pronoia's own listings first, then the rest of the market.
  records.sort((a, b) => {
    const own = (r) => (String(r.ListAgentMlsId || '') === String(LIST_AGENT_MLS_ID) ? 0 : 1);
    return own(a) - own(b);
  });

  records = records.slice(0, MAX_LISTINGS);
  log(`${records.filter((r) => String(r.ListAgentMlsId || '') === String(LIST_AGENT_MLS_ID)).length} of these are Pronoia listings`);
  log(`${records.length} listings to write`);

  const listings = [];
  for (const r of records) {
    const photos = MOCK ? [] : await syncPhotos(r);
    listings.push(mapListing(r, photos));
  }

  if (!MOCK && !DRY_RUN) {
    const removed = await prunePhotos(new Set(listings.map((l) => l.ListingKey)));
    if (removed) log(`pruned photos for ${removed} listings no longer in the feed`);
  }

  const payload = {
    // Displayed verbatim as the MLS Grid "Based on information submitted to the
    // MLS GRID as of ___" line. Required on every IDX display.
    generatedAt: new Date().toISOString(),
    source: MOCK ? 'mock' : 'mlsgrid',
    originatingSystem: ORIGINATING_SYSTEM,
    count: listings.length,
    listings,
  };

  await fs.writeFile(OUT_FILE, JSON.stringify(payload, null, 1));
  log(`wrote listings.json — ${listings.length} listings, source=${payload.source}`);
}

main().catch((err) => {
  console.error('[sync] FAILED:', err.message);
  process.exit(1);
});
