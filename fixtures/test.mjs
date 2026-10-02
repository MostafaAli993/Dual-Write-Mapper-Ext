import assert from 'node:assert/strict';
import { fnoEnum, dvColumn } from './sample.mjs';
import { matchEnum, buildValueMap, valueMapJson, enumsToCsv, comparisonToCsv, normalizeLabel,
  tokenizeName, singular, noiseWords, stripNoise }
  from '../lib/core.js';

// --- normalisation ---------------------------------------------------------
assert.equal(normalizeLabel('Not submitted'), 'notsubmitted');
assert.equal(normalizeLabel('Not Submitted'), 'notsubmitted');
assert.equal(normalizeLabel('On-hold (credit)'), 'onholdcredit');
assert.equal(normalizeLabel('Réservé'), 'reserve');
assert.equal(normalizeLabel(null), '');

// --- matching --------------------------------------------------------------
const cmp = matchEnum(fnoEnum, dvColumn);

assert.equal(cmp.matched.length, 5, 'five labels line up');
assert.equal(cmp.fnoOnly.length, 1);
assert.equal(cmp.fnoOnly[0].fnoName, 'Expired');
assert.equal(cmp.dvOnly.length, 1);
assert.equal(cmp.dvOnly[0].dvLabel, 'On hold');

// case + space insensitivity actually worked
const notSub = cmp.matched.find((m) => m.fnoName === 'Draft');
assert.equal(notSub.dvValue, 750880000);

// the whole point: divergent names surfaced
const divergentNames = cmp.divergent.map((d) => d.fnoName).sort();
assert.deepEqual(divergentNames, ['Denied', 'Draft']);

// --- ValueMap shape --------------------------------------------------------
const vm = buildValueMap(cmp.matched, 'lower', 'fnoToDv');
assert.equal(vm.length, 1);
assert.equal(vm[0].transformType, 'ValueMap');
assert.deepEqual(vm[0].valueMap, {
  draft: '750880000',
  submitted: '750880001',
  approved: '750880002',
  denied: '750880003',
  cancelled: '750880004'
});
for (const v of Object.values(vm[0].valueMap)) assert.equal(typeof v, 'string');

const exact = buildValueMap(cmp.matched, 'exact', 'fnoToDv');
assert.equal(exact[0].valueMap.Draft, '750880000');

const rev = buildValueMap(cmp.matched, 'lower', 'dvToFno');
assert.equal(rev[0].valueMap['750880003'], 'denied');

// exact serialisation shape the user asked for (4-space indent)
const json = valueMapJson(cmp.matched, 'lower', 'fnoToDv');
assert.ok(json.startsWith('[\n    {\n        "transformType": "ValueMap",'), 'indent matches spec');

// --- CSV -------------------------------------------------------------------
const csv = enumsToCsv([fnoEnum, { name: 'BrokenEnum', error: 'Enum "BrokenEnum" was not found' }]);
assert.ok(csv.includes('ElementName,ElementLabel'));
assert.ok(csv.includes('Draft,Not submitted,0,YES'));
assert.ok(csv.includes('Submitted,Submitted,1,no'));
assert.ok(csv.includes('BrokenEnum'));

const ccsv = comparisonToCsv(cmp);
assert.ok(ccsv.includes('MATCHED - NAME DIVERGES'));
assert.ok(ccsv.includes('F&O ONLY'));
assert.ok(ccsv.includes('DATAVERSE ONLY'));

// --- CSV injection / quoting -----------------------------------------------
const tricky = enumsToCsv([{ name: 'X', label: 'a,b', members: [{ name: 'N', value: 1, label: 'say "hi"', labelId: null }] }]);
assert.ok(tricky.includes('"a,b"'));
assert.ok(tricky.includes('"say ""hi"""'));

// --- unlabelled F&O elements: fall back to element name vs Dataverse label ---
const unlabelled = {
  name: 'ARQ_StandardType',
  label: 'Standard type',
  members: [
    { name: 'NotSet',          value: 0, labelId: null, label: null },
    { name: 'ASTM',            value: 1, labelId: null, label: null },
    { name: 'BS',              value: 2, labelId: null, label: null },
    { name: 'RoyalCommission', value: 3, labelId: null, label: null },
    { name: 'ARAMCO',          value: 4, labelId: null, label: null },
    { name: 'SEC',             value: 5, labelId: null, label: null },
    { name: 'Others',          value: 6, labelId: null, label: null },
    { name: 'SASOASTM',        value: 7, labelId: null, label: null },
    { name: 'SASOBS',          value: 8, labelId: null, label: null }
  ]
};
const unlabelledDv = {
  tableLogicalName: 'arq_standard',
  logicalName: 'arq_standardtype',
  options: [
    { value: 750880000, label: 'ARAMCO' },
    { value: 750880001, label: 'Not Set' },
    { value: 750880002, label: 'ASTM' },
    { value: 750880003, label: 'BS' },
    { value: 750880004, label: 'Royal Commission' },
    { value: 750880005, label: 'SEC' },
    { value: 750880006, label: 'Others' },
    { value: 750880007, label: 'SASO-ASTM' },
    { value: 750880008, label: 'SASO-BS' }
  ]
};

const nf = matchEnum(unlabelled, unlabelledDv);
assert.equal(nf.matched.length, 9, 'every unlabelled element found its option by name');
assert.equal(nf.nameMatched.length, 9);
assert.equal(nf.fnoOnly.length, 0);
assert.equal(nf.dvOnly.length, 0);
assert.ok(nf.matched.every((m) => m.matchedBy === 'name'));
assert.ok(nf.matched.every((m) => m.nameDiverges === false), 'no label, so nothing can diverge');

