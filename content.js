/* =============================================================================
 * Dual-write Enum Mapper - content script
 *
 * Runs in the page context of an authenticated D365 F&O or Dataverse tab, so
 * every request is same-origin and rides the session you already have. No
 * tokens, no client secrets, no app registration.
 *
 * READ-ONLY BY CONSTRUCTION: every request goes through safeGet(), which
 * hardcodes method GET and refuses any URL that is not on the metadata
 * allowlist. There is no other fetch call in this file.
 * ========================================================================== */

(() => {
  'use strict';

  if (window.__dwEnumMapperLoaded) return;
  window.__dwEnumMapperLoaded = true;

  const ORIGIN = location.origin;
  const LANG = 'en-us';

  // ---------------------------------------------------------------------------
  // Environment detection
  // ---------------------------------------------------------------------------

  function detectEnv() {
    const h = location.hostname.toLowerCase();
    if (h.includes('.operations.') && h.endsWith('dynamics.com')) return 'fno';
    if (/\.crm\d*\.dynamics\.com$/.test(h) || /\.crm\.dynamics\.com$/.test(h)) return 'dataverse';
    // Fall back on a probe of what the origin actually serves.
    return 'unknown';
  }

  // ---------------------------------------------------------------------------
  // Read-only guard + throttle/retry
  // ---------------------------------------------------------------------------

  const READ_ALLOWLIST = [
    /^\/metadata\/PublicEnumerations(\('[^']*'\))?(\?.*)?$/i,
    /^\/metadata\/PublicEntities(\('[^']*'\))?(\?.*)?$/i,
    /^\/metadata\/DataEntities(\('[^']*'\))?(\?.*)?$/i,
    /^\/metadata\/Labels\(Id='[^']*',Language='[^']*'\)(\?.*)?$/i,
    /^\/api\/data\/v9\.\d+\/EntityDefinitions(\(|\/|\?|$).*$/i,
    /^\/api\/data\/v9\.\d+\/GlobalOptionSetDefinitions(\(|\/|\?|$).*$/i,
    /^\/data\/\$metadata(\?.*)?$/i,
    // Entity-name lookup liveness check: one row, nothing else. The collection
    // name always comes from DataEntities, never from what the user typed.
    /^\/data\/[A-Za-z_][A-Za-z0-9_]*\?\$top=1&cross-company=true$/
  ];

  class ReadOnlyViolation extends Error {}
  class HttpError extends Error {
    constructor(status, url, body) {
      super(`HTTP ${status} for ${url}`);
      this.status = status;
      this.url = url;
      this.body = body;
    }
  }

  function assertReadOnly(url) {
    const u = new URL(url, ORIGIN);
    if (u.origin !== ORIGIN) {
      throw new ReadOnlyViolation(`Refusing cross-origin request to ${u.origin}`);
    }
    const path = u.pathname + u.search;
    if (!READ_ALLOWLIST.some((re) => re.test(path))) {
      throw new ReadOnlyViolation(`Refusing non-allowlisted path: ${u.pathname}`);
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let throttleUntil = 0; // global backoff gate shared by all in-flight requests

  async function safeGet(url, opts = {}) {
    const text = await safeGetText(url, opts);
    if (text === null || text === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `Expected JSON from ${url} but got something else. ` +
        `This usually means the session expired - reload the environment tab and sign in again.`
      );
    }
  }

  async function safeGetText(url, { retries = 5, headers = {} } = {}) {
    assertReadOnly(url);

    let attempt = 0;
    for (;;) {
      const wait = throttleUntil - Date.now();
      if (wait > 0) await sleep(wait);

      let res;
      try {
        res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'application/json', ...headers }
        });
      } catch (networkErr) {
        if (attempt++ >= retries) {
          throw new Error(`Network error calling ${url}: ${networkErr.message}`);
        }
        await sleep(backoffMs(attempt));
        continue;
      }

      if (res.status === 429 || res.status === 503 || res.status === 502) {
        const retryAfter = parseFloat(res.headers.get('Retry-After') || '0');
        const delay = retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt + 1);
        throttleUntil = Math.max(throttleUntil, Date.now() + delay);
        if (attempt++ >= retries) {
          throw new HttpError(res.status, url, await safeText(res));
        }
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        throw new HttpError(res.status, url,
          'Not authenticated for this environment. Open the environment in this tab, ' +
          'sign in, let the app finish loading, then run again.');
      }

      if (!res.ok) {
        throw new HttpError(res.status, url, await safeText(res));
      }

      const text = await res.text();
      return text || null;
    }
  }

  function backoffMs(attempt) {
    const base = Math.min(30000, 500 * Math.pow(2, attempt));
    return base + Math.random() * 300; // jitter
  }

  async function safeText(res) {
    try { return (await res.text()).slice(0, 500); } catch { return ''; }
  }

  // Follow OData paging until exhausted.
  async function getAllPages(url, onPage) {
    let next = url;
    const out = [];
    let guard = 0;
    while (next) {
      if (guard++ > 2000) throw new Error('Aborting: more than 2000 pages, this looks like a paging loop.');
      const data = await safeGet(next);
      const batch = (data && data.value) || [];
      out.push(...batch);
      if (onPage) onPage(out.length);
      const nl = data && data['@odata.nextLink'];
      next = nl ? new URL(nl, ORIGIN).toString() : null;
    }
    return out;
  }

  // Bounded-concurrency map.
  async function pool(items, limit, worker, onTick) {
    const results = new Array(items.length);
    let idx = 0;
    let done = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      for (;;) {
        const i = idx++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
        done++;
        if (onTick) onTick(done, items.length);
      }
    });
    await Promise.all(runners);
    return results;
  }

  // ---------------------------------------------------------------------------
  // Label cache (persisted in chrome.storage.local, debounced)
  // ---------------------------------------------------------------------------

  const LABEL_KEY = `dwem:labelcache:${LANG}`;
  let labelCache = null;
  let labelCacheDirty = false;
  let flushTimer = null;

  async function loadLabelCache() {
    if (labelCache) return labelCache;
    const got = await chrome.storage.local.get(LABEL_KEY);
    labelCache = got[LABEL_KEY] || {};
    return labelCache;
  }

  function scheduleFlush() {
    labelCacheDirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(flushLabelCache, 3000);
  }

  async function flushLabelCache() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!labelCacheDirty || !labelCache) return;
    labelCacheDirty = false;
    try {
      await chrome.storage.local.set({ [LABEL_KEY]: labelCache });
    } catch (e) {
      // After the extension is reloaded, this orphaned copy loses chrome.storage
      // ("Extension context invalidated"). The cache is only an optimisation.
      console.debug('[dw-enum-mapper] label cache not saved:', e.message);
    }
  }

  async function resolveLabels(labelIds, onTick) {
    const cache = await loadLabelCache();
    const unique = [...new Set(labelIds.filter((x) => typeof x === 'string' && x.trim()))];
    // Real label references start with '@' (@SYS12345, @Module:Label). Anything else
    // is label text typed straight into the AOT ("psi", "Cube-100") and is the label.
    const isRef = (id) => id.trim().startsWith('@');
    const missing = unique.filter((id) => isRef(id) && !(id in cache));

    if (missing.length) {
      await pool(missing, 4, async (id) => {
        const url = `${ORIGIN}/metadata/Labels(Id='${encodeURIComponent(id)}',Language='${LANG}')`;
        try {
          const data = await safeGet(url, { retries: 3 });
          // The metadata service returns the text in `Value`; some builds nest it.
          const text = data && (data.Value ?? data.value ?? data.LabelText);
          cache[id] = typeof text === 'string' ? text : null;
        } catch (e) {
          // A label that will not resolve must not kill a 3000-enum dump.
          cache[id] = null;
          console.debug(`[dw-enum-mapper] label ${id} did not resolve: ${e.message}`);
        }
        scheduleFlush();
      }, onTick);
      await flushLabelCache();
    }

    const out = {};
    for (const id of unique) out[id] = isRef(id) ? (cache[id] ?? null) : id;
    return out;
  }

  // ---------------------------------------------------------------------------
  // F&O metadata
  // ---------------------------------------------------------------------------

  async function fnoListEnumNames(progress) {
    const rows = await getAllPages(
      `${ORIGIN}/metadata/PublicEnumerations`,
      (n) => progress(`Listing enums... ${n} so far`)
    );
    return rows
      .map((r) => (typeof r === 'string' ? r : r.Name))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * PublicEntities reports property types namespace-qualified
   * ("Microsoft.Dynamics.DataEntities.CredManCreditLimitAdjJournalStatus"),
   * but PublicEnumerations is keyed on the bare AOT name. Strip the namespace.
   */
  function bareEnumName(typeName) {
    return String(typeName || '').split('.').pop();
  }

  async function fnoGetEnum(name) {
    const bare = bareEnumName(name);
    const url = `${ORIGIN}/metadata/PublicEnumerations('${encodeURIComponent(bare)}')`;
    let data;
    try {
      data = await safeGet(url);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        return { name: bare, error: `Enum "${bare}" was not found in this environment. Check spelling and casing - the metadata service is case-sensitive on the AOT name.` };
      }
      return { name: bare, error: friendly(e) };
    }
    if (!data) return { name: bare, error: `Enum "${bare}" returned an empty response.` };

    const members = (data.Members || data.members || []).map((m) => ({
      name: m.Name,
      value: typeof m.Value === 'number' ? m.Value : parseInt(m.Value, 10),
      labelId: m.LabelId || null,
      configurationEnabled: m.ConfigurationEnabled !== false
    }));

    return {
      name: data.Name || bare,
      labelId: data.LabelId || null,
      members
    };
  }

  async function fnoHydrateLabels(enums, progress) {
    const ids = [];
    for (const e of enums) {
      if (e.error) continue;
      if (e.labelId) ids.push(e.labelId);
      for (const m of e.members) if (m.labelId) ids.push(m.labelId);
    }
    const map = await resolveLabels(ids, (d, t) => progress(`Resolving labels ${d}/${t}`));
    for (const e of enums) {
      if (e.error) continue;
      e.label = e.labelId ? map[e.labelId] : null;
      for (const m of e.members) {
        m.label = m.labelId ? map[m.labelId] : null;
      }
    }
    return enums;
  }

  // Find the enum-typed properties on a public entity.
  async function fnoGetEntityEnumProps(entityName, knownEnumNames) {
    const url = `${ORIGIN}/metadata/PublicEntities('${encodeURIComponent(entityName)}')`;
    let data;
    try {
      data = await safeGet(url);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        throw new Error(
          `Entity "${entityName}" was not found. Note this endpoint wants the public entity name ` +
          `(e.g. "SalesOrderHeaderV2"), not the data entity or table name.`
        );
      }
      throw new Error(friendly(e));
    }

    const props = data.Properties || data.properties || [];
    const known = knownEnumNames ? new Set(knownEnumNames) : null;

    return props
      .filter((p) => {
        const dt = String(p.DataType || '').toLowerCase();
        if (dt === 'enum') return true;
        // Defensive fallback: some builds report the data type differently, so
        // also accept a property whose type resolves to a real enum name.
        return known ? known.has(bareEnumName(p.TypeName)) : false;
      })
      .map((p) => ({
        property: p.Name,
        enumName: bareEnumName(p.TypeName),
        qualifiedTypeName: p.TypeName,
        labelId: p.LabelId || null,
        isMandatory: !!p.IsMandatory
      }));
  }

  // Enum name list is reused by search, fuzzy-match and entity mode. Cached for
  // the life of the page and in storage, because it is a big response.
  const ENUM_LIST_KEY = 'dwem:enumnames';
  let enumNameCache = null;

  async function getEnumNames(progress, force = false) {
    if (enumNameCache && !force) return enumNameCache;
    if (!force) {
      const got = await chrome.storage.local.get(ENUM_LIST_KEY);
      const cached = got[ENUM_LIST_KEY];
      if (cached && Array.isArray(cached.names) && cached.origin === ORIGIN) {
        enumNameCache = cached.names;
        return enumNameCache;
      }
    }
    enumNameCache = await fnoListEnumNames(progress || (() => {}));
    await chrome.storage.local.set({ [ENUM_LIST_KEY]: { origin: ORIGIN, names: enumNameCache } });
    return enumNameCache;
  }

  /** Rank candidate enum names against a search term. */
  function rankEnumNames(names, term) {
    const q = String(term || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!q) return [];
    const scored = [];
    for (const n of names) {
      const ln = n.toLowerCase().replace(/[^a-z0-9]/g, '');
      let score = -1;
      if (ln === q) score = 0;
      else if (ln.endsWith(q)) score = 1;          // CredManCreditLimitAdj*Status*
      else if (ln.startsWith(q)) score = 2;
      else if (ln.includes(q)) score = 3;
      if (score >= 0) scored.push([score, n.length, n]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]));
    return scored.map((x) => x[2]);
  }

  /**
   * Look a data entity up by any of the three names F&O shows for it: the AOT
   * data entity name (…Entity — what Data management shows as "Target entity"),
   * the public entity name, or the public collection name. Tries a server-side
   * $filter first, because DataEntities runs to several thousand rows.
   */
  async function fnoFindDataEntity(nameLike) {
    const n = String(nameLike).replace(/'/g, "''");
    const filter = `Name eq '${n}' or PublicEntityName eq '${n}' or PublicCollectionName eq '${n}'`;
    try {
      const data = await safeGet(`${ORIGIN}/metadata/DataEntities?$filter=${encodeURIComponent(filter)}`);
      const rows = (data && data.value) || [];
      if (rows.length) return rows[0];
    } catch { /* some builds reject the filter - fall back to a full scan */ }

    const rows = await getAllPages(`${ORIGIN}/metadata/DataEntities`);
    const lc = String(nameLike).toLowerCase();
    return rows.find((r) =>
      String(r.Name || '').toLowerCase() === lc ||
      String(r.PublicEntityName || '').toLowerCase() === lc ||
      String(r.PublicCollectionName || '').toLowerCase() === lc) || null;
  }

  /** Kept for the enum feature: just the public entity name, or null. */
  async function fnoResolvePublicEntityName(nameLike) {
    let row = null;
    try { row = await fnoFindDataEntity(nameLike); } catch { /* ignore */ }
    if (row && row.PublicEntityName) return row.PublicEntityName;
    if (/entity$/i.test(nameLike)) {
      const stripped = String(nameLike).replace(/entity$/i, '');
      try {
        const probe = await safeGet(`${ORIGIN}/metadata/PublicEntities('${encodeURIComponent(stripped)}')`);
        if (probe && (probe.Name || probe.Properties)) return probe.Name || stripped;
      } catch { /* ignore */ }
    }
    return null;
  }

  /** Names worth trying against /metadata/PublicEntities, best guess first. */
  function publicNameCandidates(nameLike, row) {
    const out = [];
    if (row && row.PublicEntityName) out.push(row.PublicEntityName);
    if (/entity$/i.test(nameLike)) out.push(String(nameLike).replace(/entity$/i, ''));
    if (row && row.PublicCollectionName) out.push(row.PublicCollectionName);
    const seen = new Set();
    return out.filter((n) => {
      if (!n) return false;
      const k = n.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /**
   * Resolve whatever the user typed into a public entity whose fields we can read.
   * Distinguishes "no such entity" from "exists, but not exposed on the public
   * (OData/Metadata) surface" from "the call itself failed" — the old code
   * collapsed all three into "not found in this environment".
   */
  async function fnoResolveEntity(entityName, progress) {
    const tried = [];
    let transportError = null;

    const attempt = async (name) => {
      tried.push(name);
      try {
        return await fnoGetEntityFields(name);
      } catch (e) {
        const missing = (e instanceof HttpError && e.status === 404) || /empty response/i.test(String(e && e.message));
        if (!missing) transportError = e;
        return null;
      }
    };

    let entity = await attempt(entityName);
    if (entity) return { entity, resolvedAs: null, dataEntityRow: null, tried, transportError: null };

    // "ProjInvoiceProposalV2Entity" (the Data management target entity name) is
    // almost always the public entity name plus the word Entity.
    if (/entity$/i.test(entityName)) {
      const stripped = String(entityName).replace(/entity$/i, '');
      if (progress) progress(`"${entityName}" is not a public entity name - trying "${stripped}"...`);
      entity = await attempt(stripped);
      if (entity) return { entity, resolvedAs: stripped, dataEntityRow: null, tried, transportError: null };
    }

    if (progress) progress(`Checking DataEntities for "${entityName}"...`);
    let row = null;
    try {
      row = await fnoFindDataEntity(entityName);
    } catch (e) {
      transportError = transportError || e;
    }

    for (const cand of publicNameCandidates(entityName, row)) {
      if (tried.some((t) => t.toLowerCase() === cand.toLowerCase())) continue;
      if (progress) progress(`Trying public entity "${cand}"...`);
      entity = await attempt(cand);
      if (entity) return { entity, resolvedAs: cand, dataEntityRow: row, tried, transportError: null };
    }

    // Last resort: the public entity list, ignoring case and punctuation.
    let names = [];
    try { names = await getEntityNames(progress); } catch (e) { transportError = transportError || e; }
    const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
    const q = norm(entityName);
    const qStripped = q.replace(/entity$/, '');
    const hit = names.find((n) => norm(n) === q) || names.find((n) => norm(n) === qStripped);
    if (hit && !tried.some((t) => t.toLowerCase() === hit.toLowerCase())) {
      if (progress) progress(`Found it as "${hit}" (casing differed)`);
      entity = await attempt(hit);
      if (entity) return { entity, resolvedAs: hit, dataEntityRow: row, tried, transportError: null };
    }

    return { entity: null, resolvedAs: null, dataEntityRow: row, tried, transportError, names };
  }

  // ---------------------------------------------------------------------------
  // Entity list + field metadata (Fields feature)
  // ---------------------------------------------------------------------------

  const ENTITY_LIST_KEY = 'dwem:entitynames';
  let entityNameCache = null;

  async function getEntityNames(progress, force = false) {
    if (entityNameCache && !force) return entityNameCache;
    if (!force) {
      const got = await chrome.storage.local.get(ENTITY_LIST_KEY);
      const c = got[ENTITY_LIST_KEY];
      if (c && Array.isArray(c.names) && c.origin === ORIGIN) {
        entityNameCache = c.names;
        return entityNameCache;
      }
    }
    const rows = await getAllPages(
      `${ORIGIN}/metadata/PublicEntities`,
      (n) => progress && progress(`Listing entities... ${n} so far`)
    );
    entityNameCache = rows
      .map((r) => (typeof r === 'string' ? r : r.Name))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    await chrome.storage.local.set({ [ENTITY_LIST_KEY]: { origin: ORIGIN, names: entityNameCache } });
    return entityNameCache;
  }

  /** Every property on a public entity, not just the enum-typed ones. */
  async function fnoGetEntityFields(entityName) {
    const url = `${ORIGIN}/metadata/PublicEntities('${encodeURIComponent(entityName)}')`;
    const data = await safeGet(url);
    if (!data) throw new Error(`Entity "${entityName}" returned an empty response.`);

    const props = (data.Properties || data.properties || []).map((p) => ({
      name: p.Name,
      dataType: p.DataType || null,
      typeName: p.TypeName || null,
      enumName: String(p.DataType || '').toLowerCase() === 'enum' ? bareEnumName(p.TypeName) : null,
      labelId: p.LabelId || null,
      isKey: p.IsKey === true,
      isMandatory: p.IsMandatory === true,
      allowEdit: p.AllowEdit !== false,
      allowEditOnCreate: p.AllowEditOnCreate !== false,
      configurationEnabled: p.ConfigurationEnabled !== false,
      isDimension: p.IsDimension === true,
      propertyOrder: typeof p.PropertyOrder === 'number' ? p.PropertyOrder : 0
    }));

    return {
      name: data.Name || entityName,
      entitySetName: data.EntitySetName || null,
      labelId: data.LabelId || null,
      isReadOnly: data.IsReadOnly === true,
      properties: props
    };
  }

  /** Cross-check against DataEntities, which carries a few extra flags. */
  async function fnoGetDataEntityInfo(publicEntityName) {
    try {
      const rows = await getAllPages(`${ORIGIN}/metadata/DataEntities`);
      const lc = String(publicEntityName).toLowerCase();
      const hit = rows.find((r) => String(r.PublicEntityName || '').toLowerCase() === lc);
      if (!hit) return null;
      return {
        name: hit.Name,
        publicEntityName: hit.PublicEntityName,
        publicCollectionName: hit.PublicCollectionName,
        labelId: hit.LabelId || null,
        isReadOnly: hit.IsReadOnly === true,
        dataServiceEnabled: hit.DataServiceEnabled !== false,
        dataManagementEnabled: hit.DataManagementEnabled !== false,
        entityCategory: hit.EntityCategory || null
      };
    } catch {
      return null; // cross-check is best-effort, never fatal
    }
  }

  // ---------------------------------------------------------------------------
  // $metadata probe - the ONLY place length/precision/scale can come from
  //
  // The Metadata REST API does not publish MaxLength / Precision / Scale.
  // Some F&O builds emit them as EDM facets in /data/$metadata and some do not,
  // so we look, and we say plainly what we found. We never invent a number.
  // ---------------------------------------------------------------------------

  const EDM_KEY_PREFIX = 'dwem:edm:';
  let edmDocument = null;        // held for the tab's lifetime only, never stored
  let edmCapability = null;

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  async function loadEdmDocument(progress) {
    if (edmDocument) return edmDocument;
    progress && progress('Downloading /data/$metadata (this is a large document, one time per tab)...');
    const text = await safeGetText(`${ORIGIN}/data/$metadata`, { retries: 3 });
    if (!text) throw new Error('The $metadata document came back empty.');
    if (!/<Edmx|<edmx/i.test(text)) {
      throw new Error('The $metadata response was not an EDM document. The session may have expired - reload the F&O tab and sign in again.');
    }
    edmDocument = text;
    progress && progress(`$metadata loaded (${Math.round(text.length / 1024 / 1024 * 10) / 10} MB).`);
    return edmDocument;
  }

  function extractEntityTypeFragment(xml, entityName) {
    const re = new RegExp(`<EntityType[^>]*\\bName="${escapeRe(entityName)}"[^>]*>[\\s\\S]*?</EntityType>`, 'i');
    const m = xml.match(re);
    return m ? m[0] : null;
  }

  function parseEdmProperties(fragment) {
    const out = {};
    const re = /<Property\b([^>]*?)\/?>/g;
    let m;
    while ((m = re.exec(fragment)) !== null) {
      const a = m[1];
      const name = (a.match(/\bName="([^"]*)"/) || [])[1];
      if (!name) continue;
      const num = (re2) => {
        const v = (a.match(re2) || [])[1];
        return v === undefined ? null : (/^\d+$/.test(v) ? parseInt(v, 10) : v);
      };
      out[name] = {
        edmType: (a.match(/\bType="([^"]*)"/) || [])[1] || null,
        maxLength: num(/\bMaxLength="([^"]*)"/),
        precision: num(/\bPrecision="([^"]*)"/),
        scale: num(/\bScale="([^"]*)"/)
      };
    }
    return out;
  }

  /** Does THIS environment publish facets at all? Answers in one fetch. */
  async function probeEdmCapability(progress) {
    if (edmCapability) return edmCapability;
    const xml = await loadEdmDocument(progress);
    const sample = xml.slice(0, 3000000); // enough properties to judge
    const props = (sample.match(/<Property\b[^>]*>/g) || []);
    const withLen = props.filter((p) => /\bMaxLength="/.test(p)).length;
    const withPrec = props.filter((p) => /\bPrecision="/.test(p)).length;
    const withScale = props.filter((p) => /\bScale="/.test(p)).length;
    edmCapability = {
      sampled: props.length,
      maxLength: withLen,
      precision: withPrec,
      scale: withScale,
      publishesLength: withLen > 0,
      publishesPrecision: withPrec > 0,
      documentBytes: xml.length
    };
    return edmCapability;
  }

  async function getEdmForEntity(entityName, progress) {
    const key = EDM_KEY_PREFIX + ORIGIN + ':' + entityName;
    const got = await chrome.storage.local.get(key);
    if (got[key]) return got[key];

    const xml = await loadEdmDocument(progress);
    const frag = extractEntityTypeFragment(xml, entityName);
    if (!frag) return { __notFound: true };
    const parsed = parseEdmProperties(frag);
    await chrome.storage.local.set({ [key]: parsed });
    return parsed;
  }

  // ---------------------------------------------------------------------------
  // Entity names (AOT name <-> public entity name <-> public collection name)
  // ---------------------------------------------------------------------------

  const EN = globalThis.DWEntityNames;
  const DATA_ENTITY_LIST_KEY = 'dwem:dataentities';
  let dataEntityCache = null;

  function slimDataEntity(r) {
    return {
      name: r.Name || null,
      publicEntityName: r.PublicEntityName || null,
      publicCollectionName: r.PublicCollectionName || null,
      labelId: r.LabelId || null,
      entityCategory: r.EntityCategory || null,
      dataServiceEnabled: r.DataServiceEnabled !== false,
      dataManagementEnabled: r.DataManagementEnabled !== false,
      isReadOnly: r.IsReadOnly === true
    };
  }

  async function getDataEntityList(progress, force = false) {
    if (dataEntityCache && !force) return dataEntityCache;
    if (!force) {
      const got = await chrome.storage.local.get(DATA_ENTITY_LIST_KEY);
      const c = got[DATA_ENTITY_LIST_KEY];
      if (c && Array.isArray(c.rows) && c.origin === ORIGIN) {
        dataEntityCache = c.rows;
        return dataEntityCache;
      }
    }
    const rows = await getAllPages(
      `${ORIGIN}/metadata/DataEntities`,
      (n) => progress && progress(`Listing data entities... ${n} so far`)
    );
    dataEntityCache = rows.map(slimDataEntity).filter((r) => r.name);
    await chrome.storage.local.set({ [DATA_ENTITY_LIST_KEY]: { origin: ORIGIN, rows: dataEntityCache } });
    return dataEntityCache;
  }

  /** Server-side exact lookup (case-sensitive). Null when the build rejects the filter or nothing matches. */
  async function filterDataEntity(typed) {
    const n = String(typed).replace(/'/g, "''");
    const filter = `Name eq '${n}' or Name eq '${n}Entity' or PublicEntityName eq '${n}' or PublicCollectionName eq '${n}'`;
    try {
      const data = await safeGet(`${ORIGIN}/metadata/DataEntities?$filter=${encodeURIComponent(filter)}`);
      const rows = ((data && data.value) || []).map(slimDataEntity);
      if (!rows.length) return null;
      return EN.findExact(rows, typed);
    } catch {
      return null;
    }
  }

  /** One GET of one row from /data/<collection> - the same surface Power Automate calls. */
  async function verifyCollection(collection) {
    if (!collection) {
      return { ok: false, summary: 'no public collection name - not reachable from Power Automate' };
    }
    try {
      const data = await safeGet(`${ORIGIN}/data/${collection}?$top=1&cross-company=true`, { retries: 2 });
      const first = data && Array.isArray(data.value) ? data.value[0] : null;
      const fields = first ? Object.keys(first).filter((k) => !k.startsWith('@')).length : null;
      return {
        ok: true,
        hasRows: !!first,
        fieldCount: fields,
        summary: first ? `OK - /data/${collection} returns rows (${fields} fields)` : `OK - /data/${collection} answers but has no rows yet`
      };
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        return { ok: false, summary: `404 on /data/${collection} - OData is not serving it (check DataServiceEnabled / the entity is built and synced)` };
      }
      return { ok: false, summary: `Could not check: ${friendly(e)}` };
    }
  }

  async function lookupEntityNames(names, { verify }, progress) {
    const results = [];
    let list = null;

    for (let i = 0; i < names.length; i++) {
      const typed = names[i];
      progress(`Looking up ${i + 1}/${names.length}: ${typed}`);
      const res = { input: typed, status: 'notFound', matchedOn: null, entity: null, candidates: [], notes: [] };

      let hit = await filterDataEntity(typed);
      if (!hit) {
        if (!list) list = await getDataEntityList(progress);
        hit = EN.findExact(list, typed);
      }

      if (hit) {
        res.status = 'found';
        res.matchedOn = hit.matchedOn;
        res.entity = { ...hit.row };
      } else {
        const ranked = EN.rankCandidates(list, typed);
        res.candidates = ranked.map((c) => ({ ...c, row: { ...c.row } }));
        if (ranked.length && ranked[0].score >= 0.9 && (ranked.length === 1 || ranked[0].score - ranked[1].score >= 0.1)) {
          res.status = 'fuzzy';
          res.matchedOn = `${ranked[0].matchedOn}, similarity ${ranked[0].score}`;
          res.entity = { ...ranked[0].row };
          res.candidates = res.candidates.slice(1);
          res.notes.push(`No exact match for "${typed}". This is the closest name - confirm it before you use it.`);
        }
      }

      if (res.entity) {
        const div = EN.nameDivergence(res.entity);
        if (div) res.notes.push(div);
        if (!res.entity.publicCollectionName) {
          res.notes.push('Not a public entity: it has no OData collection, so the Fin & Ops connector cannot see it at all.');
        } else if (!res.entity.dataServiceEnabled) {
          res.notes.push('OData is switched off for this entity (DataServiceEnabled = No), so the connector will not list it.');
        }
      }
      results.push(res);
    }

    // Labels for everything we show (found rows + candidates), through the shared cache.
    const labelIds = [];
    for (const r of results) {
      if (r.entity && r.entity.labelId) labelIds.push(r.entity.labelId);
      for (const c of r.candidates) if (c.row.labelId) labelIds.push(c.row.labelId);
    }
    if (labelIds.length) {
      const labels = await resolveLabels(labelIds, (d, t) => progress(`Resolving labels ${d}/${t}`));
      for (const r of results) {
        if (r.entity && r.entity.labelId) r.entity.label = labels[r.entity.labelId];
        for (const c of r.candidates) if (c.row.labelId) c.row.label = labels[c.row.labelId];
      }
    }

    if (verify) {
      const targets = results.filter((r) => r.entity);
      await pool(targets, 3, async (r) => {
        r.verify = await verifyCollection(r.entity.publicCollectionName);
      }, (d, t) => progress(`Checking /data ${d}/${t}`));
    }

    return { results, totalEntities: list ? list.length : null };
  }

  // ---------------------------------------------------------------------------
  // Dataverse metadata
  // ---------------------------------------------------------------------------

  const DV_HEADERS = {
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
    'Accept': 'application/json'
  };

  function dvLabelOf(labelObj) {
    if (!labelObj) return null;
    const ul = labelObj.UserLocalizedLabel;
    if (ul && typeof ul.Label === 'string') return ul.Label;
    const first = (labelObj.LocalizedLabels || [])[0];
    return first && typeof first.Label === 'string' ? first.Label : null;
  }

  // Choice-like attribute types. statecode (Status) and statuscode (Status Reason)
  // are not PicklistAttributeMetadata, so a Picklist-only cast never returns them.
  const DV_CHOICE_CASTS = [
    'PicklistAttributeMetadata',
    'StateAttributeMetadata',
    'StatusAttributeMetadata'
  ];

  async function dvGetTablePicklists(table, column) {
    const entity = `${ORIGIN}/api/data/v9.2/EntityDefinitions(LogicalName='${encodeURIComponent(table)}')`;

    const attrs = [];
    for (const cast of DV_CHOICE_CASTS) {
      const url = `${entity}/Attributes/Microsoft.Dynamics.CRM.${cast}` +
        `?$select=LogicalName,SchemaName,DisplayName&$expand=OptionSet($select=Options,Name,IsGlobal,MetadataId)`;
      let data;
      try {
        data = await safeGet(url, { headers: DV_HEADERS });
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) {
          throw new Error(`Dataverse table "${table}" was not found. Use the logical name (lowercase, e.g. "arq_quoteapproval"), not the display name.`);
        }
        throw new Error(friendly(e));
      }
      attrs.push(...(data.value || []));
    }

    let cols = attrs.map((a) => ({
      logicalName: a.LogicalName,
      schemaName: a.SchemaName,
      displayName: dvLabelOf(a.DisplayName),
      isGlobal: !!(a.OptionSet && a.OptionSet.IsGlobal),
      optionSetName: a.OptionSet && a.OptionSet.Name,
      options: ((a.OptionSet && a.OptionSet.Options) || []).map((o) => ({
        value: o.Value,
        label: dvLabelOf(o.Label),
        description: dvLabelOf(o.Description)
      }))
    }));

    if (column) {
      const want = String(column).toLowerCase();
      const hit = cols.filter((c) => c.logicalName.toLowerCase() === want);
      if (!hit.length) {
        const names = cols.map((c) => c.logicalName).slice(0, 40).join(', ');
        throw new Error(
          `Column "${column}" is not a choice column on "${table}". ` +
          `Choice columns found: ${names || '(none)'}`
        );
      }
      cols = hit;
    }

    return cols;
  }

  async function dvGetGlobalOptionSets(progress) {
    const url = `${ORIGIN}/api/data/v9.2/GlobalOptionSetDefinitions`;
    const rows = await getAllPages(url, (n) => progress && progress(`Global option sets... ${n}`));
    return rows
      .filter((r) => Array.isArray(r.Options))
      .map((r) => ({
        logicalName: r.Name,
        schemaName: r.Name,
        displayName: dvLabelOf(r.DisplayName) || r.Name,
        isGlobal: true,
        optionSetName: r.Name,
        options: (r.Options || []).map((o) => ({
          value: o.Value,
          label: dvLabelOf(o.Label),
          description: dvLabelOf(o.Description)
        }))
      }));
  }

  async function dvGetAllAttributes(table) {
    // No $select: Dataverse then returns each attribute with its own derived-type
    // properties (MaxLength, Precision, DateTimeBehavior, ...), which is exactly
    // what the comparison needs.
    const url = `${ORIGIN}/api/data/v9.2/EntityDefinitions(LogicalName='${encodeURIComponent(table)}')/Attributes`;
    let rows;
    try {
      rows = await getAllPages(url, null);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        throw new Error(`Dataverse table "${table}" was not found. Use the logical name (lowercase, e.g. "arq_salescontracts"), not the display name or the plural set name.`);
      }
      throw new Error(friendly(e));
    }
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Friendly errors
  // ---------------------------------------------------------------------------

  function friendly(e) {
    if (e instanceof ReadOnlyViolation) return `Blocked by the read-only guard: ${e.message}`;
    if (e instanceof HttpError) {
      if (e.status === 401 || e.status === 403) return e.body;
      if (e.status === 404) return `Not found (404): ${e.url}`;
      return `The environment returned HTTP ${e.status}. ${e.body || ''}`.trim();
    }
    return e.message || String(e);
  }

  // ---------------------------------------------------------------------------
  // Job dispatch
  // ---------------------------------------------------------------------------

  function progressFor(jobId) {
    return (message) => {
      chrome.runtime.sendMessage({ type: 'dwem:progress', jobId, message }).catch(() => {});
    };
  }

  const JOBS = {
    async detect() {
      return { env: detectEnv(), origin: ORIGIN };
    },

    async fnoEnum({ enumName }, progress) {
      progress(`Reading ${enumName}...`);
      let e = await fnoGetEnum(enumName);
      let resolvedAs = null;

      if (e.error) {
        // The name the user typed is very often the *field* name from the F&O
        // form (e.g. "Status"), not the AOT enum type name. Go find it.
        progress(`"${enumName}" is not an enum type name - searching the enum list...`);
        const names = await getEnumNames(progress);
        const ranked = rankEnumNames(names, bareEnumName(enumName));

        if (ranked.length && ranked[0].toLowerCase() === bareEnumName(enumName).toLowerCase()) {
          resolvedAs = ranked[0];
          progress(`Found it as "${resolvedAs}" (casing differed)`);
          e = await fnoGetEnum(resolvedAs);
        } else {
          return {
            enums: [e],
            searchedFor: enumName,
            suggestions: ranked.slice(0, 80),
            totalEnums: names.length
          };
        }
      }

      if (e.error) return { enums: [e] };
      await fnoHydrateLabels([e], progress);
      return { enums: [e], resolvedAs };
    },

    async fnoSearch({ query }, progress) {
      const names = await getEnumNames(progress);
      return {
        enums: [],
        searchedFor: query,
        suggestions: rankEnumNames(names, bareEnumName(query)).slice(0, 200),
        totalEnums: names.length
      };
    },

    async fnoEntity({ entityName }, progress) {
      progress(`Listing enums (needed to type-match entity properties)...`);
      const known = await getEnumNames(progress);
      progress(`Reading entity ${entityName}...`);

      let props;
      let resolvedAs = null;
      try {
        props = await fnoGetEntityEnumProps(entityName, known);
      } catch (first) {
        progress(`"${entityName}" is not a public entity name - checking DataEntities...`);
        const real = await fnoResolvePublicEntityName(entityName);
        if (!real) throw first;
        resolvedAs = real;
        progress(`Resolved to public entity "${real}"`);
        props = await fnoGetEntityEnumProps(real, known);
      }
      if (!props.length) {
        return { enums: [], entityProps: [], resolvedAs, note: `No enum-typed properties found on "${resolvedAs || entityName}".` };
      }
      const wanted = [...new Set(props.map((p) => p.enumName))];
      const enums = [];
      await pool(wanted, 4, async (n) => {
        enums.push(await fnoGetEnum(n));
      }, (d, t) => progress(`Reading enums ${d}/${t}`));
      await fnoHydrateLabels(enums, progress);
      return { enums, entityProps: props, resolvedAs };
    },

    async fnoDumpAll({ limit }, progress) {
      const names = await fnoListEnumNames(progress);
      const target = limit ? names.slice(0, limit) : names;
      const enums = [];
      await pool(target, 4, async (n) => {
        enums.push(await fnoGetEnum(n));
      }, (d, t) => progress(`Reading enums ${d}/${t}`));
      enums.sort((a, b) => a.name.localeCompare(b.name));
      await fnoHydrateLabels(enums, progress);
      return { enums, total: names.length };
    },

    async dvTable({ table, column }, progress) {
      progress(`Reading ${table}${column ? '.' + column : ''}...`);
      const columns = await dvGetTablePicklists(table, column);
      return { columns };
    },

    async dvGlobal(_args, progress) {
      const columns = await dvGetGlobalOptionSets(progress);
      return { columns };
    },

    // ----- Fields feature -----------------------------------------------------

    async fnoEntityList({ query }, progress) {
      const names = await getEntityNames(progress);
      if (!query) return { names: names.slice(0, 200), total: names.length };
      const q = String(query).toLowerCase().replace(/[^a-z0-9]/g, '');
      const ranked = names
        .map((n) => [n, n.toLowerCase().replace(/[^a-z0-9]/g, '')])
        .filter(([, ln]) => ln.includes(q))
        .sort((a, b) => (a[1] === q ? -1 : b[1] === q ? 1 : a[0].length - b[0].length))
        .map(([n]) => n);
      return { names: ranked.slice(0, 200), total: names.length, matched: ranked.length };
    },

    async fnoEdmCapability(_args, progress) {
      return await probeEdmCapability(progress);
    },

    async fnoFields({ entityName, useEdm }, progress) {
      progress(`Reading entity ${entityName}...`);

      const res = await fnoResolveEntity(entityName, progress);
      const entity = res.entity;
      const resolvedAs = res.resolvedAs;

      if (!entity) {
        let names = res.names || [];
        if (!names.length) { try { names = await getEntityNames(progress); } catch { names = []; } }
        const q = String(entityName).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/entity$/, '');
        const suggestions = names
          .filter((n) => n.toLowerCase().replace(/[^a-z0-9]/g, '').includes(q))
          .slice(0, 60);

        const row = res.dataEntityRow;
        let error, hint = null;

        if (res.transportError) {
          error = `Could not read metadata for "${entityName}": ${friendly(res.transportError)}`;
          hint = 'This is a transport or permission problem, not a missing entity. Reload the F&O tab, make sure the app has finished loading, and try again.';
        } else if (row && !row.PublicEntityName) {
          error = `"${entityName}" exists in this environment as a data entity, but it is not exposed as a public entity, so the Metadata REST API publishes no field list for it.`;
          hint = 'Field and key metadata for a non-public entity can only be seen in F&O itself: Data management > the entity > Entity structure / Target fields, or the AOT. Dual write also needs a public entity, so this is worth raising with the F&O partner.';
        } else if (row) {
          error = `"${entityName}" is a data entity whose public name is "${row.PublicEntityName}", but /metadata/PublicEntities('${row.PublicEntityName}') returned nothing.`;
          hint = `That normally means OData is switched off for it (DataServiceEnabled = ${row.DataServiceEnabled !== false}). The entity is still usable in Data management, but not through this API.`;
        } else {
          error = `Entity "${entityName}" was not found as a public entity or a data entity in this environment.`;
          hint = suggestions.length
            ? 'Pick one of the close matches below, or check the spelling against Data management > Target entities.'
            : 'Check the spelling against Data management > Target entities, and make sure you are pointed at the right F&O environment.';
        }

        return {
          error,
          hint,
          tried: res.tried,
          dataEntityRow: row ? {
            name: row.Name,
            publicEntityName: row.PublicEntityName || null,
            publicCollectionName: row.PublicCollectionName || null,
            entityCategory: row.EntityCategory || null,
            dataServiceEnabled: row.DataServiceEnabled !== false,
            dataManagementEnabled: row.DataManagementEnabled !== false,
            isReadOnly: row.IsReadOnly === true
          } : null,
          suggestions,
          searchedFor: entityName,
          totalEntities: names.length
        };
      }

      if (resolvedAs) progress(`Resolved to public entity "${resolvedAs}"`);

      // Optional EDM enrichment for length / precision / scale.
      let edm = {};
      let edmStatus = { attempted: false, available: false, message: 'Not requested.' };
      if (useEdm) {
        edmStatus.attempted = true;
        try {
          const cap = await probeEdmCapability(progress);
          const parsed = await getEdmForEntity(entity.name, progress);
          if (parsed && parsed.__notFound) {
            edmStatus.message = `This entity does not appear as an EntityType in $metadata (it may not be exposed on the /data endpoint). No length or precision available.`;
          } else {
            edm = parsed || {};
            const withLen = Object.values(edm).filter((v) => v.maxLength !== null).length;
            const withPrec = Object.values(edm).filter((v) => v.precision !== null).length;
            edmStatus.available = withLen > 0 || withPrec > 0;
            edmStatus.message = edmStatus.available
              ? `$metadata supplied length for ${withLen} field(s) and precision for ${withPrec} field(s) on this entity.`
              : `$metadata was read, but this environment does not publish MaxLength/Precision facets (${cap.maxLength} of ${cap.sampled} sampled properties carried a length). Length and precision must be confirmed with the F&O developer.`;
          }
          edmStatus.capability = cap;
        } catch (e) {
          edmStatus.message = `Could not read $metadata: ${friendly(e)}`;
        }
      }

      // Resolve field labels through the existing cache.
      const labelIds = entity.properties.map((p) => p.labelId).filter(Boolean);
      if (entity.labelId) labelIds.push(entity.labelId);
      const labels = await resolveLabels(labelIds, (d, t) => progress(`Resolving field labels ${d}/${t}`));
      entity.label = entity.labelId ? labels[entity.labelId] : null;
      for (const p of entity.properties) p.label = p.labelId ? labels[p.labelId] : null;

      const dataEntity = await fnoGetDataEntityInfo(entity.name);

      return { entity, edm, edmStatus, dataEntity, resolvedAs };
    },

    async fnoEntityNames({ names, verify, refresh }, progress) {
      const list = (names || []).map((n) => String(n).trim()).filter(Boolean);
      if (!list.length) throw new Error('Enter at least one entity name.');
      if (list.length > 200) throw new Error('Up to 200 names per run, please.');
      if (refresh) { await getDataEntityList(progress, true); }
      return await lookupEntityNames(list, { verify: !!verify }, progress);
    },

    async dvAttributes({ table }, progress) {
      progress(`Reading Dataverse columns on ${table}...`);
      const raw = await dvGetAllAttributes(table);
      return { table, attributes: raw };
    }
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'dwem:job') return false;
    const handler = JOBS[msg.job];
    if (!handler) {
      sendResponse({ ok: false, error: `Unknown job "${msg.job}"` });
      return false;
    }
    handler(msg.args || {}, progressFor(msg.jobId))
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => {
        // Shown to the user in the panel; debug level keeps it out of chrome://extensions Errors.
        console.debug('[dw-enum-mapper]', e);
        sendResponse({ ok: false, error: friendly(e) });
      })
      .finally(() => { flushLabelCache(); });
    return true; // async
  });
})();
