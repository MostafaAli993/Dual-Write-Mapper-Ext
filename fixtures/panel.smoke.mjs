/* Loads panel.html + panel.js in jsdom with a stubbed chrome API and fake
 * environment responses, then drives the Fields feature end to end.
 * Catches wiring errors that unit tests cannot see. */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const html = fs.readFileSync(path.join(root, 'panel/panel.html'), 'utf8');

// --- fake environment responses ---------------------------------------------
const ENTITY = {
  name: 'RMCreditLimitAdjTable',
  entitySetName: 'RMCreditLimitAdjTables',
  isReadOnly: false,
  properties: [
    { name:'JournalId',   dataType:'String',  isKey:true,  isMandatory:true,  allowEdit:false, allowEditOnCreate:true },
    { name:'Description', dataType:'String',  isKey:false, isMandatory:false, allowEdit:true,  allowEditOnCreate:true },
    { name:'Status',      dataType:'Enum',    enumName:'CredManCreditLimitAdjJournalStatus', isKey:false, isMandatory:false, allowEdit:true, allowEditOnCreate:true },
    { name:'Posted',      dataType:'Enum',    enumName:'NoYes', isKey:false, isMandatory:false, allowEdit:true, allowEditOnCreate:true },
    { name:'PostedDate',  dataType:'UtcDateTime', isKey:false, isMandatory:false, allowEdit:true, allowEditOnCreate:true },
    { name:'Amount',      dataType:'Real',    isKey:false, isMandatory:false, allowEdit:true,  allowEditOnCreate:true },
    { name:'Payload',     dataType:'Container', isKey:false, isMandatory:false, allowEdit:true, allowEditOnCreate:true }
  ]
};

const DV_ATTRS = [
  { LogicalName:'arq_creditlimitadjustmentnumber', AttributeType:'String', MaxLength:100, IsCustomAttribute:true },
  { LogicalName:'arq_description', AttributeType:'String', MaxLength:200, IsCustomAttribute:true },
  { LogicalName:'arq_amount',      AttributeType:'Double', IsCustomAttribute:true },
  { LogicalName:'arq_posted',      AttributeType:'Boolean', IsCustomAttribute:true },
  { LogicalName:'arq_legacy',      AttributeType:'String', MaxLength:50, IsCustomAttribute:true },
  { LogicalName:'createdon',       AttributeType:'DateTime', IsCustomAttribute:false }
];

const jobResponses = {
  fnoEntityList: () => ({ ok:true, result:{ names:['RMCreditLimitAdjTable','SalesOrderHeaderV2'], total:2 } }),
  fnoFields: (args) => (args && /^NotPublicEntity$/i.test(args.entityName) ? ({ ok:true, result:{
    error: '"NotPublicEntity" exists in this environment as a data entity, but it is not exposed as a public entity, so the Metadata REST API publishes no field list for it.',
    hint: 'Field and key metadata for a non-public entity can only be seen in F&O itself: Data management > the entity > Entity structure / Target fields, or the AOT.',
    tried: ['NotPublicEntity', 'NotPublic'],
    dataEntityRow: { name:'NotPublicEntity', publicEntityName:null, publicCollectionName:null,
      entityCategory:'Transaction', dataServiceEnabled:false, dataManagementEnabled:true, isReadOnly:false },
    suggestions: [], searchedFor: 'NotPublicEntity', totalEntities: 2
  }}) : { ok:true, result:{
    entity: JSON.parse(JSON.stringify(ENTITY)),
    edm: { JournalId:{maxLength:20}, Description:{maxLength:60}, Amount:{precision:32,scale:6} },
    edmStatus: { attempted:true, available:true, message:'$metadata supplied length for 2 field(s) and precision for 1 field(s) on this entity.' },
    dataEntity: { name:'RM_CredManCreditLimitAdjTableEntity', entityCategory:'Master', dataServiceEnabled:true, dataManagementEnabled:true },
    resolvedAs: 'RMCreditLimitAdjTable'
  }}),
  fnoEntityNames: (args) => ({ ok:true, result:{ totalEntities: 4321, results: args.names.map((n) =>
    /nothing/i.test(n)
      ? { input:n, status:'notFound', matchedOn:null, entity:null, notes:[], candidates:[
          { score:0.61, matchedOn:'AOT name', row:{ name:'TaxRegistrationEntity', publicEntityName:'TaxRegistration', publicCollectionName:'TaxRegistrations', label:'Tax registration' } } ] }
      : { input:n, status:'found', matchedOn:'AOT name', candidates:[],
          notes:['The Power Automate name does not start from the AOT name - searching the connector dropdown for the Data management name will not find it.'],
          entity:{ name:'RMTaxRegistrationOnCustomerEntity', publicEntityName:'RMCustomerRegisteration', publicCollectionName:'RMCustomerRegisterations',
            label:'Tax registration on customer', entityCategory:'Master', dataServiceEnabled:true, dataManagementEnabled:true, isReadOnly:false },
          verify: args.verify ? { ok:true, hasRows:true, fieldCount:10, summary:'OK - /data/RMCustomerRegisterations returns rows (10 fields)' } : undefined }) } }),
  dvAttributes: () => ({ ok:true, result:{ table:'arq_creditlimitadjustmentheaders', attributes: DV_ATTRS } }),
  fnoEnum: () => ({ ok:true, result:{ enums:[{
    name:'CredManCreditLimitAdjJournalStatus', label:'Approval status',
    members:[
      { name:'Draft',    value:0, labelId:'@SYS1', label:'Not submitted' },
      { name:'Denied',   value:3, labelId:'@SYS2', label:'Rejected' },
      { name:'Approved', value:4, labelId:'@SYS3', label:'Approved' }
    ]}]}}),
  dvTable: () => ({ ok:true, result:{ columns:[{
    logicalName:'arq_approvalstatus', displayName:'Approval Status', isGlobal:false,
    options:[
      { value:750880000, label:'Not Submitted' },
      { value:750880003, label:'Rejected' },
      { value:750880004, label:'Approved' }
    ]}]}})
};

