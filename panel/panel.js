import {
  matchEnum, valueMapJson, enumsToCsv, comparisonToCsv, normalizeLabel
} from '../lib/core.js';
import {
  DV, recommendEntity, compareFields, simplifyDvAttribute,
  suggestLogicalName, suggestDisplayName,
  fieldsToCsv, checklistToCsv, fieldComparisonToCsv
} from '../lib/fields.js';

const $ = (id) => document.getElementById(id);

const state = {
  tabs: [],
  fnoEnums: [],      // [{name, label, members:[{name,value,label,labelId}]}]
  entityProps: [],
  suggestions: [],
  searchedFor: null,
  dvColumns: [],     // [{logicalName, displayName, options:[{value,label}], tableLogicalName}]
  lastComparison: null,

  // --- Fields feature ---
  entity: null,          // {name, label, properties:[...]}
  recs: [],              // recommendColumn() output, one per property
  edmStatus: null,
  dataEntity: null,
  dvAttrs: [],           // simplifyDvAttribute() output
  dvAttrTable: null,
  fieldComparison: null
};

// -----------------------------------------------------------------------------
// Tab discovery
// -----------------------------------------------------------------------------

async function refreshTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://*.dynamics.com/*' });
  state.tabs = tabs;

  const fill = (sel, kind) => {
    const prev = sel.value;
    sel.innerHTML = '<option value="">-- none detected --</option>';
    for (const t of tabs) {
      const host = new URL(t.url).hostname;
      const isFno = host.includes('.operations.');
      if ((kind === 'fno') !== isFno) continue;
      const o = document.createElement('option');
      o.value = String(t.id);
      o.textContent = host;
      sel.appendChild(o);
    }
    // Restore the previous pick only if there WAS one; the placeholder also has
    // an empty value, so testing it against an empty `prev` would always match
    // and the auto-pick below would never fire.
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
    else if (sel.options.length === 2) sel.selectedIndex = 1; // auto-pick the only one
  };

  fill($('fnoTab'), 'fno');
  fill($('dvTab'), 'dv');
}

// -----------------------------------------------------------------------------
// Job dispatch to the content script
// -----------------------------------------------------------------------------

let jobSeq = 0;
const progressSinks = new Map();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'dwem:progress') {
    const sink = progressSinks.get(msg.jobId);
    if (sink) sink(msg.message);
  }
});

async function runJob(tabId, job, args, onProgress) {
  if (!tabId) throw new Error('Pick an environment tab first. If the dropdown is empty, open the environment in a tab, sign in, then hit "Refresh tabs".');
  const jobId = `j${++jobSeq}`;
  if (onProgress) progressSinks.set(jobId, onProgress);
  try {
    const res = await chrome.tabs.sendMessage(Number(tabId), { type: 'dwem:job', job, jobId, args });
    if (!res) throw new Error('No response from the environment tab. Reload that tab so the extension can attach, then try again.');
    if (!res.ok) throw new Error(res.error);
    return res.result;
  } catch (e) {
    if (String(e.message || e).includes('Receiving end does not exist')) {
      throw new Error('The extension is not attached to that tab yet. Reload the environment tab and try again.');
    }
    throw e;
  } finally {
    progressSinks.delete(jobId);
  }
}

function setStatus(el, text, isError = false) {
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}

async function guard(button, statusEl, fn) {
  button.disabled = true;
  setStatus(statusEl, 'Working...');
  try {
    await fn();
  } catch (e) {
    setStatus(statusEl, e.message || String(e), true);
  } finally {
    button.disabled = false;
  }
}

// -----------------------------------------------------------------------------
// Section 2 - F&O
// -----------------------------------------------------------------------------

function syncFnoMode() {
  const mode = $('fnoMode').value;
  $('fnoInputWrap').classList.toggle('hidden', mode === 'all');
  $('fnoLimitWrap').classList.toggle('hidden', mode !== 'all');
  const cfg = {
    enum:   ['Enum name', 'e.g. CredManCreditLimitAdjStatus'],
    search: ['Search term', 'e.g. creditlimit, status, approval'],
    entity: ['Entity name', 'e.g. RM_CredManCreditLimitAdjTableEntity'],
    all:    ['Enum name', '']
  }[mode];
  $('fnoInputWrap').firstChild.textContent = cfg[0];
  $('fnoInput').placeholder = cfg[1];
}

$('fnoMode').addEventListener('change', syncFnoMode);

$('runFno').addEventListener('click', () => guard($('runFno'), $('fnoStatus'), async () => {
  const tabId = $('fnoTab').value;
  const mode = $('fnoMode').value;
  const val = $('fnoInput').value.trim();
  const onProg = (m) => setStatus($('fnoStatus'), m);

  if (mode !== 'all' && !val) throw new Error('Enter a name first.');

  let result;
  if (mode === 'enum') result = await runJob(tabId, 'fnoEnum', { enumName: val }, onProg);
  else if (mode === 'search') result = await runJob(tabId, 'fnoSearch', { query: val }, onProg);
  else if (mode === 'entity') result = await runJob(tabId, 'fnoEntity', { entityName: val }, onProg);
  else {
    const lim = parseInt($('fnoLimit').value, 10);
    result = await runJob(tabId, 'fnoDumpAll', { limit: Number.isFinite(lim) ? lim : null }, onProg);
  }

  state.fnoEnums = result.enums || [];
  state.entityProps = result.entityProps || [];
  state.suggestions = result.suggestions || [];
  state.searchedFor = result.searchedFor || null;

  const failed = state.fnoEnums.filter((e) => e.error);
  const ok = state.fnoEnums.filter((e) => !e.error);

  if (state.suggestions.length && !ok.length) {
    setStatus($('fnoStatus'),
      `"${result.searchedFor}" is not an AOT enum type name. ` +
      `${state.suggestions.length} enum name(s) out of ${result.totalEnums} look related - pick one below.`);
  } else if (!ok.length && state.searchedFor && mode !== 'all') {
    setStatus($('fnoStatus'),
      `Nothing matched "${result.searchedFor}" among ${result.totalEnums || '?'} enums in this environment.`, true);
  } else {
    setStatus($('fnoStatus'),
      `${ok.length} enum(s) read` +
      (result.resolvedAs ? ` (resolved "${val}" to "${result.resolvedAs}")` : '') +
      (result.total ? ` of ${result.total} in the environment` : '') +
      (failed.length ? `, ${failed.length} failed` : '') +
      (result.note ? ` - ${result.note}` : ''));
  }

  renderFno();
  refreshCompareOptions();
}));

