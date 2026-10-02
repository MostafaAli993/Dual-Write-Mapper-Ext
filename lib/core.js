/* =============================================================================
 * Pure logic: label normalisation, matching, ValueMap generation, CSV.
 * No network, no DOM - so it can be unit-tested in Node as well as the panel.
 * ========================================================================== */

/**
 * Normalise a label for comparison: case-insensitive, diacritics folded,
 * everything that is not a letter or digit removed.
 *   "Not submitted"  -> "notsubmitted"
 *   "On-hold (credit)" -> "onholdcredit"
 */
export function normalizeLabel(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Tokenise an AOT name or a label into lowercase words.
 *   "InternationalStandards" -> ['international','standards']
 *   "QM_StandardType"        -> ['qm','standard','type']
 *   "SRMCCStandards"         -> ['srmcc','standards']
 *   "SASO-ASTM"              -> ['saso','astm']
 */
export function tokenizeName(s) {
  if (s === null || s === undefined) return [];
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

const SINGULAR_KEEP = new Set(['status', 'address', 'process', 'class', 'gas', 'bs', 'others', 'sales', 'analysis']);

/** Crude singulariser, only good enough to make "standards" and "standard" the same word. */
export function singular(t) {
  if (SINGULAR_KEEP.has(t)) return t;
  if (/ies$/.test(t) && t.length > 4) return t.slice(0, -3) + 'y';
  if (/(ses|xes|zes|ches|shes)$/.test(t)) return t.slice(0, -2);
  if (/s$/.test(t) && !/ss$/.test(t) && t.length > 3) return t.slice(0, -1);
  return t;
}

/**
 * Words that carry no meaning inside THIS enum, taken from the enum name and the
 * Dataverse column name. For enum `QM_StandardType` on column `arq_standardtype`
 * ("Standard Type") that is {qm, standard, type, arq, standardtype}, which is what
 * turns element `NationalStandards` into `national` so it can meet option `National`.
 */
export function noiseWords(...names) {
  const set = new Set();
  for (const n of names) {
    for (const t of tokenizeName(n)) {
      if (t.length < 2) continue;
      set.add(singular(t));
    }
  }
  return set;
}

/** Drop noise words from the front and back of a token list, never emptying it. */
export function stripNoise(tokens, noise) {
  let out = tokens.slice();
  let changed = true;
  while (changed && out.length > 1) {
    changed = false;
    if (noise.has(singular(out[0]))) { out = out.slice(1); changed = true; continue; }
    if (noise.has(singular(out[out.length - 1]))) { out = out.slice(0, -1); changed = true; }
  }
  return out;
}

function strippedKey(s, noise) {
  const t = stripNoise(tokenizeName(s), noise).map(singular).join('');
  return t.replace(/[^a-z0-9]/g, '');
}

/**
 * Cross-reference F&O enum members against Dataverse option-set options.
 *
 * Four passes, each one only touching what the previous ones could not place, and
 * each Dataverse option claimed at most once (earlier, more trustworthy passes win):
 *
 *   1. label   - F&O element label      vs Dataverse option label
 *   2. name    - F&O AOT element name   vs Dataverse option label   (opts.nameFallback)
 *   3. fuzzy   - same, after dropping words the enum/column name repeats, so
 *                `NationalStandards` meets `National`                (opts.fuzzy)
 *   4. fuzzy   - same, allowing one stripped key to contain the other when exactly
 *                one candidate qualifies and the lengths are close   (opts.fuzzy)
 *
 * Passes 3 and 4 are guesses: they only fire when exactly one Dataverse option
 * qualifies, and every pair they produce is tagged so it can be reviewed.
 *
 * @param {{name:string, members:Array<{name:string,value:number,label:?string}>}} fnoEnum
 * @param {{logicalName:string, options:Array<{value:number,label:?string}>}} dvColumn
 * @param {{nameFallback?:boolean, fuzzy?:boolean}} [opts]
 */
export function matchEnum(fnoEnum, dvColumn, opts = {}) {
  const nameFallback = opts.nameFallback !== false;
  const fuzzy = opts.fuzzy !== false;

  const dvByLabel = new Map();
  const dvAmbiguous = new Set();
  for (const o of dvColumn.options) {
    const k = normalizeLabel(o.label);
    if (!k) continue;
    if (dvByLabel.has(k)) dvAmbiguous.add(k);
    else dvByLabel.set(k, o);
  }

  const noise = noiseWords(fnoEnum.name, dvColumn.logicalName, dvColumn.displayName);

  const members = fnoEnum.members || [];
  const slots = new Array(members.length).fill(null);
  const usedDvValues = new Set();
  const fnoOnly = [];

  const record = (i, m, hit, key, matchedBy, matchNote) => {
    usedDvValues.add(hit.value);
    slots[i] = {
      fnoName: m.name,
      fnoValue: m.value,
      fnoLabel: m.label,
      dvValue: hit.value,
      dvLabel: hit.label,
      matchedBy,
      matchNote: matchNote || '',
      nameDiverges: m.label ? normalizeLabel(m.name) !== normalizeLabel(m.label) : false,
      ambiguous: dvAmbiguous.has(key)
    };
  };

  // --- pass 1: F&O label -> Dataverse label ---------------------------------
  let pending = [];
  members.forEach((m, i) => {
    const key = normalizeLabel(m.label);
    const hit = key ? dvByLabel.get(key) : undefined;
    if (hit) record(i, m, hit, key, 'label');
    else pending.push(i);
  });

  // --- pass 2: AOT element name -> Dataverse label --------------------------
  let pending2 = [];
  for (const i of pending) {
    const m = members[i];
    const key = nameFallback ? normalizeLabel(m.name) : '';
    const hit = key ? dvByLabel.get(key) : undefined;
    if (hit && !usedDvValues.has(hit.value)) record(i, m, hit, key, 'name', `element name "${m.name}" = Dataverse label "${hit.label}"`);
    else pending2.push(i);
  }

  // --- pass 3: same, ignoring words the enum / column name repeats ----------
  const strippedDv = new Map();
  const strippedDvAmbiguous = new Set();
  if (fuzzy) {
    for (const o of dvColumn.options) {
      if (usedDvValues.has(o.value)) continue;
      const k = strippedKey(o.label, noise);
      if (!k) continue;
      if (strippedDv.has(k)) strippedDvAmbiguous.add(k);
      else strippedDv.set(k, o);
    }
  }

  let pending3 = [];
  for (const i of pending2) {
    const m = members[i];
    if (!fuzzy) { pending3.push(i); continue; }

    const sources = [];
    if (m.label) sources.push(['label', m.label]);
    if (nameFallback) sources.push(['element name', m.name]);

    let done = false;
    for (const [what, raw] of sources) {
      const k = strippedKey(raw, noise);
      if (!k || strippedDvAmbiguous.has(k)) continue;
      const hit = strippedDv.get(k);
      if (!hit || usedDvValues.has(hit.value)) continue;
      record(i, m, hit, k, 'fuzzy', `${what} "${raw}" reduced to "${k}" = Dataverse "${hit.label}" (shared words ignored)`);
      done = true;
      break;
    }
    if (!done) pending3.push(i);
  }

  // --- pass 4: one stripped key contains the other, single candidate only ---
  for (const i of pending3) {
    const m = members[i];
    let hit = null, key = '', note = '';

    if (fuzzy) {
      const sources = [];
      if (m.label) sources.push(['label', m.label]);
      if (nameFallback) sources.push(['element name', m.name]);

      for (const [what, raw] of sources) {
        const k = strippedKey(raw, noise);
        if (k.length < 4) continue;
        const cands = dvColumn.options.filter((o) => {
          if (usedDvValues.has(o.value)) return false;
          const ok = strippedKey(o.label, noise);
          if (ok.length < 4) return false;
          if (!(ok.includes(k) || k.includes(ok))) return false;
          const ratio = Math.min(k.length, ok.length) / Math.max(k.length, ok.length);
          return ratio >= 0.7;
        });
        if (cands.length === 1) {
          hit = cands[0];
          key = k;
          note = `${what} "${raw}" reduced to "${k}", the only near match for Dataverse "${cands[0].label}"`;
          break;
        }
      }
    }

    if (hit) { record(i, m, hit, key, 'fuzzy', note); continue; }

    const exactKey = normalizeLabel(m.label) || (nameFallback ? normalizeLabel(m.name) : '');
    const taken = exactKey ? dvByLabel.get(exactKey) : undefined;

    let reason;
    if (taken && usedDvValues.has(taken.value)) {
      reason = `Matches Dataverse label "${taken.label}", but that option was already claimed by an earlier, stronger match`;
    } else if (m.label) {
      reason = nameFallback
        ? 'No Dataverse option matches this label or the element name, even ignoring shared words'
        : 'No Dataverse option with a matching label';
    } else {
      reason = nameFallback
        ? 'F&O element has no resolvable label, and the element name matches no Dataverse label, even ignoring shared words'
        : 'F&O element has no resolvable label, cannot match by label';
    }
    fnoOnly.push({ fnoName: m.name, fnoValue: m.value, fnoLabel: m.label, reason });
  }

  const matched = slots.filter(Boolean);

  const dvOnly = dvColumn.options
    .filter((o) => !usedDvValues.has(o.value))
    .map((o) => ({
      dvValue: o.value,
      dvLabel: o.label,
      reason: nameFallback
        ? 'No F&O element matches this label by label, by element name or by near match'
        : 'No F&O element with a matching label'
    }));

  return {
    fnoEnum: fnoEnum.name,
    dvTable: dvColumn.tableLogicalName || null,
    dvColumn: dvColumn.logicalName,
    matched,
    fnoOnly,
    dvOnly,
    // The whole point of the tool: these are the ones that silently break ValueMaps.
    divergent: matched.filter((m) => m.nameDiverges),
    nameMatched: matched.filter((m) => m.matchedBy === 'name'),
    fuzzyMatched: matched.filter((m) => m.matchedBy === 'fuzzy'),
    nameFallbackUsed: nameFallback,
    fuzzyUsed: fuzzy,
    noiseWords: [...noise],
    ambiguousLabels: [...dvAmbiguous]
  };
}

/**
 * Build dual-write ValueMap transform JSON.
 *
 * @param {Array} matched      output of matchEnum().matched
 * @param {'lower'|'exact'} casing   how to emit the F&O element name key
 * @param {'fnoToDv'|'dvToFno'} direction
 */
export function buildValueMap(matched, casing = 'lower', direction = 'fnoToDv') {
  const key = (n) => (casing === 'lower' ? String(n).toLowerCase() : String(n));
  const valueMap = {};

  for (const m of matched) {
    if (direction === 'fnoToDv') {
      valueMap[key(m.fnoName)] = String(m.dvValue);
    } else {
      valueMap[String(m.dvValue)] = key(m.fnoName);
    }
  }

  return [{ transformType: 'ValueMap', valueMap }];
}

export function valueMapJson(matched, casing, direction) {
  return JSON.stringify(buildValueMap(matched, casing, direction), null, 4);
}

// -----------------------------------------------------------------------------
// CSV
// -----------------------------------------------------------------------------

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function csvFromRows(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(','));
  // BOM so Excel opens UTF-8 labels correctly.
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/** Flat CSV of every enum / element / label / value. */
export function enumsToCsv(enums) {
  const headers = [
    'EnumName', 'EnumLabel', 'ElementName', 'ElementLabel',
    'ElementValue', 'NameDivergesFromLabel', 'LabelId', 'Error'
  ];
  const rows = [];
  for (const e of enums) {
    if (e.error) {
      rows.push({ EnumName: e.name, Error: e.error });
      continue;
    }
    if (!e.members.length) {
      rows.push({ EnumName: e.name, EnumLabel: e.label ?? '', Error: 'No members returned' });
      continue;
    }
    for (const m of e.members) {
      rows.push({
        EnumName: e.name,
        EnumLabel: e.label ?? '',
        ElementName: m.name,
        ElementLabel: m.label ?? '',
        ElementValue: m.value,
        NameDivergesFromLabel:
          m.label ? (normalizeLabel(m.name) !== normalizeLabel(m.label) ? 'YES' : 'no') : 'unknown',
        LabelId: m.labelId ?? '',
        Error: ''
      });
    }
  }
  return csvFromRows(headers, rows);
}

/** CSV of a cross-reference result. */
export function comparisonToCsv(cmp) {
  const headers = [
    'FnOEnum', 'DataverseTable', 'DataverseColumn', 'Status', 'MatchedBy',
    'FnOElementName', 'FnOLabel', 'FnOValue',
    'DataverseValue', 'DataverseLabel', 'NameDivergesFromLabel', 'Note'
  ];
  const base = { FnOEnum: cmp.fnoEnum, DataverseTable: cmp.dvTable ?? '', DataverseColumn: cmp.dvColumn };
  const rows = [];

  for (const m of cmp.matched) {
    const notes = [];
    if (m.ambiguous) notes.push('Multiple Dataverse options share this label');
    if (m.matchNote) notes.push(m.matchNote);
    if (m.matchedBy === 'fuzzy') notes.push('REVIEW THIS PAIR - matched on a reduced name, not an exact one');
    const status = m.matchedBy === 'fuzzy' ? 'MATCHED - NEAR MATCH (REVIEW)'
      : m.matchedBy === 'name' ? 'MATCHED - BY ELEMENT NAME'
      : (m.nameDiverges ? 'MATCHED - NAME DIVERGES' : 'MATCHED');
    rows.push({
      ...base,
      Status: status,
      MatchedBy: m.matchedBy === 'fuzzy' ? 'near match' : m.matchedBy === 'name' ? 'element name' : 'label',
      FnOElementName: m.fnoName, FnOLabel: m.fnoLabel ?? '', FnOValue: m.fnoValue,
      DataverseValue: m.dvValue, DataverseLabel: m.dvLabel ?? '',
      NameDivergesFromLabel: m.fnoLabel ? (m.nameDiverges ? 'YES' : 'no') : 'unknown',
      Note: notes.join('; ')
    });
  }
  for (const f of cmp.fnoOnly) {
    rows.push({
      ...base, Status: 'F&O ONLY', MatchedBy: '',
      FnOElementName: f.fnoName, FnOLabel: f.fnoLabel ?? '', FnOValue: f.fnoValue,
      DataverseValue: '', DataverseLabel: '', NameDivergesFromLabel: '', Note: f.reason
    });
  }
  for (const d of cmp.dvOnly) {
    rows.push({
      ...base, Status: 'DATAVERSE ONLY', MatchedBy: '',
      FnOElementName: '', FnOLabel: '', FnOValue: '',
      DataverseValue: d.dvValue, DataverseLabel: d.dvLabel ?? '',
      NameDivergesFromLabel: '', Note: d.reason
    });
  }
  return csvFromRows(headers, rows);
}
