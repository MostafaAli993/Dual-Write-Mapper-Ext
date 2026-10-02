# Dual-write Enum Mapper

A read-only Chrome extension that pulls **F&O AOT enum element names, labels and integer
values** and **Dataverse choice options**, cross-references them by label text, and
generates ready-to-paste dual-write `ValueMap` JSON.

It exists because dual-write `ValueMap` transforms match on the F&O *element name*, which
the F&O UI never shows you — so `Not submitted` is really `Draft`, `Rejected` is really
`Denied`, and you only find out when a sync run fails.

---

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Pin the extension, then click its icon to open the panel

## Use

1. Open your F&O environment and your Dataverse environment in tabs, signed in.
   (`https://contoso-uat.sandbox.operations.eu.dynamics.com` and
   `https://contoso.crm4.dynamics.com`.)
2. Click the extension icon. The panel auto-detects both tabs.
3. **Pull F&O enums** — one of:
   - a single enum name (`CredManCreditLimitAdjStatus`)
   - **search enum names** — type any fragment (`status`, `creditlimit`) and click a result
   - an entity name (`RM_CredManCreditLimitAdjTableEntity`) → every enum-typed property on it
   - a full environment dump (set a limit first for a smoke test)

   > **The name in the F&O UI is not the enum name.** *Form information* shows the
   > **data field** (e.g. `Status` on `CredManCreditLimitAdjTable`). The enum *type* behind
   > that field has a different name (`CredManCreditLimitAdjStatus` or similar). If you enter
   > a field name, the tool detects that it is not an enum type, searches the full enum list
   > and offers ranked matches to click — so you never have to guess.
4. **Pull Dataverse choices** — a table logical name (+ optional column), or every global
   option set.
5. **Compare** — pick the F&O enum and the Dataverse column, hit Compare.
6. Copy the ValueMap JSON, or download the CSVs.

## Authentication

There is none to configure. The content script runs *inside* your already-authenticated
environment tab, so every request is same-origin and rides your existing session cookie.
No app registration, no client secret, no consent grant, nothing stored.

This was a deliberate choice over client credentials: an unpacked extension cannot hold a
secret safely — anything bundled is readable by anyone who opens the folder. It also
sidesteps a real technical problem: fetching from the extension's service worker is a
third-party context, so `SameSite=Lax` session cookies would not be sent at all.

If you later want this headless (CI, scheduled dumps), the seam to replace is `safeGet()`
in `content.js` — swap the cookie fetch for a bearer token and the rest of the pipeline is
unchanged.

## Read-only guarantees

- Exactly one `fetch()` call exists in the whole codebase (`content.js`, `safeGet`).
- It hardcodes `method: 'GET'`.
- Every URL is checked against `READ_ALLOWLIST` before the request is made. Anything
  cross-origin, or any path outside the six metadata routes below, throws.
- The manifest requests only `storage`, `unlimitedStorage` and `tabs`. No `webRequest`,
  no `scripting`, no `downloads`.

Allow-listed routes:

```
/metadata/PublicEnumerations
/metadata/PublicEnumerations('<EnumName>')
/metadata/PublicEntities('<EntityName>')
/metadata/DataEntities
/metadata/Labels(Id='<@SYS12345>',Language='en-us')
/api/data/v9.x/EntityDefinitions...
/api/data/v9.x/GlobalOptionSetDefinitions...
```

Verify it yourself: `grep -rn "fetch(" .` returns one hit.

## Performance

- **Label cache** — resolved `LabelId → text` pairs persist in `chrome.storage.local`
  under `dwem:labelcache:en-us`, keyed by label ID, and survive browser restarts. The
  same `@SYS` IDs repeat constantly across enums, so a second full dump is dramatically
  faster than the first. *Clear label cache* in section 5 resets it.
- **Throttling** — `429`/`502`/`503` responses honour `Retry-After`, otherwise
  exponential backoff with jitter, up to 5 retries. The backoff gate is global, so when
  the environment starts throttling, every in-flight request backs off together.
- **Concurrency** — capped at 4 parallel requests.
- **Paging** — `@odata.nextLink` is followed to exhaustion on both APIs.

## Error handling

Failures are reported per-item, not as a stack trace, and one failure never aborts a dump:

- an enum name that does not resolve → row in the results marked `failed`, with a note
  that the metadata service is case-sensitive on the AOT name
- a `LabelId` that will not resolve → label shows as `(unresolved)`, dump continues
- a column that is not a choice column → error listing the choice columns that *do* exist
  on that table
