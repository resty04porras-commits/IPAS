# Ikalawang module: OCR recognition at engine selection

Batayan: source pagkatapos ng Document Repository commit `d92cc87`.
Pumasa sa server ng may-ari ang unang module: app health, document metadata API,
at aktuwal na Nextcloud connection test ay may matagumpay na tugon pagkatapos
ng restart ng user service na `ipas.service`.

## Saklaw ng pagbabago

- `types/ocr.ts`: iisang depinisyon ng OCR source file, bounding boxes, words,
  lines, snapshots, batch probes, at resulta ng recognition.
- `services/ocr/snapshots.ts`: inilipat mula sa server ang normalisasyon ng OCR
  snapshots at paggawa ng plain-text snapshot.
- `services/ocr/recognizer.ts`: iisang pagpili ng engine, fallback, at batch
  recognition para sa Smart Capture, intake, at liquidation extraction.
- `controllers/accountabilityController.ts`: ginagamit na ng `/api/ocr-v2`
  ang parehong recognizer. Wala nang hiwalay at magkaibang engine-selection flow.
- `server.ts`: ginagamit ang bagong module sa umiiral na extraction helpers.
  Nananatili muna rito ang process pool, HTTP transport, at lifecycle management;
  maaari silang ihiwalay sa kasunod na yugto matapos ang live OCR verification.

Nabawasan ang `server.ts` mula 7,806 tungo sa 7,559 linya. Walang binagong API
URL, database schema, OCR Python service, dependency, o `.env`.

## Mga inayos na behavior

1. **Nauuna ang naka-configure na engine.** Sa `OCR_ENGINE=easyocr`, HTTP EasyOCR
   service muna ang ginagamit. Pinananatili ang kasalukuyang compatibility alias
   na `paddle` para sa HTTP service. Sa `legacy`, worker lang ang ginagamit.
   Ang hindi kilalang engine value ay nananatili sa dating worker-only behavior.
2. **May fallback kapag pumalya ang service.** Kapag hindi magamit ang HTTP
   service, sinusubukan ang kasalukuyang legacy Paddle worker. Kapag parehong
   pumalya, may error na naglalarawan sa dalawang pagkabigo, sa halip na magbalik
   ng blangkong matagumpay na resulta. Kailangan pa rin ng sariling Python
   dependencies at models ang legacy worker; hindi ito ini-install ng package.
3. **Hindi error ang matagumpay na fallback.** HTTP 200 pa rin ang matagumpay na
   scan, at wala nang top-level `error` kapag nagtagumpay ang fallback. Nasa
   `raw.primaryError` ang dahilan ng unang pagkabigo, kasama ng `raw.fallback`.
4. **Tama ang metadata.** `easyocr-service` o `legacy-worker` ang `raw.engine`.
   Ang dating `paddle-service` label sa direktang HTTP OCR ay pinalitan ng
   aktuwal na pangalan ng kasalukuyang Python service. Pareho pa rin ang text,
   confidence, lines, words, boxes, dimensions, at snapshot fields.
5. **Hindi tahimik na nawawala ang batch results.** Kapag kulang ang hinihinging
   probe snapshots sa service response, gagamit ng worker fallback. Kapag kulang
   din doon, error ang resulta. Ang wastong snapshot na walang nabasang text ay
   tinatanggap pa rin; hindi nito awtomatikong inuulit ang scan sa ibang engine.
6. **Walang engine call para sa plain text o walang probes.** Pinananatili ang
   dating shortcut para sa text input. Pinananatili rin ang probe timeout,
   zero retries, at hindi pag-reset ng worker sa probe timeout.

Binigyan ng bagong extraction cache version ang binagong behavior. Pareho pa
rin ang kasalukuyang worker concurrency, retries, service timeout, at crop data.

## Pagsusuring ginawa

- Pumasa ang TypeScript check at build.
- 24 na automated test ang pumasa: 13 recognizer/snapshot tests, 5 aktuwal na
  OCR API route tests, at 6 regression test ng Document Repository.
- Nasubukan ang service success, legacy-only mode, service failure na may
  matagumpay na fallback, parehong engine failure, kulang na snapshot/batch,
  valid blank image result, at pagpapanatili ng crop at image bytes.
- Sa totoong Express controller at Multer router, pumasa ang HTTP response
  contracts para sa success, successful fallback, failure, missing file, at
  unsupported file. Napatunayang nabubura ang temporary uploaded files.
- Sa buong compiled production app, gumana ang `/api/ocr-v2`,
  `/api/intake/extract`, at `/api/liquidation/extract` laban sa kontroladong
  HTTP OCR test service. Napanatili ang pagbasa ng hardware ID, serial, at
  receipt amount mula sa mga ibinigay na OCR snapshot. Walang legacy worker
  invocation habang gumagana ang test service.
- Sa hiwalay na mga production process, nasubukan ang totoong Node-to-worker
  JSON-line protocol gamit ang test worker: service failure na may matagumpay
  na worker fallback (HTTP 200), parehong engine failure (HTTP 500), at
  legacy-only mode na walang HTTP service call (HTTP 200).

Ang kontroladong service ay test double; hindi ito EasyOCR inference. Wala pang
inaangking pagtaas ng accuracy sa tunay na larawan. Kailangan pa ang aktuwal na
Smart Capture at receipt test sa server bago i-commit ang ikalawang module.

## Paglalapat at pagbabalik

May checksum checks, hiwalay na staging tests/build, backup, at rollback ang
kasamang installer. Pinananatili nito ang kasalukuyang file permissions kapag
pinapalitan ang mga file. Hindi nito ginagalaw ang `.env` o hiwalay na
`phase2b.py`, at hindi ito nagpapatakbo ng migration o dependency installation.

Hindi awtomatikong nire-restart ang app. Pagkatapos ng matagumpay na installer,
gagamitin ang dati nang natukoy na user service na `ipas.service` para sa
kontroladong restart. Susuriin ang health at totoong OCR result bago mag-commit.
Ipapakita ng installer ang eksaktong backup path at rollback command.

Pumasa ang installer tests para sa pagtanggi sa mas bagong source, pagkabigo ng
staging check nang walang pagbabago sa live files, matagumpay na paglalapat,
pagpapanatili ng file permissions, no-op kapag nailapat na, tahasang rollback,
at awtomatikong pagbabalik matapos ang sinadyang write failure. Nanatiling buo
ang test `.env` at hiwalay na `phase2b.py`.

## Natitirang gawain

- Aktuwal na OCR accuracy at latency sa mga larawan ng may-ari.
- Rotation handling at crop-boundary validation sa Python OCR service.
- Paghihiwalay ng worker/process pool at HTTP service transport mula sa server.
- Auth/permission checks at history persistence na natukoy sa unang audit.
- Feedback ng `Test Nextcloud Connection` button: napatunayang gumagana ang
  backend API; may shortcut sa compiled frontend na walang success feedback
  kapag may server configuration. Hiwalay itong aayusin upang hindi isabay sa
  OCR engine change.
