/* Entity-name matcher + the content-script lookup job against a fake F&O. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const EN = require('../lib/entitynames.js');

// --- the real SRMCC case ------------------------------------------------------
const ROWS = [
  { name: 'RMTaxRegistrationOnCustomerEntity', publicEntityName: 'RMCustomerRegisteration', publicCollectionName: 'RMCustomerRegisterations', labelId: '@RM1', entityCategory: 'Master', dataServiceEnabled: true, dataManagementEnabled: true, isReadOnly: false },
  { name: 'ARQ_TaxRegistrationOnVendorEntity', publicEntityName: 'ARQ_TaxRegistrationOnVendor', publicCollectionName: 'ARQ_TaxRegistrationOnVendors', labelId: null, entityCategory: 'Master', dataServiceEnabled: true, dataManagementEnabled: true, isReadOnly: false },
  { name: 'RM_CredManCreditLimitAdjTableEntity', publicEntityName: 'RMCreditLimitAdjTable', publicCollectionName: 'RMCreditLimitAdjTables', labelId: null, entityCategory: 'Document', dataServiceEnabled: true, dataManagementEnabled: true, isReadOnly: false },
  { name: 'TaxRegistrationEntity', publicEntityName: 'TaxRegistration', publicCollectionName: 'TaxRegistrations', labelId: null, entityCategory: 'Master', dataServiceEnabled: true, dataManagementEnabled: true, isReadOnly: false },
  { name: 'HiddenStagingEntity', publicEntityName: null, publicCollectionName: null, labelId: null, entityCategory: 'Transaction', dataServiceEnabled: false, dataManagementEnabled: true, isReadOnly: false }
];

// exact, any of the three names, any casing
assert.equal(EN.findExact(ROWS, 'RMTaxRegistrationOnCustomerEntity').row.publicCollectionName, 'RMCustomerRegisterations');
assert.equal(EN.findExact(ROWS, 'rmtaxregistrationoncustomerentity').matchedOn, 'AOT name');
assert.equal(EN.findExact(ROWS, 'RMCustomerRegisteration').matchedOn, 'public entity name');
assert.equal(EN.findExact(ROWS, 'RMCustomerRegisterations').matchedOn, 'public collection name');
// what Mostafa first typed as a custom value in Power Automate
assert.equal(EN.findExact(ROWS, 'RMTaxRegistrationOnCustomer').row.name, 'RMTaxRegistrationOnCustomerEntity');
assert.equal(EN.findExact(ROWS, 'TaxRegistrationOnCustomer'), null);

// fuzzy: correct spelling of the misspelled public name, and word order
const f1 = EN.rankCandidates(ROWS, 'RMCustomerRegistrations');
assert.equal(f1[0].row.name, 'RMTaxRegistrationOnCustomerEntity', 'typo-tolerant');
const f2 = EN.rankCandidates(ROWS, 'TaxRegistrationOnCustomer');
assert.equal(f2[0].row.name, 'RMTaxRegistrationOnCustomerEntity', 'finds it from words of the AOT name');
assert.ok(f2[0].score > f2[1].score);
assert.deepEqual(EN.rankCandidates(ROWS, 'SalesOrderHeaderV2'), [], 'nothing close -> empty');

// tokens
assert.deepEqual(EN.tokens('RMTaxRegistrationOnCustomerEntity'), ['rm', 'tax', 'registration', 'on', 'customer']);
assert.deepEqual(EN.tokens('ARQ_TaxRegistrationOnVendors'), ['arq', 'tax', 'registration', 'on', 'vendor']);

// divergence note only where the PA name does not derive from the AOT name
assert.ok(EN.nameDivergence(ROWS[0]));
assert.equal(EN.nameDivergence(ROWS[1]), null);
assert.equal(EN.nameDivergence(ROWS[3]), null);

// parsing a pasted block
assert.deepEqual(EN.parseNames('A\r\nB, C;\t"D"\n\na'), ['A', 'B', 'C', 'D']);

// CSV
const csv = EN.lookupsToCsv([{ input: 'x', status: 'found', matchedOn: 'AOT name', entity: ROWS[0], candidates: [], notes: ['a, b'] }]);
assert.ok(csv.includes('RMCustomerRegisterations'));
assert.ok(csv.includes('"a, b"'));

// --- content script job, end to end against a fake F&O ------------------------
const ORIGIN = 'https://contoso-uat.sandbox.operations.eu.dynamics.com';
const PASCAL = ROWS.map((r) => ({
  Name: r.name, PublicEntityName: r.publicEntityName, PublicCollectionName: r.publicCollectionName,
  LabelId: r.labelId, EntityCategory: r.entityCategory, DataServiceEnabled: r.dataServiceEnabled,
  DataManagementEnabled: r.dataManagementEnabled, IsReadOnly: r.isReadOnly
}));
const calls = [];
const json = (body, status = 200) => ({
  ok: status < 400, status, headers: { get: () => null },
  text: async () => JSON.stringify(body)
});

async function fakeFetch(url, opts) {
  assert.equal(opts.method, 'GET');
  const u = new URL(url);
  calls.push(u.pathname + decodeURIComponent(u.search));
  if (u.pathname === '/metadata/DataEntities') {
    const filter = u.searchParams.get('$filter');
    if (filter) {
      // behave like the server: case-sensitive exact
      const names = [...filter.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      return json({ value: PASCAL.filter((r) => names.includes(r.Name) || names.includes(r.PublicEntityName) || names.includes(r.PublicCollectionName)) });
    }
    return json({ value: PASCAL });
  }
  if (u.pathname.startsWith('/metadata/Labels')) return json({ Value: 'Tax registration on customer' });
  if (u.pathname === '/data/RMCustomerRegisterations') return json({ value: [{ '@odata.etag': 'x', AccountNum: '2024-0329', TaxRegstrationType: 'CR', dataAreaId: 'srmt' }] });
  if (u.pathname.startsWith('/data/')) return json({ error: 'nf' }, 404);
  throw new Error('unexpected ' + url);
}

let listener = null;
const store = {};
const ctx = {
  location: new URL(ORIGIN + '/?cmp=SRMT'),
  fetch: fakeFetch,
  console, setTimeout, clearTimeout, URL, encodeURIComponent,
  chrome: {
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, sendMessage: () => Promise.resolve() },
    storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) } }
  }
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../lib/entitynames.js', import.meta.url), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8'), ctx);
assert.ok(listener, 'content script registered its listener');

const run = (args) => new Promise((resolve) => listener({ type: 'dwem:job', job: 'fnoEntityNames', jobId: 't', args }, null, resolve));

const out = await run({ names: ['RMTaxRegistrationOnCustomerEntity', 'rmcustomerregisterations', 'RMCustomerRegistrations', 'HiddenStagingEntity', 'NothingLikeThisAtAll'], verify: true });
assert.ok(out.ok, out.error);
const [a, b, c, d, e] = out.result.results;

assert.equal(a.status, 'found');
assert.equal(a.entity.publicCollectionName, 'RMCustomerRegisterations');
assert.equal(a.entity.label, 'Tax registration on customer');
assert.ok(a.verify.ok && a.verify.hasRows, 'live /data check passed');
assert.equal(a.verify.fieldCount, 3, 'field count ignores @odata annotations');
assert.ok(a.notes.some((n) => /does not start from the AOT name/.test(n)));

assert.equal(b.status, 'found', 'case-insensitive via the full list when $filter misses');
assert.equal(b.matchedOn, 'public collection name');

assert.equal(c.status, 'fuzzy', 'misspelling-tolerant');
assert.equal(c.entity.name, 'RMTaxRegistrationOnCustomerEntity');

assert.equal(d.status, 'found');
assert.equal(d.verify.ok, false);
assert.ok(d.notes.some((n) => /not a public entity/i.test(n)));

assert.equal(e.status, 'notFound');

assert.ok(calls.includes('/data/RMCustomerRegisterations?$top=1&cross-company=true'), 'verify is one row, cross-company');
assert.ok(!calls.some((x) => x.startsWith('/data/') && !x.endsWith('?$top=1&cross-company=true')), 'no other /data calls');

console.log('All entity-name assertions passed.');