- an expired session → "reload the environment tab and sign in again" rather than a JSON
  parse error

## Outputs

| Export | Contents |
|---|---|
| Enum CSV | Every enum / element name / label / integer value, plus a `NameDivergesFromLabel` column |
| Comparison CSV | Matched pairs, F&O-only, Dataverse-only, divergence flags — the client/developer handoff document |
| JSON snapshot | Raw pulled data, for diffing between runs |
| ValueMap JSON | Copy-to-clipboard, in the exact transform shape |

ValueMap output is configurable on two axes:

- **Casing** — lowercase (the form that resolves in your environment) or exact AOT casing
- **Direction** — F&O name → Dataverse value, or Dataverse value → F&O name

```json
[
    {
        "transformType": "ValueMap",
        "valueMap": {
            "draft": "750880000",
            "submitted": "750880001"
        }
    }
]
```

## Matching rules

Labels are compared after normalisation: Unicode NFD, diacritics stripped, lowercased,
everything that is not `[a-z0-9]` removed. So `Not submitted`, `Not Submitted` and
`not-submitted` all collapse to `notsubmitted`.

Where two Dataverse options normalise to the same text, the first wins and the pair is
flagged as ambiguous — check those by hand.

Matching runs in four passes. Each one only sees what the passes before it could not
place, and each Dataverse option is claimed at most once — so the stronger evidence
always wins the option:

1. **Label → label.** F&O element label against Dataverse option label.
2. **Element name → label.** Elements F&O gave no usable label for (`@SYS` id that did
   not resolve, missing label file, a translation the metadata call did not return) are
   retried with the AOT element name compared against the Dataverse option label, under
   the same normalisation. That is how `SASOASTM` finds `SASO-ASTM`, `RoyalCommission`
   finds `Royal Commission` and `NotSet` finds `Not Set`.
3. **Near match, shared words dropped.** The words the enum name and the Dataverse column
   name repeat are removed from the front and back of both sides before comparing —
   for enum `QM_StandardType` on column `arq_standardtype` that is *standard* and *type*
   (plurals folded), so element `NationalStandards` reduces to `national` and meets
   option `National`, and `SRMCCStandards` meets `SRMCC`. Stripping never empties a name.
4. **Near match, containment.** One reduced key contains the other, the lengths are
   within 70% of each other, and exactly one Dataverse option qualifies.

Passes 3 and 4 are guesses and are labelled as such: they only fire when a single
Dataverse option is left that fits, they are counted separately, they get their own
review callout listing what was compared, they are tagged `NEAR MATCH` in the *Matched
on* column, and they carry `MatchedBy = near match` plus a
`MATCHED - NEAR MATCH (REVIEW)` status in the comparison CSV. Read them before you paste
the JSON. Pass 2 pairs are tagged `ELEMENT NAME` the same way.

Both fallbacks have a tick box in section 3 (**Fallback matching**), so you can drop back
to label-only behaviour at any time.

The generated ValueMap is unaffected by which pass produced the pair: the key is the AOT
element name either way, which is what dual write reads.

## Tests

```
node fixtures/test.mjs
```

Covers normalisation, matching, divergence detection, both ValueMap directions, both
casings, the exact 4-space JSON shape, CSV quoting/escaping, and the error row path.
The fixture reproduces your real case: label `Not submitted` → name `Draft`, label
`Rejected` → name `Denied`. A second fixture covers the fully unlabelled enum
(`NotSet`/`ASTM`/`SASOASTM`… against `Not Set`/`ASTM`/`SASO-ASTM`…): all nine elements
match by name, the fallback can be switched off, and a label match wins a contested
option. A third covers the shared-word case (`QM_StandardType`:
`InternationalStandards`/`NationalStandards`/`SRMCCStandards` against
`International`/`National`/`SRMCC`) and checks the things that would make the near-match
pass dangerous: `National` is not swallowed by `International`, an unrelated element
(`Zebra`) is still left unmatched rather than forced into the last free option, and an
exact name match beats a near match for the same option.

## Layout

```
manifest.json      MV3 manifest
background.js      opens the panel; no network access
content.js         all fetching, read-only guard, throttle/retry, label cache
lib/core.js        pure logic: normalise, match, ValueMap, CSV (Node-testable)
panel/             the UI
fixtures/          sample data + assertions
```

---

# Entity fields (added in 2.0)

The second tab answers a different question: *a new F&O entity is coming into
dual-write scope — which CE columns do I need to create, and of what type?*

