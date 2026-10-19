# OCR HTTP client at gabay sa pag-edit

Batayan: na-verify na OCR/barcode commit `24e341c`. Ang pagbabagong ito ay
paglilipat ng HTTP transport sa hiwalay na TypeScript module.

## Ano ang inihiwalay

Ang bagong file ay `/srv/IPAS-PUBLISH/services/ocr/httpClient.ts`.
Dito na nakalagay ang:

- paggawa ng multipart request na may larawan, MIME type at filename;
- pagpapadala sa Python `/ocr` at `/barcode` endpoints;
- pag-forward ng crop rectangle, named batch probes at OCR mode;
- pag-normalize ng service response at pagpapanatili ng error messages;
- HTTP timeout at paglilinis ng timers;
- barcode HTTP 404 fallback sa kasalukuyang local worker;
- decoded barcode candidates at tamang engine metadata.

Sa `/srv/IPAS-PUBLISH/server.ts`, import at client configuration na ang
pumalit sa dalawang HTTP request implementation. Nananatili muna rito ang
Python process startup, health probing, recovery at worker process pool.
Susunod silang ihihiwalay bilang magkakahiwalay na gawain.

Ang bilang ng linya sa server ay 7,549 bago, at 7,405 pagkatapos.
Walang bagong dependency, database migration, o pagbabago sa camera files.
Hindi binabago ng refactor ang OCR model o ang kasalukuyang accuracy nito.

## Saan bubuksan ang code sa VS Code

Gamitin ang VS Code na naka-SSH sa IPAS. Pindutin ang `Ctrl+P`, i-paste ang
buong path ng file, at pindutin ang Enter.

| Gusto mong ayusin | File sa server |
| --- | --- |
| HTTP request, upload, timeout o response ng OCR service | `/srv/IPAS-PUBLISH/services/ocr/httpClient.ts` |
| Pagpili ng OCR engine at fallback | `/srv/IPAS-PUBLISH/services/ocr/recognizer.ts` |
| Text, lines, words, bounding boxes at normalized snapshot | `/srv/IPAS-PUBLISH/services/ocr/snapshots.ts` |
| Request validation at JSON response ng accountability APIs | `/srv/IPAS-PUBLISH/controllers/accountabilityController.ts` |
| Mga URL at pag-uugnay ng routes sa controller | `/srv/IPAS-PUBLISH/routes/accountabilityRoutes.ts` |
| Python image preprocessing at EasyOCR inference | `/srv/IPAS-PUBLISH/ocr-service/ocr_api.py` |
| Code 128, QR, EAN at barcode fallback | `/srv/IPAS-PUBLISH/ocr-service/barcode_reader.py` |
| OCR data types | `/srv/IPAS-PUBLISH/types/ocr.ts` |
| Barcode data types | `/srv/IPAS-PUBLISH/types/barcode.ts` |
| App wiring at mga bahaging hindi pa naililipat | `/srv/IPAS-PUBLISH/server.ts` |

Ang `httpClient.ts` ay para sa komunikasyon sa Python service. Kapag mali ang
aktuwal na nabasang letra sa larawan, ibang bahagi ang kailangang suriin:
image quality, preprocessing at recognition sa Python service.

## Mga file para sa hakbang na ito

Plain source files ang ihahatid, na may mga destinasyong ito:

1. `httpClient.ts` → `/srv/IPAS-PUBLISH/services/ocr/httpClient.ts`
2. `ocrHttpClient.test.ts` → `/srv/IPAS-PUBLISH/tests/ocrHttpClient.test.ts`
3. `server.ts` → `/srv/IPAS-PUBLISH/server.ts`
4. Ang gabay na ito → `/srv/IPAS-PUBLISH/docs/IPAS-OCR-HTTP-CLIENT.md`

Kailangan munang ihambing ang kasalukuyang `server.ts` sa baseline at gumawa
ng backup ng source at kasalukuyang server bundle bago palitan ang umiiral
na file. Kung may bagong edits sa `server.ts`, dapat i-merge ang pagbabago
sa halip na patungan ang mga edits. Ituturo ang paglalagay nang paisa-isa.

## Kapag araw-araw nang nag-e-edit

I-edit ang source file na may sakop sa inaayos mo, pagkatapos ay i-save.
Ang production app ay gumagamit ng generated server bundle; kailangan ng
successful build at controlled restart bago makita ang backend changes.

Para sa TypeScript/backend changes, gawin nang paisa-isa:

```bash
npm run lint
```

Pagkatapos, ang kaugnay na tests. Para sa OCR HTTP refactor:

```bash
node --import tsx --test tests/ocrHttpClient.test.ts tests/ocrRecognizer.test.ts tests/ocrRoutes.test.ts tests/documentRepositoryRoutes.test.ts
```

Kapag pumasa, i-build ang backend:

```bash
npm run build:server
```

Kapag matagumpay ang checks/build, saka ang controlled restart at health check:

```bash
systemctl --user restart ipas.service
```

```bash
curl -sS --max-time 20 http://127.0.0.1:3000/api/health | python3 -m json.tool
```

Kapag may failing check, ayusin muna iyon bago mag-restart. Pagkatapos ng
health check, subukan din ang mismong feature na binago; hindi sapat ang
`status: ok` para patunayang tama ang OCR text.

Ang `/srv/IPAS-PUBLISH/dist-server/server.cjs` ay generated output. Ang
permanenteng pagbabago ay ilalagay sa editable source files sa itaas.

## Nasubukan sa hiwalay na environment

- 41 Node tests: 13 HTTP transport tests at 28 umiiral na recognizer,
  controller at Document Repository tests.
- TypeScript check at buong production build.
- Actual multipart HTTP requests: bytes, filename, MIME type, mode at crops.
- HTTP errors, invalid JSON, readiness failure, response-body timeout at
  barcode fallback, na may parehong dating error/response contracts.
- Buong compiled app: OCR v2, intake asset/serial parsing at liquidation
  receipt amount parsing gamit ang controlled OCR service.
- Buong compiled app kasama ang totoong EasyOCR at ZXing service sa
  original monitor image: exact Code 128 serial candidate at hiwalay na EAN.

Wala pang pagbabago sa server ng may-ari hanggang mailagay ang mga files.
Kailangan pa ang checks/build at live verification doon bago ang susunod
na commit. Nananatiling hiwalay ang staged `phase2b.py` at diagnostic file.