// --- jsdom + chrome stub -----------------------------------------------------
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/panel.html', pretendToBeVisual: true });
const { window } = dom;
const downloads = [];

window.chrome = {
  runtime: { onMessage: { addListener(){} }, getURL: (p) => p, sendMessage: async () => {} },
  tabs: {
    query: async () => ([
      { id: 1, url: 'https://contoso-uat.sandbox.operations.eu.dynamics.com/' },
      { id: 2, url: 'https://contoso.crm4.dynamics.com/' }
    ]),
    sendMessage: async (_id, msg) => {
      const h = jobResponses[msg.job];
      if (!h) throw new Error('unexpected job ' + msg.job);
      return h(msg.args);
    }
  },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } }
};
window.URL.createObjectURL = () => 'blob:fake';
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () {
  if (this.download) downloads.push(this.download);
};
window.navigator.clipboard = { writeText: async () => {} };
window.scrollTo = () => {};

const errors = [];
window.addEventListener('error', (e) => errors.push(e.error || e.message));
window.onerror = (m) => errors.push(m);

// load the module graph the way the browser would
let code = fs.readFileSync(path.join(root, 'panel/panel.js'), 'utf8');
const core = fs.readFileSync(path.join(root, 'lib/core.js'), 'utf8');
const fields = fs.readFileSync(path.join(root, 'lib/fields.js'), 'utf8');
const names = fs.readFileSync(path.join(root, 'lib/entitynames.js'), 'utf8');
const bundle = [
  names,
  core.replace(/^export /gm, ''),
  fields.replace(/^export /gm, '').replace(/^import .*$/gm, ''),
  code.replace(/^import[\s\S]*?from '\.\.\/lib\/core\.js';/m, '')
      .replace(/^import[\s\S]*?from '\.\.\/lib\/fields\.js';/m, '')
].join('\n');

const fn = new window.Function(bundle);
fn.call(window);

const $ = (id) => window.document.getElementById(id);
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));

await wait(150);
assert.ok($('fnoTab').options.length > 1, 'F&O tab auto-detected from chrome.tabs.query');
assert.ok($('dvTab').options.length > 1, 'Dataverse tab auto-detected');

// --- drive it ----------------------------------------------------------------
assert.ok($('tab-fields').classList.contains('hidden'), 'fields tab starts hidden');
window.document.querySelector('.tab[data-tab="fields"]').click();
assert.ok(!$('tab-fields').classList.contains('hidden'), 'clicking the tab reveals it');

$('fldEntity').value = 'RM_CredManCreditLimitAdjTableEntity';
$('runFields').click();
await wait(120);

if (process.env.DEBUG) {
  console.log('STATUS:', $('fldStatus').textContent);
  console.log('RESULT:', $('fldResult').textContent.slice(0,400));
  console.log('ERRORS:', errors);
}
const out = $('fldResult').textContent;
assert.ok(out.includes('RMCreditLimitAdjTable'), 'entity header rendered');
assert.ok(out.includes('7 fields') || out.includes('7'), 'counts rendered');
assert.ok(out.includes('Decimal Number'), 'Real mapped to Decimal Number, not Floating Point');
assert.ok(out.includes('Time Zone Independent'), 'DateTime behavior surfaced');
assert.ok(out.includes('NOT MAPPABLE'), 'container flagged');
assert.ok(out.includes('DIPV1030'), 'NoYes warning surfaced');
assert.ok(out.includes('$metadata supplied length'), 'edm status banner shown');
assert.ok(out.includes('len 20'), 'edm length applied to the key field');

// enum expander jumps to the enums tab
const expander = $('fldResult').querySelector('button[data-enum]');
assert.ok(expander, 'enum rows expose a "view elements" button');
assert.equal(expander.dataset.enum, 'CredManCreditLimitAdjJournalStatus');

// comparison
$('fldDvTable').value = 'arq_creditlimitadjustmentheaders';
$('runFldCompare').click();
await wait(150);

