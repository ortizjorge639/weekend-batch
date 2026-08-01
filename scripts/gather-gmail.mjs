#!/usr/bin/env node
/**
 * gather-gmail.mjs — Weekly Batch Gmail gatherer
 * Reads starred Gmail messages from the past 7 days,
 * merges prior state, folds updates.json, writes batches/<week>.json.
 * Safe to run without credentials: logs and exits 0.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { itemId, dedup, foldUpdates, mergePriorState } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Guard: exit 0 cleanly if credentials are missing
// ---------------------------------------------------------------------------
const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
if (!GMAIL_REFRESH_TOKEN) {
  console.log('[batch] GMAIL_REFRESH_TOKEN is not set — skipping Gmail sync (safe, no-op).');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// BLOCK regex — skip auth codes and sensitive topics
// ---------------------------------------------------------------------------
const BLOCK = /\b(otp|one[-\s]?time|verification code|2fa|security code|login code|reset your password|religio|ethnic|immigration|health record|sexual orientation)\b/i;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function saturdayWindow() {
  const now = new Date();
  // "to" = most recent Saturday (or today if Saturday)
  const dayOfWeek = now.getUTCDay(); // 0=Sun … 6=Sat
  const daysToSat = (dayOfWeek + 1) % 7; // days since last Saturday
  const to = new Date(now);
  to.setUTCDate(now.getUTCDate() - daysToSat);
  const from = new Date(to);
  from.setUTCDate(to.getUTCDate() - 7);
  return { from: isoDate(from), to: isoDate(to) };
}

// ---------------------------------------------------------------------------
// Rule-based spar/act templates
// ---------------------------------------------------------------------------
function buildSpar(subject, snippet) {
  const s = (subject + ' ' + snippet).toLowerCase();
  if (/reward|claim|\$\d/.test(s)) {
    return [['Is expert-network research worth the time?', 'Value vs. effort']];
  }
  if (/newsletter|digest|weekender/.test(s)) {
    return [
      ['What\'s the sharpest take here?', 'Find the one argument worth debating'],
      ['Counter the headline thesis', 'Steel-man the opposite view'],
    ];
  }
  return [
    ['What\'s the core claim?', 'Distil to one sentence'],
    ['What does this change for my work?', 'Practical implication'],
  ];
}

function buildAct(subject, snippet) {
  const s = (subject + ' ' + snippet).toLowerCase();
  if (/reward|claim|\$\d/.test(s)) {
    return [
      ['Add to my to-dos with deadline', 'Claim before it expires'],
      ['Draft a profile update for higher-paying studies', 'Per their suggestion'],
    ];
  }
  if (/newsletter|digest|weekender/.test(s)) {
    return [
      ['Give me the 3-min version', 'Tight summary'],
      ['Pull the best reshare-worthy quote', 'One line'],
    ];
  }
  return [
    ['Summarise in 3 bullet points', 'For my reference'],
    ['Flag if there\'s a follow-up action', 'What do I actually do with this?'],
  ];
}

// ---------------------------------------------------------------------------
// Gmail fetch
// ---------------------------------------------------------------------------
async function fetchStarredEmails(from, to) {
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth });

  const query = `is:starred after:${from} before:${to}`;
  console.log(`[batch] Gmail query: ${query}`);

  const listRes = await gmail.users.threads.list({
    userId: 'me',
    q: query,
    maxResults: 100,
  });

  const threads = listRes.data.threads || [];
  console.log(`[batch] Found ${threads.length} starred thread(s).`);

  const items = [];
  for (const t of threads) {
    const tRes = await gmail.users.threads.get({
      userId: 'me',
      id: t.id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date'],
    });
    const msg = tRes.data.messages[0];
    const headers = Object.fromEntries(
      (msg.payload?.headers || []).map(h => [h.name, h.value])
    );
    const subject = headers['Subject'] || '(no subject)';
    const snippet = msg.snippet || '';
    const from2 = headers['From'] || '';
    const dateStr = headers['Date'] || '';

    // Block sensitive / auth-code emails
    if (BLOCK.test(subject) || BLOCK.test(snippet)) {
      console.log(`[batch] BLOCKED: ${subject}`);
      continue;
    }

    const url = `https://mail.google.com/mail/u/0/#all/thread-f:${t.id}`;
    const id = itemId(url);

    // Parse author / handle from From header
    const authorMatch = from2.match(/^"?([^"<]+)"?\s*<(.+)>$/);
    const author = authorMatch ? authorMatch[1].trim() : from2;
    const handle = 'Starred';

    // When: short human date from Date header
    let when = dateStr ? new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

    items.push({
      itemId: id,
      type: 'mail',
      source: 'Starred Email',
      when,
      author,
      handle,
      title: subject,
      quote: snippet.slice(0, 280),
      tags: [],
      url,
      state: 'new',
      threads: [],
      spar: buildSpar(subject, snippet),
      act: buildAct(subject, snippet),
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { from, to } = saturdayWindow();
  const week = to;
  console.log(`[batch] Week: ${week}  Window: ${from} → ${to}`);

  // --- Load all prior week files → build priorItemsById ---
  const batchesIndexPath = resolve(ROOT, 'batches/index.json');
  const batchesIndex = JSON.parse(readFileSync(batchesIndexPath, 'utf8'));
  const priorItemsById = new Map();
  for (const w of batchesIndex) {
    if (w === week) continue;
    const p = resolve(ROOT, `batches/${w}.json`);
    if (!existsSync(p)) continue;
    const wObj = JSON.parse(readFileSync(p, 'utf8'));
    for (const item of [...(wObj.bookmarks || []), ...(wObj.emails || [])]) {
      if (item.itemId) priorItemsById.set(item.itemId, item);
    }
  }

  // --- Load current week file (if any) for bookmarks + existing emails ---
  const weekPath = resolve(ROOT, `batches/${week}.json`);
  let weekObj = {
    week,
    window: { from, to },
    syncedAt: { emails: null, bookmarks: null },
    bookmarks: [],
    emails: [],
  };
  if (existsSync(weekPath)) {
    weekObj = JSON.parse(readFileSync(weekPath, 'utf8'));
  }

  // --- Fold updates.json into current week ---
  const updatesPath = resolve(ROOT, 'updates.json');
  let updates = [];
  if (existsSync(updatesPath)) {
    updates = JSON.parse(readFileSync(updatesPath, 'utf8'));
  }
  if (updates.length > 0) {
    console.log(`[batch] Folding ${updates.length} update(s) into ${week}.`);
    foldUpdates(weekObj, updates);
    writeFileSync(updatesPath, '[]\n', 'utf8');
    console.log('[batch] updates.json truncated to [].');
  }

  // --- Fetch new emails ---
  const toPlus1 = isoDate(new Date(new Date(to).getTime() + 86400000));
  let newEmails;
  try {
    newEmails = await fetchStarredEmails(from, toPlus1);
  } catch (err) {
    console.error('[batch] Gmail fetch error:', err.message);
    process.exit(1);
  }

  // --- Merge prior state into new emails ---
  mergePriorState(newEmails, priorItemsById);

  // --- Merge with existing emails (prior state already applied via weekObj fold) ---
  // Combine new + existing (for any manually added or prior-run emails)
  const combined = dedup([...newEmails, ...(weekObj.emails || [])]);

  // Sort: newest→oldest (items with "To-do"-style tags last)
  combined.sort((a, b) => {
    const aIsTodo = (a.tags || []).some(t => /to.?do|expires|claim/i.test(t));
    const bIsTodo = (b.tags || []).some(t => /to.?do|expires|claim/i.test(t));
    if (aIsTodo !== bIsTodo) return aIsTodo ? 1 : -1;
    return 0;
  });

  // --- Write ONLY emails + syncedAt.emails; preserve bookmarks + syncedAt.bookmarks ---
  weekObj.emails = combined;
  weekObj.syncedAt = {
    bookmarks: weekObj.syncedAt?.bookmarks || null,
    emails: new Date().toISOString(),
  };

  writeFileSync(weekPath, JSON.stringify(weekObj, null, 2) + '\n', 'utf8');
  console.log(`[batch] Wrote ${weekPath}`);

  // --- Update batches/index.json (unshift week if new) ---
  if (!batchesIndex.includes(week)) {
    batchesIndex.unshift(week);
    writeFileSync(batchesIndexPath, JSON.stringify(batchesIndex) + '\n', 'utf8');
    console.log(`[batch] Added ${week} to batches/index.json`);
  }

  console.log('[batch] Done.');
}

main().catch(err => {
  console.error('[batch] Fatal:', err);
  process.exit(1);
});