## Use

1. **Entity fields** tab → type an entity name (data entity or public entity name;
   it resolves either) → **Pull fields**. *Load entity list* turns the box into an
   autocomplete.
2. Optionally tick **Enrich with $metadata** for string length and decimal precision.
   Read the caveat below first.
3. Enter a Dataverse table logical name → **Compare**. The columns you still need to
   create come first, because that is the output you are actually there for.
4. Download the **checklist** — one row per column to create, with a suggested
   `arq_` logical name, display name, type, length and behaviour.

## Which name to type, and what "not found" means

Data management shows the **target entity** name — `ProjInvoiceProposalV2Entity`. The
Metadata REST API indexes `/metadata/PublicEntities` by the **public entity** name,
which is usually that minus the word `Entity`. The tool resolves between them for you,
in this order:

1. the name as typed, against `PublicEntities`;
2. the name minus a trailing `Entity`, against `PublicEntities`;
3. `/metadata/DataEntities` filtered on `Name`, `PublicEntityName` or
   `PublicCollectionName` (server-side `$filter` first, full scan as a fallback), then
   whatever public name that row points at;
4. the cached public entity list, ignoring case and punctuation.

If all four fail, the tool now says **why**, because the three reasons need different
actions and used to look identical:

| What you see | What it means |
| --- | --- |
| *exists as a data entity, but is not exposed as a public entity* | The entity is real; it has no public surface, so the API publishes no fields or keys for it. Fields and keys can only be read in F&O (Data management → **Entity structure** / **Target fields**, or the AOT). Dual write needs a public entity, so this is one for the F&O partner. |
| *public name X, but PublicEntities returned nothing* | OData is switched off for it (`DataServiceEnabled = No`). Usable in Data management, not through this API. |
| *not found as a public entity or a data entity* | Wrong name or wrong environment — close matches are offered as chips. |
| *Could not read metadata … HTTP 401/403/500* | Transport or permission, not a missing entity. Reload the F&O tab and retry. |

Whatever the outcome, the panel lists the names it tried and, when F&O knows the entity
at all, prints its data entity name, public entity name, public collection name, entity
category and the `DataServiceEnabled` / `DataManagementEnabled` / read-only flags.

## Length, precision and scale: read this

**The Metadata REST API does not publish them.** A `PublicEntities` property carries
`Name`, `TypeName`, `DataType`, `LabelId`, `IsKey`, `IsMandatory`, `ConfigurationEnabled`,
`AllowEdit`, `AllowEditOnCreate` and the dimension fields. That is the whole list.

`/data/$metadata` *may* carry them as EDM facets, depending on the build. Some F&O
environments emit `MaxLength` and `Precision` on properties; many do not, and the
documented fallback for field lengths is reading `SQLDictionary` from the database,
which a browser extension cannot reach.

So the tool looks, and then tells you what it found. **Check what this environment
publishes** (next to the checkbox) samples the document and reports the answer in one
click. Where a facet is absent, the field list says `not published` and the notes tell
you to confirm with the F&O developer. It never invents a number.

Note also that there is **no property-level `IsReadOnly`** in this API. `IsReadOnly`
exists only at entity level. Per field you get `AllowEdit` and `AllowEditOnCreate`,
which the tool renders as `read-only` and `create-only` pills — a `create-only` field
accepts a value on insert and rejects it on update, which is worth knowing before you
map it bidirectionally.

## Type mapping

| F&O type | Recommended Dataverse type | Note |
|---|---|---|
| String | Single Line of Text | Multiple Lines of Text above 4000 |
| Int32 | Whole Number | |
| Int64 | Whole Number | **flagged** — Dataverse Whole Number is 32-bit |
| Decimal | Decimal Number | precision carried across when published |
| Real | **Decimal Number** | *not* Floating Point — see below |
| Enum | Choice | ValueMap transform required |
| Enum `NoYes` | Yes/No | **flagged** — may need Choice + ValueMap instead |
| Boolean | Yes/No | |
| Date | Date Only | Behavior: Time Zone Independent |
| DateTime / UtcDateTime | Date and Time | Behavior: Time Zone Independent |
| Guid | Single Line of Text (36) | no creatable GUID type in Dataverse |
| Container / blob | *not mappable* | excluded from the comparison entirely |

Four of these deliberately differ from the obvious mapping:

- **Real → Decimal, not Floating Point.** X++ `Real` is fixed-point. Floating Point
  introduces rounding drift on amounts and quantities that then fail to reconcile
  against F&O.
