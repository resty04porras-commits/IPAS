# OCR at barcode enrichment

Batayan: Module 02 OCR source at ang na-commit nang camera/sync fixes. Ang
update na ito ay para sa backend; hindi nito binabago ang Smart Capture UI.

## Problema at resulta

Sa tunay na monitor.jpg (4080 × 2296), hindi kumpleto ang EasyOCR text.
May maling unang digit sa SNID kahit mataas ang average confidence. Sa
magkahiwalay na crop, lumabas ang model at tamang SNID ngunit hindi ang buong
serial o asset tag. Hindi sapat ang pagbaba ng confidence threshold: may
maling numeric string na higit sa 80% ang score.

Ang serial barcode ay Code 128. Ang dating OpenCV reader ay hindi nakakuha
nito sa sample. Nakuha ng bagong reader ang eksaktong decoded value mula sa
buong larawan sa pamamagitan ng generic, overlapping scan windows. Wala
itong nakapirming coordinates o expected identifier mula sa sample image.

## Editable source files

- `ocr-service/barcode_reader.py`: hiwalay na barcode decoder. ZXing-C++ para
  sa Code 128/39, QR at iba pang supported formats; OpenCV pa rin ang fallback.
- `ocr-service/ocr_api.py`: ini-import ang decoder sa halip na sariling implementation.
- `types/barcode.ts`: iisang response/candidate type para sa server at controller.
- `controllers/accountabilityController.ts`: sabay na OCR at optional barcode
  scan sa `/api/ocr-v2`. Ibinabalik ang candidates sa hiwalay na `barcodes` array.
- `server.ts`: short timeout para sa optional barcode call, at tamang engine log.
- `ocr-service/requirements.txt`: pinned `zxing-cpp==3.1.1` para sa normal setup.

Nananatili ang OCR text, confidence, snapshots, bounding boxes at engine
selection. Hindi kino-convert sa OCR text o 100% OCR confidence ang decoded
barcode. Hindi awtomatikong itinatakda bilang serial ang EAN product code,
at hindi inaangking may database match ang isang decoded identifier.

Kapag maraming codes, inuuna sa primary barcode ang non-retail format kaysa
EAN/UPC. Nasa array pa rin ang lahat ng distinct codes at original-image points.
Maaaring i-review ng operator ang candidates; walang bagong automatic form
autofill sa update na ito. Ang umiiral na barcode lookup ay maaari pa ring
humanap ng record gamit ang primary decoded value.

## Failure behavior

- Barcode unavailable/timeout: nananatiling successful ang matagumpay na OCR.
- OCR failure: nananatiling error, kahit may na-decode na barcode.
- Wala o pumalya ang ZXing: sinusubukan ang dating OpenCV reader.
- Hindi tinatanggap bilang candidates ang invalid/checksum-failing ZXing reads.
- Ang optional OCR enrichment ay may 5-second HTTP timeout; may sariling
  bounded timeout din ang legacy worker kung `/barcode` returns 404.
- Nililinis pa rin ng controller ang temporary uploaded files.

## Validation

- 28 Node tests: Document Repository, OCR recognizer at actual Express routes.
- 7 Python tests: real Code 128 and QR decoding, identifiers at different image
  positions, original-coordinate mapping, EAN separation, blank input and fallback.
- TypeScript check at production build.
- Tunay na EasyOCR + ZXing HTTP service at buong compiled Node app gamit ang
  original monitor image: exact Code 128 candidate at hiwalay na EAN value.
  Napanatili ang OCR snapshot text/confidence. Walang simulated OCR response
  sa real-image check na ito.
- Sa test environment, 489 ms ang barcode endpoint at 16.3 s ang buong OCR v2.
  Hindi ito garantiya ng parehong bilis sa production; ibang machine at Python
  runtime ang laboratoryo. Nasa package verification report ang actual results.

## Natitirang limitasyon

Hindi pa maaasahang nababasa ang asset tag sa sample. Walang hinulaang
`MTR-2021-044` sa code at walang pagwawasto ng year batay sa expected format.
Kailangan ng mas malapit/malinaw na capture o manual confirmation.

Sa 1600-pixel compressed copy ng buong monitor, EAN lang ang nakuha. Para sa
maliliit at siksik na barcode, dapat punuin ng label ang mas malaking bahagi
ng frame. Hindi binago o binalik ang na-verify nang camera speed settings.

Ang `useAngleCls: true` health field ng lumang Python service ay hindi patunay
na may angle correction; hiwalay pa itong pending issue. Wala ring bagong
database migration, persistence, auth change, o OCR UI button sa update.

## Paglalapat at rollback

Ang kasamang installer ay may source/wheel checksum gates. Offline ang bagong
dependency; walang model download o dependency update mula sa Internet.
Sinusubukan muna ang wheel sa temporary staging directory bago may palitan.
Para ito sa Linux x86_64 at Python 3.12+; susuriin ang mismong native import
sa umiiral na OCR environment. Hindi nito papalitan ang ibang installed
ZXing version.

Kasama sa backup ang source files, generated server bundle at lahat ng bagong
native dependency files. Kapag may write failure, ibinabalik ang mga ito.
Tumatanggi ang manual rollback kung may mas bagong pagbabago sa target files.
Hindi ginagalaw ang `.env`, database, camera/frontend files, staged `phase2b.py`,
o Git index. Hindi awtomatikong nire-restart ang app.

Kailangan pa ang controlled `ipas.service` restart at real-image verification
sa server ng may-ari bago i-commit ang update.
