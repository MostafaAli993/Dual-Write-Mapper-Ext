import assert from 'node:assert/strict';
import {
  DV, recommendColumn, recommendEntity, compareFields, normalizeFieldName,
  suggestLogicalName, suggestDisplayName, simplifyDvAttribute, dvAttributeTypeToLabel,
  fieldsToCsv, checklistToCsv, fieldComparisonToCsv
} from '../lib/fields.js';

const P = (o) => ({ isKey:false, isMandatory:false, allowEdit:true, allowEditOnCreate:true, ...o });

// --- the four corrections we agreed --------------------------------------
{
  const r = recommendColumn(P({ name:'Qty', dataType:'Real' }));
  assert.equal(r.dvType, DV.DECIMAL, 'Real must NOT become Floating Point');
  assert.ok(r.notes.join(' ').includes('fixed-point'));
}
{
  const r = recommendColumn(P({ name:'RecId', dataType:'Int64' }));
  assert.equal(r.dvType, DV.WHOLE);
  assert.ok(r.notes.join(' ').includes('32-bit'), 'Int64 overflow must be flagged');
}
{
  const r = recommendColumn(P({ name:'FIXEDQTY', dataType:'Enum', enumName:'NoYes' }));
  assert.equal(r.dvType, DV.YESNO);
  assert.equal(r.valueMapNeeded, true);
  assert.ok(r.notes.join(' ').includes('DIPV1030'), 'NoYes must warn about the real error code');
}
{
  const d = recommendColumn(P({ name:'DueDate', dataType:'Date' }));
  assert.equal(d.dvType, DV.DATEONLY);
  assert.equal(d.behavior, 'Time Zone Independent');
  const dt = recommendColumn(P({ name:'CreatedDateTime', dataType:'UtcDateTime' }));
  assert.equal(dt.dvType, DV.DATETIME);
  assert.equal(dt.behavior, 'Time Zone Independent');
  assert.ok(dt.notes.join(' ').includes('immutable'));
}

// --- the rest of the mapping table ---------------------------------------
assert.equal(recommendColumn(P({name:'A',dataType:'String'}), {maxLength:20}).dvType, DV.TEXT);
assert.equal(recommendColumn(P({name:'A',dataType:'String'}), {maxLength:8000}).dvType, DV.MEMO);
assert.equal(recommendColumn(P({name:'A',dataType:'Int32'})).dvType, DV.WHOLE);
assert.equal(recommendColumn(P({name:'A',dataType:'Decimal'})).dvType, DV.DECIMAL);
assert.equal(recommendColumn(P({name:'A',dataType:'Enum',enumName:'SalesStatus'})).dvType, DV.CHOICE);
assert.equal(recommendColumn(P({name:'A',dataType:'Boolean'})).dvType, DV.YESNO);
assert.equal(recommendColumn(P({name:'A',dataType:'Guid'})).dvType, DV.TEXT);
assert.equal(recommendColumn(P({name:'A',dataType:'Guid'})).maxLength, 36);
{
  const c = recommendColumn(P({name:'A',dataType:'Container'}));
  assert.equal(c.notMappable, true);
  assert.equal(c.dvType, null, 'must not recommend a type for containers');
}

// --- honesty about missing length ----------------------------------------
{
  const r = recommendColumn(P({name:'Name',dataType:'String'}));  // no edm
  assert.equal(r.maxLength, null, 'must not invent a length');
  assert.ok(r.notes.join(' ').includes('not published'));
  assert.ok(r.notes.join(' ').includes('truncates'));
}

// --- structural notes -----------------------------------------------------
{
  const n = recommendColumn(P({name:'X',dataType:'String',isKey:true,isMandatory:true,allowEdit:false,allowEditOnCreate:false})).notes.join(' ');
  assert.ok(n.includes('integration key'));
  assert.ok(n.includes('Mandatory'));
  assert.ok(n.includes('Read-only'));
}
{
  const n = recommendColumn(P({name:'X',dataType:'String',allowEdit:false,allowEditOnCreate:true})).notes.join(' ');
  assert.ok(n.includes('create only'));
}

// --- name helpers ---------------------------------------------------------
assert.equal(normalizeFieldName('CUSTOMERACCOUNT'), 'customeraccount');
assert.equal(normalizeFieldName('arq_customeraccount'), 'customeraccount');
assert.equal(suggestLogicalName('CUSTOMERACCOUNT'), 'arq_customeraccount');
assert.equal(suggestDisplayName('CUSTOMERACCOUNT'), 'Customeraccount');
assert.equal(suggestDisplayName('SalesContractNumber'), 'Sales Contract Number');
assert.equal(suggestDisplayName('CASH_SALES_ID'), 'Cash Sales Id');

