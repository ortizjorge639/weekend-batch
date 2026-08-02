import { createHash } from 'crypto';

/**
 * Compute stable itemId: first 12 hex chars of SHA-256(url).
 * @param {string} url
 * @returns {string}
 */
export function itemId(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 12);
}

/**
 * Deduplicate items: drop later dupes by itemId, then by first 60 chars of lowercased title.
 * @param {Array} items
 * @returns {Array}
 */
export function dedup(items) {
  const seenIds = new Set();
  const seenTitles = new Set();
  const result = [];
  for (const item of items) {
    if (seenIds.has(item.itemId)) continue;
    const titleKey = (item.title || '').toLowerCase().slice(0, 60);
    if (seenTitles.has(titleKey)) continue;
    seenIds.add(item.itemId);
    seenTitles.add(titleKey);
    result.push(item);
  }
  return result;
}

/**
 * Apply updates.json entries to items in weekObj (bookmarks + emails).
 * For each entry: find item by itemId; if state present, set it; if thread present, push it.
 * Returns the mutated weekObj.
 * @param {object} weekObj
 * @param {Array} updates
 * @returns {object}
 */
export function foldUpdates(weekObj, updates) {
  const allItems = [...(weekObj.bookmarks || []), ...(weekObj.emails || [])];
  const byId = new Map(allItems.map(i => [i.itemId, i]));
  for (const entry of updates) {
    const item = byId.get(entry.itemId);
    if (!item) continue;
    if (entry.state != null) {
      item.state = entry.state;
    }
    if (entry.thread != null) {
      if (!Array.isArray(item.threads)) item.threads = [];
      item.threads.push(entry.thread);
    }
  }
  return weekObj;
}

/**
 * For each new item, if priorItemsById[itemId] exists, carry forward its state and threads.
 * @param {Array} newItems
 * @param {Map|object} priorItemsById  Map or plain object keyed by itemId
 * @returns {Array}
 */
export function mergePriorState(newItems, priorItemsById) {
  const lookup = priorItemsById instanceof Map
    ? (id) => priorItemsById.get(id)
    : (id) => priorItemsById[id];
  for (const item of newItems) {
    const prior = lookup(item.itemId);
    if (prior) {
      item.state = prior.state;
      item.threads = prior.threads ? [...prior.threads] : [];
    }
  }
  return newItems;
}
