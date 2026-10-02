/* =============================================================================
 * F&O entity field list -> recommended Dataverse column types.
 *
 * Pure logic only: no network, no DOM. Node-testable.
 *
 * Everything here is ADVISORY. The tool never creates anything; it tells
 * Mostafa what to create.
 * ========================================================================== */

import { csvFromRows } from './core.js';

/** Dataverse column type vocabulary, used on both sides of the comparison. */
export const DV = {
  TEXT: 'Single Line of Text',
  MEMO: 'Multiple Lines of Text',
  WHOLE: 'Whole Number',
  DECIMAL: 'Decimal Number',
  FLOAT: 'Floating Point Number',
  CURRENCY: 'Currency',
  CHOICE: 'Choice',
  YESNO: 'Yes/No',
  DATEONLY: 'Date Only',
  DATETIME: 'Date and Time',
  LOOKUP: 'Lookup',
  UNIQUEID: 'Unique Identifier',
  UNKNOWN: 'Unknown'
};

/** Dataverse limits that actually bite. */
export const LIMITS = {
  TEXT_MAX: 4000,           // Single Line of Text ceiling
  WHOLE_MIN: -2147483648,   // Dataverse Whole Number is 32-bit
  WHOLE_MAX: 2147483647
};

const TZI = 'Time Zone Independent';

// -----------------------------------------------------------------------------
// Name normalisation
// -----------------------------------------------------------------------------

/**
 * Compare an F&O field name against a Dataverse column logical name.
 * Strips the publisher prefix, lowercases, drops non-alphanumerics.
 *   "CUSTOMERACCOUNT" and "arq_customeraccount" -> "customeraccount"
 */
export function normalizeFieldName(name, prefix = 'arq_') {
  let s = String(name || '').toLowerCase();
  const p = String(prefix || '').toLowerCase();
  if (p && s.startsWith(p)) s = s.slice(p.length);
  return s.replace(/[^a-z0-9]/g, '');
}

