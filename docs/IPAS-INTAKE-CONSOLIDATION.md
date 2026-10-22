# Smart Capture intake consolidation: editable source guide

## Ano ang inilipat

Nasa `services/intakeConsolidation.ts` na ang 14 kasalukuyang function para sa
pagpili ng field values, pag-assess ng completeness, pagbuo ng extraction notes,
pagsasama ng local OCR at AI records, at consolidation ng batch records.
Kasama ang kasalukuyang `KNOWN_BRANDS` list na ginagamit sa description selection.

Pareho ang katawan ng mga function at brand list; exports at imports lang ang
nadagdag. Mula 4,003 ay naging 3,694 lines ang `server.ts`. Patuloy nitong
pinapatakbo ang OCR/AI requests, cache, reference alignment, routes at export
orchestration. Walang bagong package o installer.

## Saan mag-e-edit araw-araw

Sa VS Code, Ctrl+P at buksan ang `services/intakeConsolidation.ts`.

| Gusto mong baguhin | Function o constant |
| --- | --- |
| Brand list at pagpili ng description | `KNOWN_BRANDS`, `chooseBestDescription` |
| Component, hardware ID at serial na pipiliin sa magkaibang records | `choosePreferredComponent`, `choosePreferredIdentifier`, `choosePreferredSerial` |
| Completeness at strong/usable extraction decisions | `countPopulatedIntakeFields`, `hasStrongIntakeExtraction`, `hasUsableIntakeExtraction` |
| Extraction notes at pagsasama ng notes | `buildOcrNotes`, `combineExtractionNotes` |
| Kung aling batch records ang pagsasamahin | `canConsolidateIntakeRecords`, `descriptionsRoughlyMatch`, `dedupeIntakeRecords` |
| Pagsasama ng fields ng dalawang capture | `mergeConsolidatedIntakeRecords` |
| Pagsasama ng local OCR at AI extraction | `mergeLocalAndAiIntakeRecord` |

Ang field cleaning at serial validation ay nasa naunang
`services/intakeNormalization.ts`. Ang paghahambing ng document versus evidence
ay nasa `services/comparison.ts`. Ang compiled `dist-server/server.cjs` ay build
output; ang editable `.ts` source ang dapat baguhin.

## Parehong behavior na pinanatili

- Hindi ito bagong deduplication policy. Nananatili ang kasalukuyang same-component
  identifier matches, partial-record description rules at component-only fallback.
- Maaaring magsama ang same-component records kapag pareho ang serial kahit
  magkaiba ang asset tag; maaari ring magsama ang partial records ayon sa dati
  nang description rule. Hindi ginagawang exact-only o mas strict ang extraction.
- Ang dalawang fully identified units na magkaiba ang identifiers ay nananatiling
  magkahiwalay kahit pareho ang model. Hindi rin nag-aapply ng bagong component
  aliases sa consolidation.
- Nananatili ang batch order, first source name, remarks priority at note order.
- Nananatili ang brand/length/validity preference rules; hindi hinuhulaan o
  kino-correct ang `O/0`, `I/1` o ibang identifier characters.
- Ang strong at usable thresholds ay pareho, kasama ang existing edge cases.
- Pareho ang extraction-note text, kasama ang existing `PaddleOCR` wording.
  Hindi iyon pagpapalit ng kasalukuyang EasyOCR engine.

Ginagamit din ang ilang helper ng reference matching, comparison extraction,
barcode notes at receipt notes. Kapag babaguhin ang mga tuntunin sa hinaharap,
subukan din ang mga apektadong feature.

Hindi binabago ang database schema, API paths, AI/OCR engine, camera sync,
login background, PDF/Excel layout, port o HTTPS setup.

## Apat na file na ilalagay

| Download | Lokasyon sa server |
| --- | --- |
| `intakeConsolidation.ts` | `/srv/IPAS-PUBLISH/services/intakeConsolidation.ts` |
| `intakeConsolidation.test.ts` | `/srv/IPAS-PUBLISH/tests/intakeConsolidation.test.ts` |
| `server.ts` | `/srv/IPAS-PUBLISH/server.ts` |
| `IPAS-INTAKE-CONSOLIDATION.md` | `/srv/IPAS-PUBLISH/docs/IPAS-INTAKE-CONSOLIDATION.md` |

Ang replacement server ay nakabatay sa owner commit `9686b57`. Bago ito palitan,
ang SHA256 ng kasalukuyang `server.ts` ay dapat:

```text
70ecce61fff18ea11059d88f9b6fbaee8258aff79038bd0ae2b52207106ec801
```

Kung iba ang hash, kailangang isama ang extraction sa mas bagong source.
I-backup muna ang source `server.ts` at compiled `dist-server/server.cjs`.

## Check, build at save

Mula sa `/srv/IPAS-PUBLISH`, pagkatapos makopya ang module, test at server:

```bash
node --import tsx --test tests/intakeConsolidation.test.ts tests/intakeNormalization.test.ts tests/comparison.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
systemctl --user restart ipas.service
curl -sS --max-time 20 -w '\nHTTP %{http_code}\n' http://127.0.0.1:3000/api/health
```

Subukan ang export gamit ang dalawang test captures ng parehong monitor at isang
fully identified different monitor. Dapat magsama ang unang dalawa, manatiling
hiwalay ang ibang unit, at tama pa rin ang asset tags at serials sa output.

Sa hiwalay na cloud environment, pumasa ang 28 bagong tests at 283 existing tests,
TypeScript check at server build. Bawat test file ay pinatakbo sa sariwang Node
process. Pareho ang 14 inilipat na function, brand list, at 130 retained named
declarations. Pareho ang resulta sa 5,904 original-versus-extracted function calls.

Aktuwal na compiled Linux API checks ang naghambing ng duplicate/distinct-unit
Excel exports, lahat ng Excel ZIP members, PDF page sizes/content streams, anim
na barcode lookup scenarios, empty-export validation, at comparison match,
mismatch at missing results/notes. Synthetic records at local synthetic Gemini
responses ang ginamit; walang real-image OCR, external AI, owner credentials,
owner database writes o Windows automation. Tingnan ang `VERIFICATION.json` at
mga report para sa saklaw ng checks.

Pagkatapos ma-verify sa owner VM, i-commit lamang ang apat na file sa table at
i-push ang `refactor/modular-server`. Panatilihing hiwalay ang staged
`phase2b.py` at untracked `ipas-ocr-label-check.mjs`.

Kung kailangan ng rollback, ibalik ang parehong source at compiled server mula
sa backup at i-restart ang user service. Hindi na gagamitin ng naibalik na source
ang bagong module file.
