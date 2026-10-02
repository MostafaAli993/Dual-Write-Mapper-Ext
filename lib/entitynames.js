/* =============================================================================
 * Entity name resolution - pure functions, no network.
 *
 * An F&O data entity has three names and each tool shows a different one:
 *
 *   AOT name              RMTaxRegistrationOnCustomerEntity   Data management "Target entity"
 *   Public entity name    RMCustomerRegisteration             OData type / Metadata REST API
 *   Public collection     RMCustomerRegisterations            Power Automate Fin & Ops connector,
 *                                                             /data/<collection> URLs
 *
 * The developer sets the last two freely, so they need not resemble the first
 * (and may be misspelled). This file matches whatever the user typed against
 * all three, exactly and then fuzzily.
 *
 * Plain script (no import/export) so the same file loads as a content script
 * next to content.js, as a <script> in the panel, and under Node for tests.
 * ========================================================================== */

(function (root) {
  'use strict';

  const NOISE_TOKENS = new Set(['entity', 'entities']);

  /** Lowercase, alphanumerics only. */
  function norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /** "RMTaxRegistrationOnCustomerEntity" -> ["rm","tax","registration","on","customer"] */
  function tokens(s) {
    const raw = String(s || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .map((t) => t.toLowerCase())
      .filter(Boolean);
    return raw
      .filter((t) => !NOISE_TOKENS.has(t))
      // collections are plural: RMCustomerRegisterations -> registeration
      .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  function charSimilarity(a, b) {
    if (!a || !b) return 0;
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  }

  /**
   * Token overlap weighted by token length, tolerant of typos inside a token
   * ("registration" ~ "registeration") and of word order.
   */
  function tokenSimilarity(qTokens, cTokens) {
    if (!qTokens.length || !cTokens.length) return 0;
    const used = new Set();
    let matched = 0;
    for (const q of qTokens) {
      let best = 0, bestIdx = -1;
      cTokens.forEach((c, i) => {
        if (used.has(i)) return;
        const s = q === c ? 1 : (Math.min(q.length, c.length) >= 4 ? charSimilarity(q, c) : 0);
        if (s > best) { best = s; bestIdx = i; }
      });
      if (best >= 0.8) {
        used.add(bestIdx);
        matched += best * (q.length + cTokens[bestIdx].length) / 2;
      }
    }
    const total = qTokens.reduce((n, t) => n + t.length, 0) + cTokens.reduce((n, t) => n + t.length, 0);
    return (2 * matched) / total;
  }

  function stripEntity(n) {
    return n.replace(/entity$/, '');
  }

  /** Similarity 0..1 between what was typed and one name. */
  function nameScore(query, name) {
    if (!name) return 0;
    const q = stripEntity(norm(query));
    const n = stripEntity(norm(name));
    if (!q || !n) return 0;
    if (q === n) return 1;
    const singular = (x) => x.replace(/s$/, '');
    if (singular(q) === singular(n)) return 0.99;
    const ch = charSimilarity(q, n);
    const tk = tokenSimilarity(tokens(query), tokens(name));
    const contains = (q.length >= 5 && n.includes(q)) || (n.length >= 5 && q.includes(n))
      ? 0.6 + 0.3 * Math.min(q.length, n.length) / Math.max(q.length, n.length)
      : 0;
    return Math.max(ch, tk, contains);
  }

  const NAME_FIELDS = [
    ['name', 'AOT name'],
    ['publicEntityName', 'public entity name'],
    ['publicCollectionName', 'public collection name']
  ];

  /**
   * Exact match, ignoring case, on any of the three names. Also accepts the
   * AOT name typed without its "Entity" suffix.
   */
  function findExact(rows, typed) {
    const q = norm(typed);
    if (!q) return null;
    for (const [field, label] of NAME_FIELDS) {
      const hit = rows.find((r) => norm(r[field]) === q);
      if (hit) return { row: hit, matchedOn: label };
    }
    const hit = rows.find((r) => norm(r.name) === q + 'entity');
    if (hit) return { row: hit, matchedOn: 'AOT name (without "Entity")' };
    return null;
  }

  /** Best fuzzy candidates across all three names, highest score first. */
  function rankCandidates(rows, typed, { limit = 15, minScore = 0.55 } = {}) {
    const out = [];
    for (const r of rows) {
      let best = 0, on = null;
      for (const [field, label] of NAME_FIELDS) {
        const s = nameScore(typed, r[field]);
        if (s > best) { best = s; on = label; }
      }
      if (best >= minScore) out.push({ row: r, score: Math.round(best * 100) / 100, matchedOn: on });
    }
    out.sort((a, b) => b.score - a.score || String(a.row.name).localeCompare(String(b.row.name)));
    return out.slice(0, limit);
  }

  /** How different the Power Automate name is from what Data management shows. */
  function nameDivergence(row) {
    if (!row || !row.publicCollectionName) return null;
    const aot = stripEntity(norm(row.name));
    const pub = norm(row.publicEntityName);
    const col = norm(row.publicCollectionName);
    if (col === aot + 's' || col === aot || pub === aot) return null;
    return 'The Power Automate name does not start from the AOT name - searching the connector dropdown for the Data management name will not find it.';
  }

  /** Split a pasted block into names: newlines, commas, semicolons, tabs. */
  function parseNames(text) {
    const seen = new Set();
    return String(text || '')
      .split(/[\n,;\t]+/)
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter((s) => {
        if (!s) return false;
        const k = s.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  }

  function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function lookupsToCsv(results) {
    const head = ['Typed', 'Result', 'Matched on', 'AOT name (Data management)', 'Public entity name (OData type)',
      'Public collection name (Power Automate)', 'Label', 'Category', 'OData enabled', 'Data management enabled',
      'Read-only', 'Live /data check', 'Note'];
    const lines = [head.map(csvCell).join(',')];
    for (const r of results) {
      const e = r.entity || {};
      const result = r.status === 'found' ? 'found' : r.status === 'fuzzy' ? 'closest match (verify)' : r.status;
      lines.push([
        r.input, result, r.matchedOn || '', e.name, e.publicEntityName, e.publicCollectionName, e.label,
        e.entityCategory, e.dataServiceEnabled === undefined ? '' : (e.dataServiceEnabled ? 'yes' : 'no'),
        e.dataManagementEnabled === undefined ? '' : (e.dataManagementEnabled ? 'yes' : 'no'),
        e.isReadOnly === undefined ? '' : (e.isReadOnly ? 'yes' : 'no'),
        r.verify ? r.verify.summary : '', (r.notes || []).join(' ')
      ].map(csvCell).join(','));
      if (r.status !== 'found') {
        for (const c of r.candidates || []) {
          lines.push(['', `candidate ${c.score}`, c.matchedOn, c.row.name, c.row.publicEntityName,
            c.row.publicCollectionName, c.row.label || '', c.row.entityCategory, '', '', '', '', ''].map(csvCell).join(','));
        }
      }
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  const api = {
    norm, tokens, levenshtein, charSimilarity, tokenSimilarity, nameScore,
    findExact, rankCandidates, nameDivergence, parseNames, lookupsToCsv
  };

  root.DWEntityNames = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
