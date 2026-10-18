# Dual-write Enum Mapper

A read-only Chrome extension that pulls F&O AOT enum element names, labels and integer
values, along with Dataverse choice options. It matches the two by label text and
generates dual-write `ValueMap` JSON you can paste straight into a map.

Dual-write `ValueMap` transforms match on the F&O element name, and the F&O UI never
shows you that name. `Not submitted` is really `Draft`, `Rejected` is really `Denied`,
and you only find out when a sync run fails.

## Install

1. Download the zip from the [latest release](https://github.com/MostafaAli993/Dual-Write-Mapper-Ext/releases/latest)
   and unzip it somewhere permanent. Chrome loads the extension from that folder.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder that directly contains `manifest.json`.
4. Pin the extension, then click its icon to open the panel.

> If Chrome says "Manifest file is missing or unreadable", check which folder you picked.
> Windows' *Extract All* often creates a folder inside a folder
> (`Dual-Write-Mapper-Ext-main\Dual-Write-Mapper-Ext-main\`). Select the inner one, where
> you can see `manifest.json`.

## Use

1. Open your F&O environment and your Dataverse environment in separate tabs and sign in
   to both, for example `https://contoso-uat.sandbox.operations.eu.dynamics.com` and
   `https://contoso.crm4.dynamics.com`.
2. Click the extension icon. The panel finds both tabs on its own.
3. Click **Pull F&O enums** with one of these:
   - a single enum name (`CredManCreditLimitAdjStatus`)
   - part of a name, using **search enum names**: type any fragment (`status`,
     `creditlimit`) and click a result
   - an entity name (`CredManCreditLimitAdjTableEntity`), which pulls every enum-typed
     property on it
   - a full environment dump (set a limit first if you only want a smoke test)

   > The name you see in the F&O UI is the data field, and the enum type behind it has a
   > different name. *Form information* shows the field (for example `Status` on
   > `CredManCreditLimitAdjTable`), while the enum type is `CredManCreditLimitAdjStatus`
   > or similar. If you enter a field name, the tool notices it isn't an enum type,
   > searches the full enum list and offers ranked matches to click, so you don't have
   > to guess.
4. Click **Pull Dataverse choices** with a table logical name (and optionally a column),
   or pull every global option set.
5. Pick the F&O enum and the Dataverse column, then click **Compare**.
6. Copy the ValueMap JSON or download the CSVs.

## Authentication

There's nothing to configure. The content script runs inside the environment tab you're
already signed in to, so every request is same-origin and uses your existing session
cookie. There's no app registration, client secret or consent grant, and nothing is
stored.

Client credentials were ruled out on purpose. An unpacked extension can't hold a secret
safely, because anyone who opens the folder can read whatever is bundled with it. Using
the tab's own session also avoids a technical problem: a fetch from the extension's
service worker runs in a third-party context, so the browser would never send the
`SameSite=Lax` session cookies.

If you later want to run this headless (CI, scheduled dumps), replace `safeGet()` in
`content.js`. Swap the cookie fetch for a bearer token and the rest of the pipeline stays
the same.

## Read-only guarantees

- The codebase has exactly one `fetch()` call (`content.js`, `safeGet`).
- It hardcodes `method: 'GET'`.
- Every URL is checked against `READ_ALLOWLIST` before the request goes out. A
  cross-origin URL, or any path outside the metadata routes below, throws.
- The manifest asks only for `storage`, `unlimitedStorage` and `tabs`. It doesn't ask
  for `webRequest`, `scripting` or `downloads`.

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

To check this yourself, run `grep -rn "fetch(" .`. It returns one hit.

## Performance

- Resolved `LabelId → text` pairs are cached in `chrome.storage.local` under
  `dwem:labelcache:en-us`, keyed by label ID, and survive browser restarts. The same
  `@SYS` IDs show up again and again across enums, so a second full dump is much faster
  than the first. **Clear label cache** in section 5 resets it.
- On a `429`, `502` or `503` response the tool honours `Retry-After`. Without one, it
  uses exponential backoff with jitter, up to 5 retries. The backoff gate is global, so
  once the environment starts throttling, every in-flight request backs off together.
- At most 4 requests run in parallel.
- `@odata.nextLink` is followed to the last page on both APIs.

## Error handling

Failures are reported per item, and one failure never stops a dump:

- An enum name that doesn't resolve shows up as a `failed` row in the results, with a
  note that the metadata service is case-sensitive on the AOT name.
- A `LabelId` that won't resolve shows as `(unresolved)`, and the dump carries on.
- A column that isn't a choice column produces an error listing the choice columns that
  do exist on that table.
- An expired session tells you to reload the environment tab and sign in again, instead
  of showing a JSON parse error.

## Outputs

| Export | Contents |
|---|---|
| Enum CSV | Every enum, element name, label and integer value, plus a `NameDivergesFromLabel` column |
| Comparison CSV | Matched pairs, F&O-only, Dataverse-only and divergence flags. This is the file you hand between client and developer. |
| JSON snapshot | The raw pulled data, for diffing between runs |
| ValueMap JSON | Copied to the clipboard in the exact transform shape |

You can set the ValueMap output two ways:

- Casing: lowercase (the form that resolves in your environment) or exact AOT casing.
- Direction: F&O name to Dataverse value, or Dataverse value to F&O name.

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

Labels are normalised before they're compared: Unicode NFD, diacritics stripped,
lowercased, and anything outside `[a-z0-9]` removed. `Not submitted`, `Not Submitted`
and `not-submitted` all become `notsubmitted`.

If two Dataverse options normalise to the same text, the first one wins and the pair is
flagged as ambiguous. Check those by hand.

Matching runs in four passes. Each pass only sees what the earlier ones couldn't place,
and each Dataverse option can be claimed once, so the strongest evidence always gets the
option first.

1. Label to label. The F&O element label is compared with the Dataverse option label.
2. Element name to label. Some elements have no usable F&O label: an `@SYS` id that
   didn't resolve, a missing label file, or a translation the metadata call didn't
   return. Those are retried using the AOT element name against the Dataverse option
   label, with the same normalisation. That's how `SASOASTM` finds `SASO-ASTM`,
   `RoyalCommission` finds `Royal Commission` and `NotSet` finds `Not Set`.
3. Near match, shared words dropped. Words that the enum name and the Dataverse column
   name have in common are removed from the start and end of both sides before
   comparing. For enum `QM_StandardType` on column `arq_standardtype` those words are
   *standard* and *type* (plurals folded), so element `NationalStandards` reduces to
   `national` and matches option `National`, and `SRMCCStandards` matches `SRMCC`.
   Stripping never leaves a name empty.
4. Near match by containment. One reduced key contains the other, their lengths are
   within 70% of each other, and exactly one Dataverse option qualifies.

Passes 3 and 4 are guesses, and the tool labels them that way. They only fire when a
single Dataverse option is left that fits. They're counted separately and get their own
review callout listing what was compared. In the *Matched on* column they're tagged
`NEAR MATCH`, and in the comparison CSV they carry `MatchedBy = near match` and the
status `MATCHED - NEAR MATCH (REVIEW)`. Read them before you paste the JSON. Pass 2 pairs
are tagged `ELEMENT NAME` in the same way.

Both fallbacks have a checkbox in section 3 (**Fallback matching**), so you can switch
back to label-only matching whenever you like.

The pass that produced a pair has no effect on the generated ValueMap. The key is always
the AOT element name, because that's what dual-write reads.

## Tests

```
node fixtures/test.mjs
```

The tests cover normalisation, matching, divergence detection, both ValueMap directions,
both casings, the exact 4-space JSON shape, CSV quoting and escaping, and the error row
path. There are three fixtures:

- The first reproduces the case at the top of this README: label `Not submitted` with
  name `Draft`, and label `Rejected` with name `Denied`.
- The second is a fully unlabelled enum (`NotSet`/`ASTM`/`SASOASTM`… against
  `Not Set`/`ASTM`/`SASO-ASTM`…). All nine elements match by name, the fallback can be
  turned off, and a label match wins a contested option.
- The third covers shared words (`QM_StandardType`:
  `InternationalStandards`/`NationalStandards`/`SRMCCStandards` against
  `International`/`National`/`SRMCC`). It checks the cases that would make the
  near-match pass dangerous. `National` isn't swallowed by `International`, an unrelated
  element (`Zebra`) stays unmatched instead of being forced into the last free option,
  and an exact name match beats a near match for the same option.

## Layout

```
manifest.json      MV3 manifest
background.js      opens the panel; no network access
content.js         all fetching, read-only guard, throttle/retry, label cache
lib/core.js        pure logic: normalise, match, ValueMap, CSV (Node-testable)
panel/             the UI
fixtures/          sample data + assertions
```

# Entity fields (added in 2.0)

The second tab is for when a new F&O entity comes into dual-write scope and you need to
know which CE columns to create, and what type each one should be.

## Use

1. On the **Entity fields** tab, type an entity name (a data entity or public entity
   name; either one resolves) and click **Pull fields**. **Load entity list** turns the
   box into an autocomplete.
2. If you want string length and decimal precision, tick **Enrich with $metadata**. Read
   the caveat below first.
3. Enter a Dataverse table logical name and click **Compare**. The columns you still need
   to create are listed first, since that's the list you came for.
4. Download the checklist. It has one row per column to create, with a suggested `arq_`
   logical name, display name, type, length and behaviour.

## Which name to type, and what "not found" means

Data management shows the target entity name, such as `ProjInvoiceProposalV2Entity`.
The Metadata REST API indexes `/metadata/PublicEntities` by the public entity name,
which is usually the same name without the word `Entity`. The tool resolves between them
in this order:

1. the name as typed, against `PublicEntities`;
2. the name without a trailing `Entity`, against `PublicEntities`;
3. `/metadata/DataEntities` filtered on `Name`, `PublicEntityName` or
   `PublicCollectionName` (a server-side `$filter` first, then a full scan if that
   fails), followed by whatever public name that row points to;
4. the cached public entity list, ignoring case and punctuation.

If all four fail, the tool tells you why. There are three possible reasons, each one
needs a different fix, and they used to look identical:

| What you see | What it means |
| --- | --- |
| *exists as a data entity, but is not exposed as a public entity* | The entity exists but has no public surface, so the API publishes no fields or keys for it. You can only read its fields and keys inside F&O (Data management → **Entity structure** / **Target fields**, or the AOT). Dual-write needs a public entity, so raise this with the F&O partner. |
| *public name X, but PublicEntities returned nothing* | OData is turned off for it (`DataServiceEnabled = No`). You can use it in Data management, but not through this API. |
| *not found as a public entity or a data entity* | Wrong name or wrong environment. Close matches appear as chips. |
| *Could not read metadata … HTTP 401/403/500* | A transport or permission error. The entity itself isn't the problem. Reload the F&O tab and retry. |

Whatever the outcome, the panel lists the names it tried. If F&O knows the entity at
all, it also prints the data entity name, public entity name, public collection name,
entity category, and the `DataServiceEnabled` / `DataManagementEnabled` / read-only
flags.

## Caveat: length, precision and scale

The Metadata REST API doesn't publish them. A `PublicEntities` property carries `Name`,
`TypeName`, `DataType`, `LabelId`, `IsKey`, `IsMandatory`, `ConfigurationEnabled`,
`AllowEdit`, `AllowEditOnCreate` and the dimension fields, and nothing else.

`/data/$metadata` might carry them as EDM facets, depending on the build. Some F&O
environments emit `MaxLength` and `Precision` on properties, and many don't. The
documented fallback for field lengths is reading `SQLDictionary` from the database,
which a browser extension can't reach.

So the tool checks and reports what it found. **Check what this environment publishes**,
next to the checkbox, samples the document and gives you the answer in one click. Where
a facet is missing, the field list says `not published` and the notes tell you to
confirm with the F&O developer. The tool never makes up a number.

This API also has no property-level `IsReadOnly`; `IsReadOnly` exists only at entity
level. Per field you get `AllowEdit` and `AllowEditOnCreate`, which the tool shows as
`read-only` and `create-only` pills. A `create-only` field accepts a value on insert and
rejects it on update, which matters if you plan to map it in both directions.

## Type mapping

| F&O type | Recommended Dataverse type | Note |
|---|---|---|
| String | Single Line of Text | Multiple Lines of Text above 4000 |
| Int32 | Whole Number | |
| Int64 | Whole Number | Flagged: Dataverse Whole Number is 32-bit |
| Decimal | Decimal Number | Precision carried across when published |
| Real | Decimal Number | Not Floating Point (see below) |
| Enum | Choice | ValueMap transform required |
| Enum `NoYes` | Yes/No | Flagged: may need Choice + ValueMap instead |
| Boolean | Yes/No | |
| Date | Date Only | Behavior: Time Zone Independent |
| DateTime / UtcDateTime | Date and Time | Behavior: Time Zone Independent |
| Guid | Single Line of Text (36) | Dataverse has no GUID type you can create |
| Container / blob | Not mappable | Left out of the comparison entirely |

Four of these differ from the obvious mapping on purpose:

- Real maps to Decimal, not Floating Point. X++ `Real` is fixed-point. Floating Point
  adds rounding drift to amounts and quantities, which then won't reconcile against F&O.
- Int64 is flagged. Dataverse Whole Number tops out at 2,147,483,647. An Int64 field
  fails on the first row whose value goes over that, and saving the map won't warn you.
- NoYes is flagged. When `NoYes` comes through as an enum-typed property instead of a
  boolean, F&O can send the string `"yes"` to a CE Yes/No column and throw DIPV1030. The
  tool tells you which shape you actually have.
- DateTime comes with a Behavior recommendation. You can't change Behavior once a
  Dataverse column exists, and dual-write generally wants Time Zone Independent. If you
  get it wrong, you have to drop the column and create it again.

## Comparison buckets

1. Missing in CE: the columns to create. This bucket always comes first.
2. Type mismatch: the column exists with the wrong type. Both the actual and the
   recommended type are shown.
3. Size / behaviour mismatch: right type, but a different length, precision or DateTime
   Behavior.
4. Matched: nothing to do.
5. CE only: columns with no F&O counterpart.

By default the comparison covers custom columns and the primary key. Tick *Include
system columns* to widen it. Names are matched with the publisher prefix stripped, so
`CUSTOMERACCOUNT` matches `arq_customeraccount`.

## Still read-only

This feature adds one route to the allowlist: `/data/$metadata`, GET only. There's still
exactly one `fetch()` in the codebase, and it still hardcodes `method: 'GET'`.
`/data/SalesTable` and every other data path are still refused. The tool never tries to
create a CE column; it tells you what to create.

## Tests

```
node fixtures/test.mjs          # enum matching, ValueMap shape, CSV
node fixtures/fields.test.mjs   # type recommendations, comparison buckets, exports
node fixtures/edm.test.mjs      # $metadata parsing, run against the shipped source
node fixtures/panel.smoke.mjs   # full UI drive-through in jsdom (run `npm install` first)
```

# Entity names tab (v2.1)

An F&O data entity has three names, and different tools show different ones:

| Name | Where you see it | Example |
|---|---|---|
| AOT name | Data management → *Target entity* | `RMTaxRegistrationOnCustomerEntity` |
| Public entity name | OData type, Metadata REST API, the Entity fields tab | `RMCustomerRegisteration` |
| Public collection name | Power Automate Fin & Ops connector entity list, `/data/<name>` URLs | `RMCustomerRegisterations` |

The developer picks the public names freely, so they can look nothing like the AOT name,
and they may be misspelled, as in the example above. If you search the connector
dropdown for the Data management name you'll find nothing, and a custom value built from
that name fails with `GetTable ... NotFound`.

## Use

1. Pick the F&O tab under *Environments*.
2. Open **Entity names**, paste one or more names (any of the three kinds, one per line
   or separated by commas) and click **Look up**.
3. Each result shows the Power Automate name in large type with a **Copy** button, plus
   all three names, the label and the OData flags. **Open in Entity fields** loads the
   entity's field list.
4. **Download names CSV** exports the table.

## How it matches

1. A server-side `$filter` on `/metadata/DataEntities` for `Name`, `Name + "Entity"`,
   `PublicEntityName` or `PublicCollectionName` (exact and case-sensitive).
2. If that misses, the full DataEntities list, cached per environment (tick *reload the
   entity list* after a deployment). This match ignores case and also accepts the AOT
   name without its `Entity` suffix.
3. If that misses too, a fuzzy ranking over all three names. It tolerates typos inside
   words (`Registration` / `Registeration`), plural collection names and word order. A
   clear winner at similarity ≥ 0.9 is shown as a **closest match (confirm)**. Otherwise
   the closest names are listed, each with a **Use** button.

## Live /data check (optional, on by default)

For each result the tool sends one `GET /data/<collection>?$top=1&cross-company=true`,
the same endpoint the connector calls. It reports whether the collection answers and how
many fields a row has, and it never shows record values. Under `/data/`, the read-only
allowlist accepts that exact URL shape and `$metadata`, and nothing else. The collection
name always comes from DataEntities, never from what you typed.

A 404 from this check means OData isn't serving the entity: either DataServiceEnabled is
off, or the entity isn't built or synced in that environment. If the check passes but
the connector dropdown still doesn't list the entity, re-select the *Instance* in the
action to refresh the connector's cached entity list, or type the collection name as a
custom value.

## License

[MIT](LICENSE) © 2026 Mostafa Ali