function renderFno() {
  const host = $('fnoResult');
  host.innerHTML = '';

  if (state.suggestions && state.suggestions.length) {
    const box = document.createElement('div');
    box.className = 'callout';
    box.innerHTML =
      `<h3>Enum names matching &ldquo;${esc(state.searchedFor)}&rdquo;</h3>` +
      `<p class="hint">The F&amp;O form shows the <em>field</em> name; ValueMap needs the <em>enum type</em> name. Click one to load it.</p>` +
      `<div class="chips">${state.suggestions.map((n) => `<button class="chip" data-enum="${esc(n)}">${esc(n)}</button>`).join('')}</div>`;
    host.appendChild(box);
    box.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
      $('fnoMode').value = 'enum';
      syncFnoMode();
      $('fnoInput').value = b.dataset.enum;
      $('runFno').click();
    }));
  }

  if (!state.fnoEnums.length) return;

  if (state.entityProps.length) {
    const d = document.createElement('details');
    d.open = true;
    d.innerHTML = `<summary>${state.entityProps.length} enum-typed propert${state.entityProps.length === 1 ? 'y' : 'ies'} on this entity</summary>` +
      table(['Property', 'Enum type', 'Mandatory'],
        state.entityProps.map((p) => [p.property, p.enumName, p.isMandatory ? 'yes' : 'no']));
    host.appendChild(d);
  }

  const shown = state.fnoEnums.slice(0, 40);
  for (const e of shown) {
    const d = document.createElement('details');
    if (e.error) {
      d.innerHTML = `<summary>${esc(e.name)} &mdash; <span style="color:#b42318">failed</span></summary><p class="hint">${esc(e.error)}</p>`;
      host.appendChild(d);
      continue;
    }
    const divergent = e.members.filter((m) => m.label && normalizeLabel(m.name) !== normalizeLabel(m.label));
    d.open = shown.length <= 3;
    d.innerHTML =
      `<summary>${esc(e.name)}${e.label ? ` <span class="hint">(${esc(e.label)})</span>` : ''} &mdash; ${e.members.length} element(s)` +
      (divergent.length ? ` <span class="flag">${divergent.length} name/label mismatch</span>` : '') +
      `</summary>` +
      table(['Element Name', 'Label', 'Value', ''],
        e.members.map((m) => {
          const div = m.label && normalizeLabel(m.name) !== normalizeLabel(m.label);
          return [m.name, m.label ?? '(unresolved)', m.value, div ? '<span class="flag">NAME &ne; LABEL</span>' : ''];
        }),
        e.members.map((m) => (m.label && normalizeLabel(m.name) !== normalizeLabel(m.label)) ? 'diverges' : '')
      );
    host.appendChild(d);
  }

  if (state.fnoEnums.length > shown.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = `Showing the first ${shown.length} of ${state.fnoEnums.length}. Download the CSV for the full set.`;
    host.appendChild(p);
  }
}

// -----------------------------------------------------------------------------
// Section 3 - Dataverse
// -----------------------------------------------------------------------------

$('dvMode').addEventListener('change', () => {
  const isTable = $('dvMode').value === 'table';
  $('dvTableWrap').classList.toggle('hidden', !isTable);
  $('dvColWrap').classList.toggle('hidden', !isTable);
});

$('runDv').addEventListener('click', () => guard($('runDv'), $('dvStatus'), async () => {
  const tabId = $('dvTab').value;
  const onProg = (m) => setStatus($('dvStatus'), m);
  let result;

  if ($('dvMode').value === 'table') {
    const table = $('dvTable').value.trim();
    const column = $('dvColumn').value.trim();
    if (!table) throw new Error('Enter a table logical name.');
    result = await runJob(tabId, 'dvTable', { table, column: column || null }, onProg);
    result.columns.forEach((c) => { c.tableLogicalName = table; });
  } else {
    result = await runJob(tabId, 'dvGlobal', {}, onProg);
  }

  state.dvColumns = result.columns || [];
  setStatus($('dvStatus'), `${state.dvColumns.length} choice column(s) / option set(s) read.`);
  renderDv();
  refreshCompareOptions();
}));

function renderDv() {
  const host = $('dvResult');
  host.innerHTML = '';
  const shown = state.dvColumns.slice(0, 25);
  for (const c of shown) {
    const d = document.createElement('details');
    d.open = shown.length <= 3;
    d.innerHTML =
      `<summary>${esc(c.logicalName)}${c.displayName ? ` <span class="hint">(${esc(c.displayName)})</span>` : ''} &mdash; ${c.options.length} option(s)${c.isGlobal ? ' &middot; global' : ''}</summary>` +
      table(['Value', 'Label'], c.options.map((o) => [o.value, o.label ?? '(no label)']));
    host.appendChild(d);
  }
  if (state.dvColumns.length > shown.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = `Showing the first ${shown.length} of ${state.dvColumns.length}.`;
    host.appendChild(p);
  }
}