/** Suggest a CE logical name for an F&O field. */
export function suggestLogicalName(fnoName, prefix = 'arq_') {
  return prefix + String(fnoName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Suggest a human display name: CUSTOMERACCOUNT / CustomerAccount -> "Customer Account". */
export function suggestDisplayName(fnoName) {
  const raw = String(fnoName || '');
  if (!raw) return '';
  // ALLCAPS names carry no word boundaries; leave them title-cased as one word
  // unless they contain separators.
  if (/^[A-Z0-9_]+$/.test(raw)) {
    return raw.split(/[_\s]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
      .join(' ');
  }
  return raw
    .replace(/[_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

// -----------------------------------------------------------------------------
// Type recommendation
// -----------------------------------------------------------------------------

function normType(p) {
  return String(p.dataType || p.typeName || '').toLowerCase().split('.').pop();
}

/**
 * Recommend a Dataverse column type for one F&O property.
 *
 * @param {object} prop  {name, dataType, typeName, enumName, isKey, isMandatory,
 *                        allowEdit, allowEditOnCreate, isDimension}
 * @param {object} edm   optional {maxLength, precision, scale} from $metadata;
 *                       null/undefined values mean "not published"
 */
export function recommendColumn(prop, edm = {}) {
  const t = normType(prop);
  const notes = [];
  const rec = {
    fnoName: prop.name,
    fnoType: prop.dataType || prop.typeName || 'unknown',
    enumName: prop.enumName || null,
    maxLength: edm.maxLength ?? null,
    precision: edm.precision ?? null,
    scale: edm.scale ?? null,
    dvType: DV.UNKNOWN,
    behavior: null,
    valueMapNeeded: false,
    notMappable: false,
    raw: prop,
    notes
  };

  switch (t) {
    case 'string': {
      if (rec.maxLength === null) {
        rec.dvType = DV.TEXT;
        notes.push('Length not published by this environment - confirm the F&O string length before creating the column. Dataverse defaults to 100, which silently truncates longer F&O values.');
      } else if (rec.maxLength > LIMITS.TEXT_MAX) {
        rec.dvType = DV.MEMO;
        notes.push(`F&O length ${rec.maxLength} exceeds the ${LIMITS.TEXT_MAX} ceiling for Single Line of Text.`);
      } else {
        rec.dvType = DV.TEXT;
      }
      break;
    }
    case 'int32':
    case 'int':
    case 'integer':
      rec.dvType = DV.WHOLE;
      break;

    case 'int64':
    case 'long':
      rec.dvType = DV.WHOLE;
      notes.push(`Int64 on the F&O side. Dataverse Whole Number is 32-bit (max ${LIMITS.WHOLE_MAX.toLocaleString('en-US')}); check the real value range before you commit to this type, or the sync will fail on the first row that exceeds it.`);
      break;

    case 'decimal':
      rec.dvType = DV.DECIMAL;
      if (rec.precision === null && rec.scale === null) {
        notes.push('Precision/scale not published - confirm with the F&O developer. Dataverse Decimal supports up to 10 decimal places.');
      }
      break;

    case 'real':
      // X++ Real is fixed-point, not a float.
      rec.dvType = DV.DECIMAL;
      notes.push('F&O Real is fixed-point, not floating point. Decimal Number avoids the rounding drift that Floating Point introduces on amounts and quantities. Use Floating Point only for genuinely approximate values.');
      break;

    case 'enum': {
      const isNoYes = String(prop.enumName || '').toLowerCase().endsWith('noyes');
      if (isNoYes) {
        rec.dvType = DV.YESNO;
        rec.valueMapNeeded = true;
        notes.push('NoYes surfaced as an enum-typed property, not a boolean. If F&O sends the string "yes"/"no" against a CE Yes/No column you will get a DIPV1030 type mismatch - in that case create a Choice and add a ValueMap instead.');
      } else {
        rec.dvType = DV.CHOICE;
        rec.valueMapNeeded = true;
        notes.push('ValueMap transform required. The AOT element names may differ from the labels - check them in the Enums section before writing the map.');
      }
      break;
    }

    case 'boolean':
    case 'bool':
      rec.dvType = DV.YESNO;
      break;

    case 'date':
      rec.dvType = DV.DATEONLY;
      rec.behavior = TZI;
      notes.push('Set Behavior to Time Zone Independent. Behavior is immutable once the column is created, and User Local produces off-by-one-day errors across time zones.');
      break;

    case 'datetime':
    case 'utcdatetime':
      rec.dvType = DV.DATETIME;
      rec.behavior = TZI;
      notes.push('Set Behavior to Time Zone Independent. Behavior is immutable once the column is created - getting this wrong means dropping and recreating it.');
      break;

    case 'guid':
      rec.dvType = DV.TEXT;
      rec.maxLength = rec.maxLength ?? 36;
      notes.push('Dataverse has no creatable GUID column type. Use text of length 36 and keep the F&O formatting consistent (with or without braces) on both sides.');
      break;

    case 'container':
    case 'blob':
    case 'binary':
      rec.dvType = null;
      rec.notMappable = true;
      notes.push('Container/binary fields are not mappable through dual-write. Exclude this field from the map.');
      break;

    default:
      rec.dvType = DV.UNKNOWN;
      notes.push(`Unrecognised F&O type "${rec.fnoType}" - decide the CE type by hand.`);
  }

  // --- structural notes, independent of type ---
  if (prop.isKey) {
    notes.push('Key field. Likely part of the dual-write integration key, so the CE column must exist and be populated before the map will save.');
  }
  if (prop.isMandatory) {
    notes.push('Mandatory in F&O. CE must always supply a value or the write is rejected.');
  }
  const allowEdit = prop.allowEdit !== false;
  const allowCreate = prop.allowEditOnCreate !== false;
  if (!allowEdit && !allowCreate) {
    notes.push('Read-only in F&O. CE->F&O writes on this field will fail; map it F&O->CE only.');
  } else if (!allowEdit && allowCreate) {
    notes.push('Settable on create only. CE->F&O updates to this field will be rejected after the record exists.');
  }
  if (prop.isDimension) {
    notes.push('Financial dimension field - these usually need their own handling rather than a plain column map.');
  }

  return rec;
}

/** Recommend for a whole entity. */
export function recommendEntity(props, edmByProp = {}) {
  return props.map((p) => recommendColumn(p, edmByProp[p.name] || edmByProp[String(p.name).toLowerCase()] || {}));
}

// -----------------------------------------------------------------------------
// Dataverse attribute metadata -> our vocabulary
// -----------------------------------------------------------------------------

export function dvAttributeTypeToLabel(attr) {
  const t = String(attr.AttributeType || '').toLowerCase();
  switch (t) {
    case 'string': return DV.TEXT;
    case 'memo': return DV.MEMO;
    case 'integer': return DV.WHOLE;
    case 'bigint': return DV.WHOLE;
    case 'decimal': return DV.DECIMAL;
    case 'double': return DV.FLOAT;
    case 'money': return DV.CURRENCY;
    case 'picklist': return DV.CHOICE;
    case 'state':
    case 'status': return DV.CHOICE;
    case 'boolean': return DV.YESNO;
    case 'datetime':
      return String(attr.Format || '').toLowerCase() === 'dateonly' ? DV.DATEONLY : DV.DATETIME;
    case 'lookup':
    case 'customer':
    case 'owner': return DV.LOOKUP;
    case 'uniqueidentifier': return DV.UNIQUEID;
    default: return attr.AttributeType || DV.UNKNOWN;
  }
}

function dvLabel(l) {
  if (!l) return null;
  const u = l.UserLocalizedLabel;
  if (u && typeof u.Label === 'string') return u.Label;
  const f = (l.LocalizedLabels || [])[0];
  return f && typeof f.Label === 'string' ? f.Label : null;
}

export function simplifyDvAttribute(a) {
  return {
    logicalName: a.LogicalName,
    schemaName: a.SchemaName,
    displayName: dvLabel(a.DisplayName),
    type: dvAttributeTypeToLabel(a),
    rawType: a.AttributeType,
    maxLength: typeof a.MaxLength === 'number' ? a.MaxLength : null,
    precision: typeof a.Precision === 'number' ? a.Precision : null,
    behavior: a.DateTimeBehavior ? (a.DateTimeBehavior.Value || null) : null,
    isCustom: a.IsCustomAttribute === true,
    isPrimaryId: a.IsPrimaryId === true,
    isValidForCreate: a.IsValidForCreate !== false
  };
}

// -----------------------------------------------------------------------------
// Comparison
// -----------------------------------------------------------------------------

/**
 * Compare recommended F&O columns against the attributes that already exist on
 * a CE table.
 *
 * Buckets, in the order they matter:
 *   missingInCe     - the columns still to create (the point of the exercise)
 *   typeMismatch    - exists but the type is wrong
 *   sizeMismatch    - type is right, length/precision differs
 *   matched         - fine
 *   ceOnly          - CE columns with no F&O counterpart
 */
export function compareFields(recs, dvAttrs, { prefix = 'arq_', includeSystem = false } = {}) {
  const attrs = (includeSystem ? dvAttrs : dvAttrs.filter((a) => a.isCustom || a.isPrimaryId));

  const byName = new Map();
  for (const a of attrs) {
    const k = normalizeFieldName(a.logicalName, prefix);
    if (k && !byName.has(k)) byName.set(k, a);
  }

  const missingInCe = [];
  const typeMismatch = [];
  const sizeMismatch = [];
  const matched = [];
  const usedKeys = new Set();

  for (const r of recs) {
    if (r.notMappable) continue;
    const k = normalizeFieldName(r.fnoName, prefix);
    const hit = k ? byName.get(k) : null;

    if (!hit) {
      missingInCe.push(r);
      continue;
    }
    usedKeys.add(k);

    // A NoYes recommendation is deliberately ambiguous; accept either.
    const acceptable = r.dvType === DV.YESNO && r.valueMapNeeded
      ? [DV.YESNO, DV.CHOICE]
      : [r.dvType];

    if (!acceptable.includes(hit.type)) {
      typeMismatch.push({ ...r, ceColumn: hit, actualType: hit.type, recommendedType: r.dvType });
      continue;
    }

    const lengthOff = r.maxLength !== null && hit.maxLength !== null && r.maxLength !== hit.maxLength;
    const precOff = r.precision !== null && hit.precision !== null && r.precision !== hit.precision;
    const behaviorOff = r.behavior !== null && hit.behavior !== null &&
      String(hit.behavior).toLowerCase() !== 'timezoneindependent' &&
      (r.dvType === DV.DATEONLY || r.dvType === DV.DATETIME);

    if (lengthOff || precOff || behaviorOff) {
      sizeMismatch.push({
        ...r,
        ceColumn: hit,
        issues: [
          lengthOff ? `length: CE ${hit.maxLength} vs F&O ${r.maxLength}` : null,
          precOff ? `precision: CE ${hit.precision} vs F&O ${r.precision}` : null,
          behaviorOff ? `behavior: CE "${hit.behavior}" - dual-write generally wants Time Zone Independent` : null
        ].filter(Boolean)
      });
      continue;
    }

    matched.push({ ...r, ceColumn: hit });
  }

  const ceOnly = attrs
    .filter((a) => !usedKeys.has(normalizeFieldName(a.logicalName, prefix)))
    .map((a) => ({ ceColumn: a }));

  return { missingInCe, typeMismatch, sizeMismatch, matched, ceOnly };
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------


/** Full field list CSV, for the F&O developer or a design document. */
export function fieldsToCsv(entityName, recs) {
  const headers = [
    'Entity', 'FnOField', 'FnOType', 'EnumName', 'MaxLength', 'Precision', 'Scale',
    'IsKey', 'IsMandatory', 'AllowEdit', 'AllowEditOnCreate',
    'RecommendedDataverseType', 'DateTimeBehavior', 'ValueMapNeeded', 'Mappable', 'Notes'
  ];
  const rows = recs.map((r) => ({
    Entity: entityName,
    FnOField: r.fnoName,
    FnOType: r.fnoType,
    EnumName: r.enumName ?? '',
    MaxLength: r.maxLength ?? 'not published',
    Precision: r.precision ?? 'not published',
    Scale: r.scale ?? 'not published',
    IsKey: r.raw?.isKey ? 'YES' : 'no',
    IsMandatory: r.raw?.isMandatory ? 'YES' : 'no',
    AllowEdit: r.raw?.allowEdit === false ? 'NO' : 'yes',
    AllowEditOnCreate: r.raw?.allowEditOnCreate === false ? 'NO' : 'yes',
    RecommendedDataverseType: r.notMappable ? 'NOT MAPPABLE' : (r.dvType ?? ''),
    DateTimeBehavior: r.behavior ?? '',
    ValueMapNeeded: r.valueMapNeeded ? 'YES' : 'no',
    Mappable: r.notMappable ? 'no' : 'yes',
    Notes: (r.notes || []).join(' | ')
  }));
  return csvFromRows(headers, rows);
}

/** The work list: only the CE columns that still need creating. */
export function checklistToCsv(entityName, missing, prefix = 'arq_') {
  const headers = [
    'Done', 'SuggestedLogicalName', 'SuggestedDisplayName', 'DataverseType',
    'MaxLength', 'Precision', 'Behavior', 'Required', 'ValueMapNeeded', 'FnOField', 'FnOType', 'Notes'
  ];
  const rows = missing.map((r) => ({
    Done: '',
    SuggestedLogicalName: suggestLogicalName(r.fnoName, prefix),
    SuggestedDisplayName: suggestDisplayName(r.fnoName),
    DataverseType: r.dvType ?? '',
    MaxLength: r.maxLength ?? '',
    Precision: r.precision ?? '',
    Behavior: r.behavior ?? '',
    Required: r.raw?.isMandatory ? 'Business Required' : 'Optional',
    ValueMapNeeded: r.valueMapNeeded ? 'YES' : 'no',
    FnOField: r.fnoName,
    FnOType: r.fnoType,
    Notes: (r.notes || []).join(' | ')
  }));
  return csvFromRows(headers, rows);
}

/** Comparison CSV covering every bucket. */
export function fieldComparisonToCsv(entityName, table, cmp) {
  const headers = [
    'Entity', 'DataverseTable', 'Status', 'FnOField', 'FnOType',
    'RecommendedType', 'CEColumn', 'CEType', 'CEMaxLength', 'CEPrecision', 'CEBehavior', 'Detail'
  ];
  const base = { Entity: entityName, DataverseTable: table };
  const rows = [];

  for (const r of cmp.missingInCe) rows.push({
    ...base, Status: 'MISSING IN CE - CREATE THIS', FnOField: r.fnoName, FnOType: r.fnoType,
    RecommendedType: r.dvType ?? '', CEColumn: '', CEType: '', CEMaxLength: '', CEPrecision: '', CEBehavior: '',
    Detail: (r.notes || []).join(' | ')
  });
  for (const r of cmp.typeMismatch) rows.push({
    ...base, Status: 'TYPE MISMATCH', FnOField: r.fnoName, FnOType: r.fnoType,
    RecommendedType: r.recommendedType ?? '', CEColumn: r.ceColumn.logicalName, CEType: r.actualType,
    CEMaxLength: r.ceColumn.maxLength ?? '', CEPrecision: r.ceColumn.precision ?? '', CEBehavior: r.ceColumn.behavior ?? '',
    Detail: `CE column is ${r.actualType}, recommendation is ${r.recommendedType}`
  });
  for (const r of cmp.sizeMismatch) rows.push({
    ...base, Status: 'SIZE / BEHAVIOR MISMATCH', FnOField: r.fnoName, FnOType: r.fnoType,
    RecommendedType: r.dvType ?? '', CEColumn: r.ceColumn.logicalName, CEType: r.ceColumn.type,
    CEMaxLength: r.ceColumn.maxLength ?? '', CEPrecision: r.ceColumn.precision ?? '', CEBehavior: r.ceColumn.behavior ?? '',
    Detail: (r.issues || []).join(' | ')
  });
  for (const r of cmp.matched) rows.push({
    ...base, Status: 'OK', FnOField: r.fnoName, FnOType: r.fnoType,
    RecommendedType: r.dvType ?? '', CEColumn: r.ceColumn.logicalName, CEType: r.ceColumn.type,
    CEMaxLength: r.ceColumn.maxLength ?? '', CEPrecision: r.ceColumn.precision ?? '', CEBehavior: r.ceColumn.behavior ?? '',
    Detail: ''
  });
  for (const r of cmp.ceOnly) rows.push({
    ...base, Status: 'CE ONLY', FnOField: '', FnOType: '',
    RecommendedType: '', CEColumn: r.ceColumn.logicalName, CEType: r.ceColumn.type,
    CEMaxLength: r.ceColumn.maxLength ?? '', CEPrecision: r.ceColumn.precision ?? '', CEBehavior: r.ceColumn.behavior ?? '',
    Detail: 'No F&O field with a matching name'
  });

  return csvFromRows(headers, rows);
}
