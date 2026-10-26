# Reference alignment: editable source guide

## Ano ang inilipat

Nasa `services/referenceAlignment.ts` na ang pitong kasalukuyang function at
`ReferenceRecord` type alias para sa reference scoring, one-to-one pairing,
reference reconciliation, record conversion at local/AI comparison merging.

Pareho ang katawan ng mga function at type alias; exports at imports lang ang
nadagdag o inayos. Mula 3,694 ay naging 3,509 lines ang `server.ts`. Patuloy nitong
binabasa ang reference source, tumatawag sa OCR/AI, nagma-manage ng cache at
pinapatakbo ang API orchestration. Walang bagong package o installer.

## Saan mag-e-edit araw-araw

Sa VS Code, Ctrl+P at buksan ang `services/referenceAlignment.ts`.

| Gusto mong baguhin | Function |
| --- | --- |
| Score ng asset tag, serial, component, description at brand match | `scoreReferenceMatch` |
| Pagpili at pag-apply ng isang reference sa observed record | `reconcileRecordWithReference` |
| One-to-one pairing ng Smart Capture batch sa reference document | `alignRecordsToReferenceBatch` |
| Conversion ng comparison record papunta sa reference record | `toReferenceRecordFromComparison` |
| Conversion ng intake evidence papunta sa comparison shape | `toExtractedCompareRecordFromIntake` |
| Pagsasama ng local at AI comparison evidence | `mergeObservedComparisonRecord` |
| Pagpares ng local evidence ayon sa expected document order | `mapObservedIntakeRecordsToExpected` |

Ang field cleaning ay nasa `services/intakeNormalization.ts`. Ang field
preferences at consolidation ay nasa `services/intakeConsolidation.ts`.
Ang final match/mismatch/missing comparison ay nasa `services/comparison.ts`.
Ang compiled `dist-server/server.cjs` ay build output; `.ts` source ang ie-edit.

## Parehong behavior na pinanatili

- Ang scores ay 100 para sa hardware ID, 85 sa serial, 25 sa component,
  35 sa exact description, 20 sa partial description, at 18 sa existing
  same-brand fallback kapag walang observed hardware ID at pareho ang component.
- Ang Smart Capture alignment threshold ay 35. Ang comparison evidence mapping
  threshold ay 25. Hindi sila pinagsama o ginawang mas strict sa extraction.
- Nananatili ang greedy highest-score pairing: tig-isang gamit ang observed at
  reference entry. Nananatili ang input order sa ties; hindi ito bagong globally
  optimal assignment algorithm.
- Pinapanatili ng Smart Capture alignment ang photo order at observed filename/
  remarks. Nananatili ang dating reference field preferences at replacement note.
- Ang comparison mapping ay naglalabas ayon sa expected document order. Blank
  slots ang walang matched evidence; hindi dinadagdagan ang output ng extra
  observations o kinokopya ang expected identifiers sa blank evidence slots.
- Reference fields ang sini-sanitize sa scoring; ang observed fields ay inaasahang
  dumaan na sa existing normalization. Walang bagong fuzzy identifier correction.
- Nananatili ang primary/fallback merge preferences, raw comparison values,
  description selection at note order.

Maaari pa ring mag-align ayon sa dati nang description/brand evidence at mag-apply
ng reference values ayon sa kasalukuyang preference rules. Hindi ito bagong
garantiya ng OCR accuracy o pagbabago sa patakaran ng system.

Hindi binabago ang database schema, API paths, AI/OCR engine, camera sync,
login background, PDF/Excel layout, port o HTTPS setup.

## Apat na file na ilalagay

| Download | Lokasyon sa server |
| --- | --- |
| `referenceAlignment.ts` | `/srv/IPAS-PUBLISH/services/referenceAlignment.ts` |
| `referenceAlignment.test.ts` | `/srv/IPAS-PUBLISH/tests/referenceAlignment.test.ts` |
| `server.ts` | `/srv/IPAS-PUBLISH/server.ts` |
| `IPAS-REFERENCE-ALIGNMENT.md` | `/srv/IPAS-PUBLISH/docs/IPAS-REFERENCE-ALIGNMENT.md` |

Ang replacement server ay nakabatay sa owner commit `4c4f704`. Bago ito palitan,
ang SHA256 ng kasalukuyang `server.ts` ay dapat:

```text
f65c5f4c1eab66d8f973343329cf69826d814dad8d9ef8f6ada9c047c528e420
```

Kung iba ang hash, kailangang isama ang extraction sa mas bagong source.
I-backup muna ang source `server.ts` at compiled `dist-server/server.cjs`.

## Check, build at save

Mula sa `/srv/IPAS-PUBLISH`, pagkatapos makopya ang module, test at server:

```bash
node --import tsx --test tests/referenceAlignment.test.ts tests/intakeConsolidation.test.ts tests/intakeNormalization.test.ts tests/comparison.test.ts
NODE_OPTIONS="--max-old-space-size=3072" npm run lint
npm run build:server
systemctl --user restart ipas.service
curl -sS --max-time 20 -w '\nHTTP %{http_code}\n' http://127.0.0.1:3000/api/health
```

Subukan din ang maliit na synthetic reference fixture: dalawang photo records
na baligtad ang order at may valid hardware IDs. Dapat tumugma ang reference
details habang nananatili ang photo order. Walang kailangang isulat sa database
para sa ganitong module check.

Sa hiwalay na cloud environment, pumasa ang 28 bagong tests at 311 existing tests,
TypeScript check at server build. Bawat test file ay pinatakbo sa sariwang Node
process. Pareho ang pitong inilipat na function, type alias, at 135 retained named
declarations. Pareho ang resulta sa 4,900 original-versus-extracted function calls.

Aktuwal na compiled Linux API checks ang gumamit ng multipart intake request,
reversed synthetic photo records at isang reference spreadsheet representation.
Napunan ang missing serials ayon sa existing reference rules habang nanatili ang
photo order. Sa comparison API, na-map ang local evidence sa document order.
Pareho ang buong before/after outputs. Nasubukan din ang comparison match,
mismatch, missing results/notes at missing-source HTTP 400.

Synthetic image bytes, local synthetic OCR snapshots at local synthetic Gemini
responses ang ginamit sa temporary working directory. Hindi ito real-image OCR,
external AI, owner credentials, owner VM, database writes o Windows automation.
Tingnan ang `VERIFICATION.json` at mga report para sa saklaw ng checks.

Pagkatapos ma-verify sa owner VM, i-commit lamang ang apat na file sa table at
i-push ang `refactor/modular-server`. Panatilihing hiwalay ang staged
`phase2b.py` at untracked `ipas-ocr-label-check.mjs`.

Kung kailangan ng rollback, ibalik ang parehong source at compiled server mula
sa backup at i-restart ang user service. Hindi na gagamitin ng naibalik na source
ang bagong module file.