// -----------------------------------------------------------------------------
// Section 4 - compare
// -----------------------------------------------------------------------------

function refreshCompareOptions() {
  const f = $('cmpFno');
  f.innerHTML = '';
  for (const e of state.fnoEnums.filter((x) => !x.error)) {
    const o = document.createElement('option');
    o.value = e.name; o.textContent = `${e.name} (${e.members.length})`;
    f.appendChild(o);
  }
  const d = $('cmpDv');
  d.innerHTML = '';
  state.dvColumns.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${c.tableLogicalName ? c.tableLogicalName + '.' : ''}${c.logicalName} (${c.options.length})`;
    d.appendChild(o);
  });
}

$('runCmp').addEventListener('click', () => {
  const host = $('cmpResult');
  host.innerHTML = '';
  const fno = state.fnoEnums.find((e) => e.name === $('cmpFno').value);
  const dv = state.dvColumns[Number($('cmpDv').value)];
  if (!fno || !dv) {
    host.innerHTML = '<div class="status error">Pull an F&amp;O enum and a Dataverse choice column first.</div>';
    return;
  }

  state.lastCmpInputs = { fno, dv };
  const cmp = matchEnum(fno, dv, matchOpts());
  state.lastComparison = cmp;
  renderComparison(cmp, host);
});

function renderComparison(cmp, host) {
  const casing = $('casing').value;
  const direction = $('direction').value;

  host.innerHTML = `
    <div class="counts">
      <div><b>${cmp.matched.length}</b> matched</div>
      <div><b>${cmp.divergent.length}</b> name &ne; label</div>
      <div><b>${cmp.nameMatched.length}</b> matched by element name</div>
      <div><b>${cmp.fuzzyMatched.length}</b> near matches</div>
      <div><b>${cmp.fnoOnly.length}</b> F&amp;O only</div>
      <div><b>${cmp.dvOnly.length}</b> Dataverse only</div>
    </div>`;

  if (cmp.fuzzyMatched.length) {
    const c = document.createElement('div');
    c.className = 'callout bad';
    c.innerHTML =
      `<h3>${cmp.fuzzyMatched.length} near match(es) - review before you ship</h3>` +
      `<p class="hint">Neither the label nor the element name lined up exactly, so the words the enum and column names repeat (${cmp.noiseWords.map(esc).join(', ') || 'none'}) were dropped from both sides before comparing. Each of these was the only Dataverse option left that fit. They are in the ValueMap below - delete any pair you disagree with.</p>` +
      table(['AOT element name', 'F&O value', 'Dataverse value', 'Dataverse label', 'Why'],
        cmp.fuzzyMatched.map((m) => [`<code>${esc(m.fnoName)}</code>`, m.fnoValue, m.dvValue, m.dvLabel ?? '', esc(m.matchNote)]));
    host.appendChild(c);
  }

  if (cmp.nameMatched.length) {
    const c = document.createElement('div');
    c.className = 'callout';
    c.innerHTML =
      `<h3>${cmp.nameMatched.length} element(s) matched on the AOT element name</h3>` +
      `<p class="hint">F&amp;O returned no usable label for these, so the element name was compared to the Dataverse option label instead (case, spaces, hyphens and punctuation ignored). This is exactly what the ValueMap needs - the key is the element name either way - but eyeball the pairs below before you ship them.</p>` +
      table(['AOT element name', 'F&O value', 'Dataverse value', 'Dataverse label'],
        cmp.nameMatched.map((m) => [`<code>${esc(m.fnoName)}</code>`, m.fnoValue, m.dvValue, m.dvLabel ?? '']));
    host.appendChild(c);
  }

  if (cmp.divergent.length) {
    const c = document.createElement('div');
    c.className = 'callout';
    c.innerHTML =
      `<h3>${cmp.divergent.length} element(s) where the AOT name differs from the label</h3>` +
      `<p class="hint">These are the ValueMap breakers. The F&amp;O UI shows the label; the ValueMap must use the name.</p>` +
      table(['UI label (what you see)', 'AOT element name (what ValueMap needs)', 'F&O value', 'Dataverse value'],
        cmp.divergent.map((m) => [m.fnoLabel, `<code>${esc(m.fnoName)}</code>`, m.fnoValue, m.dvValue]));
    host.appendChild(c);
  }

  if (cmp.ambiguousLabels.length) {
    const c = document.createElement('div');
    c.className = 'callout bad';
    c.innerHTML = `<h3>Ambiguous Dataverse labels</h3><p class="hint">More than one Dataverse option normalises to the same label text, so the match picked the first. Check these by hand: ${cmp.ambiguousLabels.map(esc).join(', ')}</p>`;
    host.appendChild(c);
  }

  host.appendChild(section('Matched pairs',
    table(['F&O element name', 'F&O label', 'F&O value', 'Dataverse value', 'Dataverse label', 'Matched on', ''],
      cmp.matched.map((m) => [
        `<code>${esc(m.fnoName)}</code>`, m.fnoLabel ?? '', m.fnoValue, m.dvValue, m.dvLabel ?? '',
        m.matchedBy === 'fuzzy' ? '<span class="pill warn">NEAR MATCH</span>'
          : m.matchedBy === 'name' ? '<span class="pill">ELEMENT NAME</span>' : 'label',
        m.nameDiverges ? '<span class="flag">NAME &ne; LABEL</span>' : ''
      ]),
      cmp.matched.map((m) => m.nameDiverges ? 'diverges' : ''))));

  if (cmp.fnoOnly.length) {
    host.appendChild(section('F&O elements with no Dataverse equivalent',
      table(['Element name', 'Label', 'Value', 'Reason'],
        cmp.fnoOnly.map((f) => [`<code>${esc(f.fnoName)}</code>`, f.fnoLabel ?? '', f.fnoValue, f.reason]))));
  }
  if (cmp.dvOnly.length) {
    host.appendChild(section('Dataverse options with no F&O equivalent',
      table(['Value', 'Label', 'Reason'],
        cmp.dvOnly.map((d) => [d.dvValue, d.dvLabel ?? '', d.reason]))));
  }

  const json = valueMapJson(cmp.matched, casing, direction);
  const wrap = document.createElement('div');
  wrap.innerHTML = `<h3>ValueMap JSON</h3><pre id="vmJson">${esc(json)}</pre>
    <div class="copybar"><button id="copyVm" class="secondary">Copy to clipboard</button>
    <span class="hint">${casing === 'lower' ? 'F&amp;O keys lowercased' : 'exact AOT casing'} &middot; ${direction === 'fnoToDv' ? 'F&amp;O &rarr; Dataverse' : 'Dataverse &rarr; F&amp;O'}</span></div>`;
  host.appendChild(wrap);
  $('copyVm').addEventListener('click', async () => {
    await navigator.clipboard.writeText(json);
    $('copyVm').textContent = 'Copied';
    setTimeout(() => { $('copyVm').textContent = 'Copy to clipboard'; }, 1500);
  });
}

$('casing').addEventListener('change', reRender);
$('direction').addEventListener('change', reRender);
function matchOpts() {
  return { nameFallback: $('nameFallback').checked, fuzzy: $('fuzzy').checked };
}
for (const id of ['nameFallback', 'fuzzy']) {
  $(id).addEventListener('change', () => {
    const inputs = state.lastCmpInputs;
    if (!inputs) return;
    state.lastComparison = matchEnum(inputs.fno, inputs.dv, matchOpts());
    reRender();
  });
}
function reRender() {
  if (state.lastComparison) renderComparison(state.lastComparison, $('cmpResult'));
}

// -----------------------------------------------------------------------------
// Section 5 - exports
// -----------------------------------------------------------------------------

function download(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

$('dlEnumCsv').addEventListener('click', () => {
  if (!state.fnoEnums.length) return setStatus($('exportStatus'), 'Nothing pulled from F&O yet.', true);
  download(`fno-enums-${stamp()}.csv`, enumsToCsv(state.fnoEnums), 'text/csv');
  setStatus($('exportStatus'), 'Enum CSV downloaded.');
});

$('dlCmpCsv').addEventListener('click', () => {
  if (!state.lastComparison) return setStatus($('exportStatus'), 'Run a comparison first.', true);
  download(`enum-comparison-${stamp()}.csv`, comparisonToCsv(state.lastComparison), 'text/csv');
  setStatus($('exportStatus'), 'Comparison CSV downloaded.');
});

$('dlJson').addEventListener('click', () => {
  const snap = { generatedAt: new Date().toISOString(), fnoEnums: state.fnoEnums, dataverseColumns: state.dvColumns };
  download(`enum-snapshot-${stamp()}.json`, JSON.stringify(snap, null, 2), 'application/json');
  setStatus($('exportStatus'), 'JSON snapshot downloaded.');
});

$('clearCache').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('dwem:'));
  await chrome.storage.local.remove(keys);
  setStatus($('exportStatus'), `Cleared ${keys.length} cache entr(ies) (labels + enum name list).`);
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// cells may contain pre-escaped HTML (we build those ourselves); raw values are escaped.
function table(headers, rows, rowClasses = []) {
  const th = headers.map((h) => `<th>${h}</th>`).join('');
  const tr = rows.map((r, i) => {
    const cls = rowClasses[i] ? ` class="${rowClasses[i]}"` : '';
    const td = r.map((c) => `<td>${typeof c === 'string' && c.startsWith('<') ? c : esc(c)}</td>`).join('');
    return `<tr${cls}>${td}</tr>`;
  }).join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

function section(title, html) {
  const d = document.createElement('details');
  d.open = true;
  d.innerHTML = `<summary>${esc(title)}</summary>${html}`;
  return d;
}

$('refreshTabs').addEventListener('click', refreshTabs);
syncFnoMode();
refreshTabs();

/* =============================================================================
 * Entity fields feature
 * ========================================================================== */

// --- tab switching -----------------------------------------------------------

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

function showTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('tab-enums').classList.toggle('hidden', name !== 'enums');
  $('tab-fields').classList.toggle('hidden', name !== 'fields');
  $('tab-names').classList.toggle('hidden', name !== 'names');
  window.scrollTo({ top: 0 });
}

// --- entity list / autocomplete ---------------------------------------------

$('loadEntityList').addEventListener('click', () => guard($('loadEntityList'), $('fldStatus'), async () => {
  const r = await runJob($('fnoTab').value, 'fnoEntityList', {}, (m) => setStatus($('fldStatus'), m));
  const dl = $('entityList');
  dl.innerHTML = r.names.map((n) => `<option value="${esc(n)}"></option>`).join('');
  setStatus($('fldStatus'), `Entity list cached: ${r.total} entities. The box above now autocompletes (showing the first ${r.names.length}).`);
}));

// Narrow the datalist as you type, so all ~4000 entities stay reachable.
let entityTypeTimer = null;
$('fldEntity').addEventListener('input', () => {
  clearTimeout(entityTypeTimer);
  const q = $('fldEntity').value.trim();
  if (q.length < 3) return;
  entityTypeTimer = setTimeout(async () => {
    try {
      const r = await runJob($('fnoTab').value, 'fnoEntityList', { query: q }, null);
      $('entityList').innerHTML = r.names.map((n) => `<option value="${esc(n)}"></option>`).join('');
    } catch { /* autocomplete is a convenience, never an error the user must see */ }
  }, 350);
});

// --- $metadata capability probe ---------------------------------------------

$('probeEdm').addEventListener('click', () => guard($('probeEdm'), $('fldStatus'), async () => {
  const cap = await runJob($('fnoTab').value, 'fnoEdmCapability', {}, (m) => setStatus($('fldStatus'), m));
  const mb = Math.round(cap.documentBytes / 1024 / 1024 * 10) / 10;
  const el = document.createElement('div');
  el.className = 'banner ' + (cap.publishesLength ? 'good' : 'warn');
  el.innerHTML = cap.publishesLength
    ? `<strong>Good news.</strong> This environment publishes EDM facets. Of ${cap.sampled} sampled properties, ${cap.maxLength} carried MaxLength and ${cap.precision} carried Precision. Tick the $metadata box and lengths will be filled in where available. ($metadata is ${mb} MB.)`
    : `<strong>This environment does not publish length or precision.</strong> Of ${cap.sampled} sampled properties in $metadata, ${cap.maxLength} carried MaxLength and ${cap.precision} carried Precision. The tool will leave those columns as "not published" rather than guessing — confirm string lengths and decimal precision with your F&O developer. ($metadata is ${mb} MB.)`;
  $('fldResult').prepend(el);
  setStatus($('fldStatus'), '');
}));

// --- pull fields -------------------------------------------------------------

$('runFields').addEventListener('click', () => guard($('runFields'), $('fldStatus'), async () => {
  const name = $('fldEntity').value.trim();
  if (!name) throw new Error('Enter an entity name first.');
  const onProg = (m) => setStatus($('fldStatus'), m);

  const r = await runJob($('fnoTab').value, 'fnoFields',
    { entityName: name, useEdm: $('useEdm').checked }, onProg);

  if (r.error) {
    state.entity = null; state.recs = [];
    renderFieldSuggestions(r);
    setStatus($('fldStatus'), r.error, true);
    return;
  }

  state.entity = r.entity;
  state.edmStatus = r.edmStatus;
  state.dataEntity = r.dataEntity;
  state.recs = recommendEntity(r.entity.properties, r.edm || {});
  state.fieldComparison = null;

  setStatus($('fldStatus'),
    `${r.entity.properties.length} field(s) on ${r.entity.name}` +
    (r.resolvedAs ? ` (resolved "${name}" to "${r.resolvedAs}")` : ''));

  renderFields();
  $('fldCmpResult').innerHTML = '';
}));

function renderFieldSuggestions(r) {
  const host = $('fldResult');
  host.innerHTML = '';

  // Explain WHY, and show what F&O actually says about the name, before offering
  // guesses - "not found" alone sends people hunting for a typo that isn't there.
  if (r.hint || r.dataEntityRow || (r.tried && r.tried.length > 1)) {
    const why = document.createElement('div');
    why.className = 'callout bad';
    const d = r.dataEntityRow;
    why.innerHTML =
      `<h3>What happened</h3>` +
      `<p class="hint">${esc(r.error || '')}</p>` +
      (r.hint ? `<p class="hint">${esc(r.hint)}</p>` : '') +
      (d ? table(['What F&O reports', 'Value'], [
        ['Data entity name (AOT)', `<code>${esc(d.name || '')}</code>`],
        ['Public entity name', d.publicEntityName ? `<code>${esc(d.publicEntityName)}</code>` : '<em>none — not exposed publicly</em>'],
        ['Public collection name', d.publicCollectionName ? `<code>${esc(d.publicCollectionName)}</code>` : '<em>none</em>'],
        ['Entity category', esc(d.entityCategory || '')],
        ['OData (DataServiceEnabled)', d.dataServiceEnabled ? 'Yes' : 'No'],
        ['Data management enabled', d.dataManagementEnabled ? 'Yes' : 'No'],
        ['Read-only', d.isReadOnly ? 'Yes' : 'No']
      ]) : '') +
      (r.tried && r.tried.length
        ? `<p class="hint">Names tried against <code>/metadata/PublicEntities</code>: ${r.tried.map((t) => `<code>${esc(t)}</code>`).join(', ')}</p>`
        : '');
    host.appendChild(why);
  }

  if (!r.suggestions || !r.suggestions.length) return;
  const box = document.createElement('div');
  box.className = 'callout';
  box.innerHTML =
    `<h3>Entities matching &ldquo;${esc(r.searchedFor)}&rdquo;</h3>` +
    `<p class="hint">${r.suggestions.length} of ${r.totalEntities} entities matched. Click one to load it.</p>` +
    `<div class="chips">${r.suggestions.map((n) => `<button class="chip" data-entity="${esc(n)}">${esc(n)}</button>`).join('')}</div>`;
  host.appendChild(box);
  box.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
    $('fldEntity').value = b.dataset.entity;
    $('runFields').click();
  }));
}

function renderFields() {
  const host = $('fldResult');
  host.innerHTML = '';
  if (!state.entity) return;

  const e = state.entity;
  const de = state.dataEntity;

  // entity header
  const head = document.createElement('div');
  head.className = 'banner';
  head.innerHTML =
    `<strong>${esc(e.name)}</strong>${e.label ? ` &mdash; ${esc(e.label)}` : ''}` +
    (e.entitySetName ? ` &middot; set <span class="mono">${esc(e.entitySetName)}</span>` : '') +
    (e.isReadOnly ? ` &middot; <span class="pill ro">entity is read-only</span>` : '') +
    (de ? `<br><span class="note">Data entity: <span class="mono">${esc(de.name)}</span>` +
          `${de.entityCategory ? ` &middot; category ${esc(de.entityCategory)}` : ''}` +
          ` &middot; OData ${de.dataServiceEnabled ? 'enabled' : 'disabled'}` +
          ` &middot; DMF ${de.dataManagementEnabled ? 'enabled' : 'disabled'}</span>` : '');
  host.appendChild(head);

  // $metadata status - always visible, never silent
  if (state.edmStatus) {
    const b = document.createElement('div');
    b.className = 'banner ' + (state.edmStatus.available ? 'good' : (state.edmStatus.attempted ? 'warn' : ''));
    b.innerHTML = `<strong>Length &amp; precision:</strong> ${esc(state.edmStatus.message)}`;
    host.appendChild(b);
  }

  const counts = document.createElement('div');
  counts.className = 'counts';
  counts.innerHTML =
    `<div><b>${state.recs.length}</b> fields</div>` +
    `<div><b>${state.recs.filter((r) => r.raw.isKey).length}</b> key</div>` +
    `<div><b>${state.recs.filter((r) => r.raw.isMandatory).length}</b> mandatory</div>` +
    `<div><b>${state.recs.filter((r) => r.valueMapNeeded).length}</b> need a ValueMap</div>` +
    `<div><b>${state.recs.filter((r) => r.notMappable).length}</b> not mappable</div>`;
  host.appendChild(counts);

  const tbl = document.createElement('table');
  tbl.innerHTML =
    `<thead><tr>
      <th>F&amp;O field</th><th>F&amp;O type</th><th>Len / Prec</th><th>Flags</th>
      <th>Recommended Dataverse type</th><th>Notes</th>
    </tr></thead><tbody>${state.recs.map(fieldRow).join('')}</tbody>`;
  host.appendChild(tbl);

  tbl.querySelectorAll('button[data-enum]').forEach((b) => b.addEventListener('click', () => {
    showTab('enums');
    $('fnoMode').value = 'enum';
    syncFnoMode();
    $('fnoInput').value = b.dataset.enum;
    $('runFno').click();
  }));
}

function fieldRow(r) {
  const flags = [
    r.raw.isKey ? '<span class="pill key">key</span>' : '',
    r.raw.isMandatory ? '<span class="pill req">mandatory</span>' : '',
    r.raw.allowEdit === false && r.raw.allowEditOnCreate === false ? '<span class="pill ro">read-only</span>' : '',
    r.raw.allowEdit === false && r.raw.allowEditOnCreate !== false ? '<span class="pill ro">create-only</span>' : '',
    r.raw.isDimension ? '<span class="pill">dimension</span>' : ''
  ].filter(Boolean).join(' ');

  const size = [
    r.maxLength !== null ? `len ${r.maxLength}` : '',
    r.precision !== null ? `prec ${r.precision}` : '',
    r.scale !== null ? `scale ${r.scale}` : ''
  ].filter(Boolean).join(', ') || '<span class="note">not published</span>';

  const type = r.enumName
    ? `${esc(r.fnoType)} <span class="mono">${esc(r.enumName)}</span> <button class="mini" data-enum="${esc(r.enumName)}">view elements</button>`
    : esc(r.fnoType);

  const rec = r.notMappable
    ? '<span class="flag">NOT MAPPABLE</span>'
    : esc(r.dvType) + (r.behavior ? `<br><span class="note">Behavior: ${esc(r.behavior)}</span>` : '') +
      (r.valueMapNeeded ? ' <span class="flag">ValueMap</span>' : '');

  return `<tr${r.notMappable ? ' class="mismatch"' : ''}>
    <td class="mono">${esc(r.fnoName)}${r.raw.label ? `<br><span class="note">${esc(r.raw.label)}</span>` : ''}</td>
    <td>${type}</td>
    <td>${size}</td>
    <td>${flags}</td>
    <td>${rec}</td>
    <td class="note">${(r.notes || []).map(esc).join('<br>')}</td>
  </tr>`;
}

// --- compare against a CE table ---------------------------------------------

$('runFldCompare').addEventListener('click', () => guard($('runFldCompare'), $('fldCmpStatus'), async () => {
  if (!state.recs.length) throw new Error('Pull an entity first.');
  const table = $('fldDvTable').value.trim();
  if (!table) throw new Error('Enter a Dataverse table logical name.');

  const r = await runJob($('dvTab').value, 'dvAttributes', { table },
    (m) => setStatus($('fldCmpStatus'), m));

  state.dvAttrs = (r.attributes || []).map(simplifyDvAttribute);
  state.dvAttrTable = table;

  const cmp = compareFields(state.recs, state.dvAttrs, {
    prefix: $('fldPrefix').value.trim() || 'arq_',
    includeSystem: $('inclSystem').checked
  });
  state.fieldComparison = cmp;

  setStatus($('fldCmpStatus'),
    `${state.dvAttrs.length} column(s) read from ${table}. ` +
    `${cmp.missingInCe.length} F&O field(s) have no CE equivalent.`);

  renderFieldComparison(cmp, table);
}));

function renderFieldComparison(cmp, table) {
  const host = $('fldCmpResult');
  host.innerHTML = `
    <div class="counts">
      <div><b>${cmp.missingInCe.length}</b> to create in CE</div>
      <div><b>${cmp.typeMismatch.length}</b> type mismatch</div>
      <div><b>${cmp.sizeMismatch.length}</b> size / behavior mismatch</div>
      <div><b>${cmp.matched.length}</b> OK</div>
      <div><b>${cmp.ceOnly.length}</b> CE only</div>
    </div>`;

  // 1. The columns still to create - the point of the exercise, so it goes first.
  const create = document.createElement('div');
  create.className = 'callout';
  create.innerHTML = `<h3>${cmp.missingInCe.length} column(s) to create in ${esc(table)}</h3>`;
  if (cmp.missingInCe.length) {
    create.innerHTML +=
      `<p class="hint">Suggested names use the <span class="mono">${esc($('fldPrefix').value || 'arq_')}</span> prefix. Download the checklist below to work through them.</p>` +
      `<table><thead><tr>
        <th>Suggested logical name</th><th>Display name</th><th>Type</th>
        <th>Len / Prec</th><th>Behavior</th><th>From F&amp;O field</th><th>Watch out for</th>
      </tr></thead><tbody>` +
      cmp.missingInCe.map((r) => `<tr class="missing">
        <td class="mono">${esc(suggestLogicalName(r.fnoName, $('fldPrefix').value || 'arq_'))}</td>
        <td>${esc(suggestDisplayName(r.fnoName))}</td>
        <td>${esc(r.dvType)}${r.valueMapNeeded ? ' <span class="flag">ValueMap</span>' : ''}</td>
        <td>${r.maxLength !== null ? r.maxLength : (r.precision !== null ? 'prec ' + r.precision : '<span class="note">not published</span>')}</td>
        <td>${r.behavior ? esc(r.behavior) : ''}</td>
        <td class="mono">${esc(r.fnoName)}</td>
        <td class="note">${(r.notes || []).map(esc).join('<br>')}</td>
      </tr>`).join('') + '</tbody></table>';
  } else {
    create.innerHTML += `<p class="hint">Nothing missing. Every mappable F&amp;O field has a CE column with a matching name.</p>`;
  }
  host.appendChild(create);

  if (cmp.typeMismatch.length) {
    const c = document.createElement('div');
    c.className = 'callout bad';
    c.innerHTML = `<h3>${cmp.typeMismatch.length} column(s) where the CE type does not match the recommendation</h3>` +
      `<p class="hint">These will either refuse to save on the map or fail at sync time.</p>` +
      table_(['CE column', 'Actual CE type', 'Recommended', 'F&O field', 'F&O type', 'Why'],
        cmp.typeMismatch.map((r) => [
          `<span class="mono">${esc(r.ceColumn.logicalName)}</span>`,
          `<span class="flag">${esc(r.actualType)}</span>`,
          esc(r.recommendedType),
          `<span class="mono">${esc(r.fnoName)}</span>`,
          esc(r.fnoType),
          `<span class="note">${(r.notes || []).map(esc).join('<br>')}</span>`
        ]));
    host.appendChild(c);
  }

  if (cmp.sizeMismatch.length) {
    const c = document.createElement('div');
    c.className = 'callout';
    c.innerHTML = `<h3>${cmp.sizeMismatch.length} column(s) with the right type but a different size or behavior</h3>` +
      table_(['CE column', 'Type', 'F&O field', 'Difference'],
        cmp.sizeMismatch.map((r) => [
          `<span class="mono">${esc(r.ceColumn.logicalName)}</span>`,
          esc(r.ceColumn.type),
          `<span class="mono">${esc(r.fnoName)}</span>`,
          `<span class="note">${(r.issues || []).map(esc).join('<br>')}</span>`
        ]));
    host.appendChild(c);
  }

  host.appendChild(section(`Matched (${cmp.matched.length})`,
    table_(['F&O field', 'CE column', 'Type'],
      cmp.matched.map((r) => [
        `<span class="mono">${esc(r.fnoName)}</span>`,
        `<span class="mono">${esc(r.ceColumn.logicalName)}</span>`,
        esc(r.ceColumn.type)
      ]))));

  host.appendChild(section(`CE columns with no F&O equivalent (${cmp.ceOnly.length})`,
    table_(['CE column', 'Display name', 'Type'],
      cmp.ceOnly.map((r) => [
        `<span class="mono">${esc(r.ceColumn.logicalName)}</span>`,
        esc(r.ceColumn.displayName ?? ''),
        esc(r.ceColumn.type)
      ]))));
}

// small wrapper so the fields tab can reuse the enum tab's table builder
function table_(headers, rows) {
  return table(headers, rows);
}

// --- field exports -----------------------------------------------------------

$('dlFieldsCsv').addEventListener('click', () => {
  if (!state.recs.length) return setStatus($('fldExportStatus'), 'Pull an entity first.', true);
  download(`fno-fields-${state.entity.name}-${stamp()}.csv`, fieldsToCsv(state.entity.name, state.recs), 'text/csv');
  setStatus($('fldExportStatus'), 'Field list CSV downloaded.');
});

$('dlFldCmpCsv').addEventListener('click', () => {
  if (!state.fieldComparison) return setStatus($('fldExportStatus'), 'Run a comparison first.', true);
  download(`field-comparison-${state.entity.name}-${stamp()}.csv`,
    fieldComparisonToCsv(state.entity.name, state.dvAttrTable, state.fieldComparison), 'text/csv');
  setStatus($('fldExportStatus'), 'Comparison CSV downloaded.');
});

$('dlChecklist').addEventListener('click', () => {
  if (!state.fieldComparison) return setStatus($('fldExportStatus'), 'Run a comparison first — the checklist is the list of columns that do not exist yet.', true);
  download(`ce-columns-to-create-${state.entity.name}-${stamp()}.csv`,
    checklistToCsv(state.entity.name, state.fieldComparison.missingInCe, $('fldPrefix').value.trim() || 'arq_'),
    'text/csv');
  setStatus($('fldExportStatus'), `Checklist downloaded — ${state.fieldComparison.missingInCe.length} column(s) to create.`);
});


/* =============================================================================
 * Entity names feature
 * ========================================================================== */

const EN = globalThis.DWEntityNames;
state.nameResults = [];

$('runNames').addEventListener('click', () => guard($('runNames'), $('nmStatus'), async () => {
  const names = EN.parseNames($('nmInput').value);
  if (!names.length) throw new Error('Paste at least one entity name.');
  const r = await runJob($('fnoTab').value, 'fnoEntityNames',
    { names, verify: $('nmVerify').checked, refresh: $('nmRefresh').checked },
    (m) => setStatus($('nmStatus'), m));
  $('nmRefresh').checked = false;
  state.nameResults = r.results || [];

  const found = state.nameResults.filter((x) => x.status === 'found').length;
  const fuzzy = state.nameResults.filter((x) => x.status === 'fuzzy').length;
  const miss = state.nameResults.length - found - fuzzy;
  setStatus($('nmStatus'),
    `${found} found` + (fuzzy ? `, ${fuzzy} closest match (confirm)` : '') + (miss ? `, ${miss} not found` : '') +
    (r.totalEntities ? ` - searched ${r.totalEntities} data entities` : ''));
  renderNames();
}));

function renderNames() {
  const host = $('nmResult');
  host.innerHTML = '';
  for (const r of state.nameResults) host.appendChild(nameCard(r));
}

function nameCard(r) {
  const card = document.createElement('div');
  card.className = 'namecard ' + (r.status === 'found' ? '' : r.status === 'fuzzy' ? 'fuzzy' : 'notfound');
  const e = r.entity;
  let html = `<div class="typed">You typed <span class="mono">${esc(r.input)}</span>` +
    (r.matchedOn ? ` &mdash; matched on ${esc(r.matchedOn)}` : '') + `</div>`;

  if (e) {
    html += `<div class="pa"><span class="note">Power Automate entity name</span>` +
      (e.publicCollectionName
        ? `<span class="big">${esc(e.publicCollectionName)}</span><button class="mini" data-copy="${esc(e.publicCollectionName)}">Copy</button>`
        : `<span class="chk bad">none - not a public entity</span>`) +
      (r.verify ? ` <span class="chk ${r.verify.ok ? 'ok' : 'bad'}">${esc(r.verify.summary)}</span>` : '') +
      `</div>`;
    html += `<table class="names3"><tbody>` +
      nrow('AOT name (Data management &ldquo;Target entity&rdquo;)', e.name) +
      nrow('Public entity name (OData type, Entity fields tab)', e.publicEntityName) +
      nrow('Public collection name (Power Automate, /data URL)', e.publicCollectionName) +
      `<tr><th>Label</th><td>${esc(e.label ?? '(none)')}</td></tr>` +
      `<tr><th>Flags</th><td>` +
        `<span class="pill ${e.dataServiceEnabled ? 'key' : 'ro'}">OData ${e.dataServiceEnabled ? 'on' : 'off'}</span> ` +
        `<span class="pill">${esc(e.entityCategory || 'no category')}</span> ` +
        (e.isReadOnly ? '<span class="pill ro">read-only</span> ' : '') +
        (e.publicEntityName ? `<button class="mini" data-fields="${esc(e.publicEntityName)}">Open in Entity fields</button>` : '') +
      `</td></tr></tbody></table>`;
  } else {
    html += `<p class="hint" style="margin:6px 0 0">No data entity has this as its AOT, public entity or collection name.` +
      (r.candidates.length ? ' Closest names below.' : ' Nothing close either - check the environment and spelling.') + `</p>`;
  }

  for (const n of r.notes || []) html += `<div class="note">&#9888; ${esc(n)}</div>`;

  if (r.candidates && r.candidates.length) {
    html += `<details${e ? '' : ' open'}><summary>${e ? 'Other close names' : 'Closest names'} (${r.candidates.length})</summary>` +
      table(['Score', 'Power Automate name', 'AOT name', 'Public entity name', 'Label', ''],
        r.candidates.map((c) => [
          String(c.score),
          `<span class="mono">${esc(c.row.publicCollectionName || '(not public)')}</span>`,
          `<span class="mono">${esc(c.row.name)}</span>`,
          `<span class="mono">${esc(c.row.publicEntityName || '')}</span>`,
          c.row.label ?? '',
          `<button class="mini" data-lookup="${esc(c.row.name)}">Use</button>`
        ])) + `</details>`;
  }

  card.innerHTML = html;
  card.querySelectorAll('button[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { b.textContent = 'Copy failed'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  }));
  card.querySelectorAll('button[data-fields]').forEach((b) => b.addEventListener('click', () => {
    showTab('fields');
    $('fldEntity').value = b.dataset.fields;
    $('runFields').click();
  }));
  card.querySelectorAll('button[data-lookup]').forEach((b) => b.addEventListener('click', () => {
    $('nmInput').value = b.dataset.lookup;
    $('runNames').click();
  }));
  return card;
}

function nrow(label, value) {
  return `<tr><th>${label}</th><td class="mono">${value ? esc(value) : '<span class="note">(none)</span>'}</td></tr>`;
}

$('dlNamesCsv').addEventListener('click', () => {
  if (!state.nameResults.length) return setStatus($('nmExportStatus'), 'Run a lookup first.', true);
  download(`fno-entity-names-${stamp()}.csv`, EN.lookupsToCsv(state.nameResults), 'text/csv');
  setStatus($('nmExportStatus'), 'Names CSV downloaded.');
});