- **Int64 is flagged.** Dataverse Whole Number tops out at 2,147,483,647. An Int64
  field that exceeds it fails on the first row that does, not at map-save time.
- **NoYes is flagged.** When `NoYes` surfaces as an enum-typed property rather than a
  boolean, F&O can send the string `"yes"` against a CE Yes/No column and throw
  DIPV1030. The tool tells you which shape it actually is.
- **DateTime carries a Behavior recommendation.** Behavior is immutable once a
  Dataverse column exists, and dual-write generally wants Time Zone Independent.
  Getting it wrong means dropping and recreating the column.

## Comparison buckets

1. **Missing in CE** — the columns to create. First, always.
2. **Type mismatch** — exists, wrong type, with both actual and recommended shown.
3. **Size / behaviour mismatch** — right type, different length, precision or DateTime Behavior.
4. **Matched** — fine.
5. **CE only** — columns with no F&O counterpart.

Custom columns and the primary key are compared by default; tick *Include system
columns* to widen it. Names are matched with the publisher prefix stripped, so
`CUSTOMERACCOUNT` matches `arq_customeraccount`.

## Read-only, still

The new feature adds exactly one route to the allowlist: `/data/$metadata`, GET.
There is still exactly one `fetch()` in the codebase and it still hardcodes
`method: 'GET'`. `/data/SalesTable` and every other data path remain refused, and
the tool never attempts to create a CE column — it tells you what to create.

## Tests

```
node fixtures/test.mjs          # enum matching, ValueMap shape, CSV
node fixtures/fields.test.mjs   # type recommendations, comparison buckets, exports
node fixtures/edm.test.mjs      # $metadata parsing, run against the shipped source
node fixtures/panel.smoke.mjs   # full UI drive-through in jsdom (needs: npm i jsdom)
```


---

# Entity names tab (v2.1)

An F&O data entity has three names, and each tool shows a different one:

| Name | Where you see it | Example |
|---|---|---|
| AOT name | Data management → *Target entity* | `RMTaxRegistrationOnCustomerEntity` |
| Public entity name | OData type, Metadata REST API, the Entity fields tab | `RMCustomerRegisteration` |
| Public collection name | **Power Automate Fin & Ops connector** entity list, `/data/<name>` URLs | `RMCustomerRegisterations` |

The developer sets the public names freely, so they can look nothing like the AOT name (and may be misspelled, as above).
Searching the connector dropdown for the Data management name then finds nothing, and a custom value built from it fails with
`GetTable ... NotFound`.

## Use

1. Pick the F&O tab in *Environments*.
2. Open **Entity names**, paste one or more names (any of the three, one per line, commas also work), click **Look up**.
3. Each result shows the Power Automate name large with a **Copy** button, all three names, the label, and the OData flags.
   **Open in Entity fields** loads the entity's field list.
4. **Download names CSV** exports the table.

## How it matches

1. Server-side `$filter` on `/metadata/DataEntities` for `Name`, `Name + "Entity"`, `PublicEntityName` or `PublicCollectionName` (exact, case-sensitive).
2. If that misses: the full DataEntities list (cached per environment; tick *reload the entity list* after a deployment),
   exact match ignoring case, also accepting the AOT name without its `Entity` suffix.
3. If that misses: fuzzy ranking over all three names. It tolerates typos inside words (`Registration` / `Registeration`),
   plural collection names, and word order. A clear winner at similarity ≥ 0.9 is shown as a **closest match (confirm)**;
   otherwise the closest names are listed with a **Use** button.

## Live /data check (optional, on by default)

One `GET /data/<collection>?$top=1&cross-company=true` per result — the same endpoint the connector calls. It reports whether
the collection answers and how many fields a row has. It never displays record values. The read-only allowlist accepts
exactly that URL shape and nothing else under `/data/` except `$metadata`, and the collection name always comes from
DataEntities, never from what you typed.

A 404 there means OData is not serving the entity (DataServiceEnabled off, or the entity is not built/synced in that
environment). If the check passes but the connector dropdown still does not list it, re-select the *Instance* in the action
to refresh the connector's cached entity list, or type the collection name as a custom value.

## Tests

`node fixtures/names.test.mjs` covers the matcher and runs the content-script job against a fake F&O server
(filter miss → case-insensitive hit, misspelling → fuzzy, non-public entity, live check URL shape).

## License

[MIT](LICENSE) © 2026 Mostafa Ali