const nfMap = buildValueMap(nf.matched, 'exact', 'fnoToDv')[0].valueMap;
assert.deepEqual(nfMap, {
  NotSet: '750880001',
  ASTM: '750880002',
  BS: '750880003',
  RoyalCommission: '750880004',
  ARAMCO: '750880000',
  SEC: '750880005',
  Others: '750880006',
  SASOASTM: '750880007',
  SASOBS: '750880008'
});

// order follows the F&O element order, not the Dataverse option order
assert.deepEqual(nf.matched.map((m) => m.fnoValue), [0, 1, 2, 3, 4, 5, 6, 7, 8]);

// the fallback can be switched off - old behaviour, empty ValueMap
const off = matchEnum(unlabelled, unlabelledDv, { nameFallback: false });
assert.equal(off.matched.length, 0);
assert.equal(off.fnoOnly.length, 9);
assert.ok(off.fnoOnly[0].reason.includes('cannot match by label'));

// a label match must win the Dataverse option over a name match
const collide = matchEnum({
  name: 'Collide',
  members: [
    { name: 'Alpha', value: 0, label: null },      // name "Alpha" -> "Alpha"
    { name: 'Beta',  value: 1, label: 'Alpha' }    // label "Alpha" -> "Alpha", wins
  ]
}, { logicalName: 'x', options: [{ value: 100, label: 'Alpha' }] });
assert.equal(collide.matched.length, 1);
assert.equal(collide.matched[0].fnoName, 'Beta');
assert.equal(collide.fnoOnly[0].fnoName, 'Alpha');
assert.ok(collide.fnoOnly[0].reason.includes('already claimed'));

const nfCsv = comparisonToCsv(nf);
assert.ok(nfCsv.includes('MatchedBy'));
assert.ok(nfCsv.includes('MATCHED - BY ELEMENT NAME'));
assert.ok(nfCsv.includes('element name'));


// --- tokenisation ----------------------------------------------------------
assert.deepEqual(tokenizeName('InternationalStandards'), ['international', 'standards']);
assert.deepEqual(tokenizeName('QM_StandardType'), ['qm', 'standard', 'type']);
assert.deepEqual(tokenizeName('SRMCCStandards'), ['srmcc', 'standards']);
assert.deepEqual(tokenizeName('SASO-ASTM'), ['saso', 'astm']);
assert.equal(singular('standards'), 'standard');
assert.equal(singular('status'), 'status');
assert.equal(singular('bs'), 'bs');

// noise words never eat the whole element name
const yesNo = noiseWords('NoYes', 'arq_posted');
assert.deepEqual(stripNoise(['yes'], yesNo), ['yes']);

// --- shared-word (near) matching -------------------------------------------
const stdEnum = {
  name: 'QM_StandardType',
  label: 'Standard type',
  members: [
    { name: 'InternationalStandards', value: 1, labelId: null, label: null },
    { name: 'NationalStandards',      value: 2, labelId: null, label: null },
    { name: 'SRMCCStandards',         value: 4, labelId: null, label: null }
  ]
};
const stdDv = {
  tableLogicalName: 'arq_mixstandard',
  logicalName: 'arq_standardtype',
  displayName: 'Standard Type',
  options: [
    { value: 750880000, label: 'National' },
    { value: 750880001, label: 'International' },
    { value: 750880002, label: 'SRMCC' }
  ]
};

const std = matchEnum(stdEnum, stdDv);
assert.equal(std.matched.length, 3, 'all three placed once shared words are dropped');
assert.equal(std.fuzzyMatched.length, 3);
assert.equal(std.fnoOnly.length, 0);
assert.equal(std.dvOnly.length, 0);
assert.deepEqual(buildValueMap(std.matched, 'exact', 'fnoToDv')[0].valueMap, {
  InternationalStandards: '750880001',
  NationalStandards: '750880000',
  SRMCCStandards: '750880002'
});
// "National" must NOT be swallowed by "International"
const nat = std.matched.find((m) => m.fnoName === 'NationalStandards');
assert.equal(nat.dvLabel, 'National');
assert.ok(nat.matchNote.includes('national'));

// switching the near-match pass off leaves the old, empty result
const strict = matchEnum(stdEnum, stdDv, { fuzzy: false });
assert.equal(strict.matched.length, 0);
assert.equal(strict.fnoOnly.length, 3);

// near matches are flagged, not silently mixed in with exact ones
const stdCsv = comparisonToCsv(std);
assert.ok(stdCsv.includes('MATCHED - NEAR MATCH (REVIEW)'));
assert.ok(stdCsv.includes('near match'));

// a genuinely unrelated element still does not get forced into a pair
const oneLeft = matchEnum(
  { name: 'QM_StandardType', members: [{ name: 'Zebra', value: 9, label: null }] },
  stdDv
);
assert.equal(oneLeft.matched.length, 0);
assert.equal(oneLeft.fnoOnly.length, 1);

// exact passes still win over the fuzzy one
const mixed = matchEnum(
  { name: 'QM_StandardType', members: [
    { name: 'SRMCCStandards', value: 1, label: null },
    { name: 'SRMCC',          value: 2, label: null }
  ] },
  stdDv
);
const exactHit = mixed.matched.find((m) => m.fnoName === 'SRMCC');
assert.equal(exactHit.matchedBy, 'name', 'the exact name match takes the SRMCC option');
assert.equal(mixed.matched.find((m) => m.fnoName === 'SRMCCStandards'), undefined);


console.log('\nAll assertions passed.\n');
console.log(json);
