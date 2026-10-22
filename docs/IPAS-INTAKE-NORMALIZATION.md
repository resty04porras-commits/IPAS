# Smart Capture intake normalization: editable source guide

## Ano ang inilipat

Nasa `services/intakeNormalization.ts` na ang sampung kasalukuyang function at
dalawang regex constant para sa paglilinis ng Smart Capture records, asset tags,
serial values at barcode lookup keys. Pareho ang laman ng mga inilipat na
function; exports at imports lang ang nadagdag.

Mula 4,164 ay naging 4,003 lines ang `server.ts`. Patuloy nitong pinapatakbo ang
OCR/AI extraction, cache lookup, merging, comparison at export orchestration.
Walang bagong package o installer.

## Saan mag-e-edit araw-araw

Sa VS Code, pindutin ang Ctrl+P at buksan ang `services/intakeNormalization.ts`.

| Gusto mong baguhin | Function o constant |
| --- | --- |
| Mga placeholder na magiging blank, halimbawa `N/A`, `NONE`, `BLANK 12` | `PLACEHOLDER_INTAKE_VALUE_PATTERN`, `sanitizeIntakeTextValue` |
| Format ng asset tag at paghahanap nito sa text | `ASSET_TAG_PATTERN`, `normalizeAssetTagCandidate` |
| Pagkilala kung puwedeng serial ang isang value | `isLikelySerialCandidate`, `looksLikeQrOrBarcodeValue` |
| Paglilinis ng hardware ID o serial field | `sanitizeIntakeIdentifierValue` |
| Default values, serial aliases, at pagbuo ng malinis na record | `normalizeIntakeRecord` |
| Barcode lookup key at listahan ng candidate values | `normalizeBarcodeLookupValue`, `barcodeLookupCandidates` |
| Blank record kapag kailangan ang manual entry | `buildManualIntakeFallback` |

Ginagamit ang mga helper na ito ng maraming Smart Capture/barcode/comparison
at export path. Kapag binago ang kanilang mga tuntunin, kailangan ding subukan
ang mga apektadong feature. Ang `dist-server/server.cjs` ay build output;
ang editable `.ts` source ang dapat baguhin.

## Parehong behavior na pinanatili

- Hiwalay ang company asset tag sa manufacturer serial number.
- Nananatili ang leading zeros at pagkakaiba ng `O/0` at `I/1`; walang automatic
  paghula o pagpapalit ng mga character.
- Ang serial aliases ay `serial`, `serialNumber`, `Serial`, `Serial Number`,
  sa ganoong priority. Ang empty string na pangunahing `serial` ay pinananatili.
- Ang mga placeholder ay nililinis sa equipment fields. Hindi sila awtomatikong
  inaalis sa filename o notes.
- Nananatili ang kasalukuyang asset-tag year/prefix rules, legacy hardware-ID
  fallback, serial rejection patterns, at barcode-length rules. Hindi ito
  pagbabago sa OCR accuracy o pag-aayos ng mga limitasyong iyon.
- Ang barcode candidate order ay hardware ID, serial, source name, remarks.
- Ang manual fallback ay blank equipment fields at `New Accountability`.

Hindi binabago ng extraction ang matching policy, API paths, database schema,
AI/OCR engine, camera sync, login background, export layout, port o HTTPS setup.

## Apat na file na ilalagay

| Download | Lokasyon sa server |
| --- | --- |
| `intakeNormalization.ts` | `/srv/IPAS-PUBLISH/services/intakeNormalization.ts` |
| `intakeNormalization.test.ts` | `/srv/IPAS-PUBLISH/tests/intakeNormalization.test.ts` |
| `server.ts` | `/srv/IPAS-PUBLISH/server.ts` |
| `IPAS-INTAKE-NORMALIZATION.md` | `/srv/IPAS-PUBLISH/docs/IPAS-INTAKE-NORMALIZATION.md` |

Ang replacement server ay nakabatay sa owner commit `a258aa9`. Bago ito palitan,
ang SHA256 ng kasalukuyang `server.ts` ay dapat:

```text
640e00d29d0042d43c896691a7126a4c6e6c3b08904b15059f0ada6ea3bd72ce
```

Kung iba ang hash, kailangang isama ang extraction sa mas bagong source.
I-backup muna ang source `server.ts` at compiled `dist-server/server.cjs`.

## Check, build at save

Mula sa `/srv/IPAS-PUBLISH`, pagkatapos makopya ang source at test:

```bash
node --import tsx --test tests/intakeNormalization.test.ts tests/comparison.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
systemctl --user restart ipas.service
curl -sS --max-time 20 -w '\nHTTP %{http_code}\n' http://127.0.0.1:3000/api/health
```

Subukan din ang `/api/barcode/lookup` gamit ang synthetic records. Dapat mahanap
ang exact serial, ma-normalize ang asset tag, at manatili ang leading zeros.
Lookup request lang ito; hindi ito pag-save ng bagong asset record.

Sa hiwalay na cloud environment: pumasa ang 23 bagong tests at 260 existing tests,
TypeScript check at server build. Ang bawat test file ay pinatakbo sa sariwang
Node process. Pareho ang lahat ng sampung inilipat na function at dalawang
constant; hindi nabago ang 145 retained named declarations. Pareho ang resulta
sa 5,568 original-versus-extracted function calls.

Aktuwal na compiled Linux API checks ang naghambing ng anim na barcode lookup
scenarios, lahat ng Excel ZIP member contents, PDF page content streams/sizes,
at empty-export HTTP 400. Synthetic records at isolated temporary working
directory ang ginamit; walang real image OCR, external AI, owner credentials,
owner database writes o Windows automation. Tingnan ang `VERIFICATION.json`
at mga report para sa saklaw ng checks.

Pagkatapos ma-verify sa owner VM, i-commit lamang ang apat na file sa table at
i-push ang `refactor/modular-server`. Panatilihing hiwalay ang staged
`phase2b.py` at untracked `ipas-ocr-label-check.mjs`.

Kung kailangan ng rollback, ibalik ang parehong source at compiled server
mula sa backup at i-restart ang user service. Ang bagong module file ay hindi
na gagamitin ng naibalik na source.
