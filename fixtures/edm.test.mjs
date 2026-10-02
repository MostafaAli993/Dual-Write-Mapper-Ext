// Tests the $metadata parsing helpers by extracting them from the real
// content.js source, so we are testing shipped code rather than a copy.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');

function grab(name) {
  const re = new RegExp(`function ${name}\\([\\s\\S]*?\\n  \\}`, 'm');
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${name} from content.js`);
  return m[0];
}

const harness = `
${grab('escapeRe')}
${grab('extractEntityTypeFragment')}
${grab('parseEdmProperties')}
return { escapeRe, extractEntityTypeFragment, parseEdmProperties };
`;
const { extractEntityTypeFragment, parseEdmProperties } = new Function(harness)();

// --- a build that DOES publish facets ---------------------------------------
const withFacets = `<?xml version="1.0"?>
<edmx:Edmx Version="4.0"><edmx:DataServices>
<Schema Namespace="Microsoft.Dynamics.DataEntities">
  <EntityType Name="RMSalesContract">
    <Key><PropertyRef Name="CashSalesId"/></Key>
    <Property Name="CashSalesId" Type="Edm.String" MaxLength="20" Nullable="false"/>
    <Property Name="SalesPrice" Type="Edm.Decimal" Precision="32" Scale="6"/>
    <Property Name="FixedQty" Type="Microsoft.Dynamics.DataEntities.NoYes"/>
    <Property Name="Notes" Type="Edm.String" MaxLength="8000"/>
  </EntityType>
  <EntityType Name="SomethingElse">
    <Property Name="CashSalesId" Type="Edm.String" MaxLength="999"/>
  </EntityType>
</Schema>
</edmx:DataServices></edmx:Edmx>`;

const frag = extractEntityTypeFragment(withFacets, 'RMSalesContract');
assert.ok(frag, 'must find the entity type');
assert.ok(!frag.includes('SomethingElse'), 'must not run past the closing tag into the next entity');

const props = parseEdmProperties(frag);
assert.equal(props.CashSalesId.maxLength, 20);
assert.equal(props.CashSalesId.edmType, 'Edm.String');
assert.equal(props.SalesPrice.precision, 32);
assert.equal(props.SalesPrice.scale, 6);
assert.equal(props.Notes.maxLength, 8000);
assert.equal(props.FixedQty.maxLength, null, 'absent facet must be null, never a guess');
assert.equal(Object.keys(props).length, 4);

// wrong name must not half-match
assert.equal(extractEntityTypeFragment(withFacets, 'RMSalesContractLine'), null);

// --- a build that does NOT publish facets ------------------------------------
const noFacets = `<Schema><EntityType Name="Plain">
  <Property Name="Code" Type="Edm.String"/>
  <Property Name="Amount" Type="Edm.Decimal"/>
</EntityType></Schema>`;
const p2 = parseEdmProperties(extractEntityTypeFragment(noFacets, 'Plain'));
assert.equal(p2.Code.maxLength, null);
assert.equal(p2.Amount.precision, null);
assert.equal(p2.Amount.scale, null);

// --- regex-special entity names ----------------------------------------------
const weird = `<EntityType Name="RM_Sales.Contract+V2"><Property Name="A" Type="Edm.String" MaxLength="5"/></EntityType>`;
assert.ok(extractEntityTypeFragment(weird, 'RM_Sales.Contract+V2'), 'special chars must be escaped, not treated as regex');

// self-closing vs paired Property tags
const paired = `<EntityType Name="X"><Property Name="A" Type="Edm.String" MaxLength="7"></Property></EntityType>`;
assert.equal(parseEdmProperties(extractEntityTypeFragment(paired, 'X')).A.maxLength, 7);

console.log('All $metadata parsing assertions passed.');