const cmpOut = $('fldCmpResult').textContent;
assert.ok(cmpOut.includes('to create in CE'), 'comparison rendered');
assert.ok(cmpOut.includes('arq_status'), 'missing Status column suggested with prefix');
assert.ok(cmpOut.includes('arq_postedate') || cmpOut.includes('arq_posteddate'), 'missing PostedDate suggested');
assert.ok(cmpOut.includes('type does not match'), 'Real vs Double flagged as a type mismatch');
assert.ok(cmpOut.includes('arq_legacy'), 'CE-only column listed');
assert.ok(cmpOut.includes('CE 200 vs F&O 60') || cmpOut.includes('length'), 'size mismatch detected on Description');

// exports
$('dlFieldsCsv').click();
$('dlFldCmpCsv').click();
$('dlChecklist').click();
await wait(40);
assert.equal(downloads.length, 3, 'all three field exports fire');
assert.ok(downloads.some((d) => d.startsWith('ce-columns-to-create-')), 'checklist filename');

// the enum feature must still work
window.document.querySelector('.tab[data-tab="enums"]').click();
assert.ok(!$('tab-enums').classList.contains('hidden'));
assert.ok($('runFno') && $('runCmp') && $('dlEnumCsv'), 'enum controls intact');

// --- regression: the enum feature must still work end to end -----------------
$('fnoMode').value = 'enum';
$('fnoInput').value = 'CredManCreditLimitAdjJournalStatus';
$('runFno').click();
await wait(120);
assert.ok($('fnoResult').textContent.includes('NAME'), 'enum divergence flag still rendered');

$('dvMode').value = 'table';
$('dvTable').value = 'arq_creditlimitadjustmentheaders';
$('dvColumn').value = 'arq_approvalstatus';
$('runDv').click();
await wait(120);
assert.ok($('dvResult').textContent.includes('arq_approvalstatus'), 'dataverse choices still rendered');

$('runCmp').click();
await wait(80);
const vm = $('vmJson').textContent;
assert.ok(vm.includes('"draft": "750880000"'), 'ValueMap still lowercases and quotes: ' + vm);
assert.ok(vm.includes('"denied": "750880003"'));
assert.ok($('cmpResult').textContent.includes('name'), 'divergence callout still present');


// --- a data entity that exists but is not public -----------------------------
window.document.querySelector('.tab[data-tab="fields"]').click();
$('fldEntity').value = 'NotPublicEntity';
$('runFields').click();
await wait(120);
const why = $('fldResult').textContent;
assert.ok(why.includes('What happened'), 'the why-callout is rendered instead of a bare status line');
assert.ok(why.includes('not exposed as a public entity'), 'the real reason is shown');
assert.ok(why.includes('Entity structure'), 'the hint points at where the fields can be seen');
assert.ok(why.includes('none'), 'the empty public entity name is spelled out');
assert.ok(why.includes('NotPublic'), 'the names that were tried are listed');
window.document.querySelector('.tab[data-tab="enums"]').click();

// --- entity names tab ------------------------------------------------------------
window.document.querySelector('.tab[data-tab="names"]').click();
assert.ok(!$('tab-names').classList.contains('hidden'), 'names tab reveals');
assert.ok($('tab-fields').classList.contains('hidden') && $('tab-enums').classList.contains('hidden'), 'other tabs hide');
$('nmInput').value = 'RMTaxRegistrationOnCustomerEntity\nNothingLikeThis';
$('runNames').click();
await wait(120);
const nm = $('nmResult').textContent;
assert.ok(nm.includes('RMCustomerRegisterations'), 'Power Automate name shown');
assert.ok(nm.includes('RMCustomerRegisteration'), 'public entity name shown');
assert.ok(nm.includes('Tax registration on customer'), 'label shown');
assert.ok(nm.includes('returns rows'), 'live check shown');
assert.ok(nm.includes('does not start from the AOT name'), 'divergence note shown');
assert.ok(nm.includes('Closest names') && nm.includes('TaxRegistrations'), 'candidates shown for a miss');
assert.ok($('nmStatus').textContent.includes('1 found') && $('nmStatus').textContent.includes('1 not found'), 'status counts: ' + $('nmStatus').textContent);
$('dlNamesCsv').click();
await wait(20);
assert.ok(downloads.some((d) => d.startsWith('fno-entity-names-')), 'names CSV fires');
// "Open in Entity fields" hands the public entity name to the fields tab
$('nmResult').querySelector('button[data-fields]').click();
await wait(120);
assert.ok(!$('tab-fields').classList.contains('hidden'), 'jumped to fields tab');
assert.equal($('fldEntity').value, 'RMCustomerRegisteration');
// "Use" on a candidate re-runs the lookup with that name
window.document.querySelector('.tab[data-tab="names"]').click();
$('nmInput').value = 'NothingLikeThis';
$('runNames').click();
await wait(120);
$('nmResult').querySelector('button[data-lookup]').click();
assert.equal($('nmInput').value, 'TaxRegistrationEntity');
await wait(120);

assert.equal(errors.length, 0, 'no uncaught errors: ' + errors.join(' | '));
console.log('Panel smoke test passed. Downloads fired:', downloads.join(', '));