// --- comparison -----------------------------------------------------------
const props = [
  P({ name:'CASHSALESID', dataType:'String', isKey:true }),
  P({ name:'FIXEDQTY',    dataType:'Enum', enumName:'NoYes' }),
  P({ name:'SALESPRICE',  dataType:'Real' }),
  P({ name:'INVENTSITEID',dataType:'String' }),
  P({ name:'NOTES',       dataType:'Container' })
];
const recs = recommendEntity(props, { SALESPRICE: { precision: 2 }, CASHSALESID: { maxLength: 20 } });

const dvAttrs = [
  { LogicalName:'arq_salescontractnumber', AttributeType:'String', MaxLength:100, IsCustomAttribute:true },
  { LogicalName:'arq_fixedquantity',       AttributeType:'Boolean', IsCustomAttribute:true },
  { LogicalName:'arq_salesprice',          AttributeType:'Double',  IsCustomAttribute:true },
  { LogicalName:'arq_cashsalesid',         AttributeType:'String', MaxLength:20, IsCustomAttribute:true },
  { LogicalName:'arq_legacyflag',          AttributeType:'Boolean', IsCustomAttribute:true },
  { LogicalName:'createdon',               AttributeType:'DateTime', IsCustomAttribute:false }
].map(simplifyDvAttribute);

const cmp = compareFields(recs, dvAttrs);

// container excluded from every bucket
assert.ok(!JSON.stringify(cmp).includes('NOTES'), 'not-mappable fields stay out of the comparison');

// the columns still to create
const missing = cmp.missingInCe.map((m) => m.fnoName).sort();
assert.deepEqual(missing, ['FIXEDQTY','INVENTSITEID']);

// type mismatch: Real recommended Decimal, CE has Double (Floating Point)
assert.equal(cmp.typeMismatch.length, 1);
assert.equal(cmp.typeMismatch[0].fnoName, 'SALESPRICE');
assert.equal(cmp.typeMismatch[0].actualType, DV.FLOAT);
assert.equal(cmp.typeMismatch[0].recommendedType, DV.DECIMAL);

// matched with the right length
assert.equal(cmp.matched.length, 1);
assert.equal(cmp.matched[0].fnoName, 'CASHSALESID');

// CE-only
const ceOnly = cmp.ceOnly.map((c) => c.ceColumn.logicalName).sort();
assert.ok(ceOnly.includes('arq_legacyflag'));
assert.ok(ceOnly.includes('arq_salescontractnumber'));
assert.ok(!ceOnly.includes('createdon'), 'system columns excluded by default');

// size mismatch detection
{
  const r2 = recommendEntity([P({name:'CODE',dataType:'String'})], { CODE:{ maxLength:10 } });
  const a2 = [{ LogicalName:'arq_code', AttributeType:'String', MaxLength:100, IsCustomAttribute:true }].map(simplifyDvAttribute);
  const c2 = compareFields(r2, a2);
  assert.equal(c2.sizeMismatch.length, 1);
  assert.ok(c2.sizeMismatch[0].issues[0].includes('CE 100 vs F&O 10'));
}

// datetime behavior mismatch
{
  const r3 = recommendEntity([P({name:'DELIVERYDATE',dataType:'Date'})]);
  const a3 = [{ LogicalName:'arq_deliverydate', AttributeType:'DateTime', Format:'DateOnly',
                DateTimeBehavior:{ Value:'UserLocal' }, IsCustomAttribute:true }].map(simplifyDvAttribute);
  const c3 = compareFields(r3, a3);
  assert.equal(c3.sizeMismatch.length, 1);
  assert.ok(c3.sizeMismatch[0].issues.join(' ').includes('Time Zone Independent'));
}

// NoYes accepts either Yes/No or Choice on the CE side
{
  const r4 = recommendEntity([P({name:'FIXEDQTY',dataType:'Enum',enumName:'NoYes'})]);
  for (const t of ['Boolean','Picklist']) {
    const a4 = [{ LogicalName:'arq_fixedqty', AttributeType:t, IsCustomAttribute:true }].map(simplifyDvAttribute);
    assert.equal(compareFields(r4, a4).typeMismatch.length, 0, `${t} should be accepted for NoYes`);
  }
}

// --- exports --------------------------------------------------------------
const fcsv = fieldsToCsv('RM_SalesContract', recs);
assert.ok(fcsv.includes('RecommendedDataverseType'));
assert.ok(fcsv.includes('not published'), 'unknown length must say so in the CSV');
assert.ok(fcsv.includes('NOT MAPPABLE'));

const ccsv = checklistToCsv('RM_SalesContract', cmp.missingInCe);
assert.ok(ccsv.includes('arq_fixedqty'));
assert.ok(ccsv.includes('arq_inventsiteid'));
assert.ok(ccsv.startsWith('﻿Done,'), 'checklist leads with a Done column');

const xcsv = fieldComparisonToCsv('RM_SalesContract', 'arq_salescontracts', cmp);
assert.ok(xcsv.includes('MISSING IN CE - CREATE THIS'));
assert.ok(xcsv.includes('TYPE MISMATCH'));
assert.ok(xcsv.includes('CE ONLY'));

console.log('All field-mapping assertions passed.');
