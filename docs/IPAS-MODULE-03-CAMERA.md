# Smart Capture: camera at pag-upload

## Dahilan at pagbabago

Sa recovered frontend, nakatago ang mga file input ng Smart Capture. Lumalabas
lang ang Add More buttons kapag mayroon nang larawan, kaya walang paraan para
magsimula sa page na walang capture.

Idinagdag ang nababasang browser module:
`frontend-prebuilt/assets/ipas-smart-capture-camera.js`.
Isang deferred script tag ang idinagdag sa `frontend-prebuilt/index.html`.
May Open Camera, Capture Photo, Upload Photos, Stop Camera, at Use Phone Camera
sa cellphone. Inilalagay ng module ang file sa dati nang input at change handler
ng app, kaya kasama ito sa tunay na Captured Images state.

Nasa hiwalay na custom element at Shadow DOM ang mga kontrol. Hindi binago ang
compiled React bundle. Nakadepende ang maliit na adapter sa kasalukuyang Smart
Capture heading at hidden inputs; kailangang suriin ito kapag napalitan ang
frontend. Hindi pa kasama sa recovered files ang orihinal na React source.

Humihingi lang ng camera access kapag pinindot ang Open Camera. Walang audio.
Humihinto ang camera kapag pinindot ang Stop Camera, umalis sa Smart Capture,
o itinago ang tab. Itinitigil din ang stream kung huli dumating ang permission
pagkaalis ng user. May paliwanag kapag denied, walang camera, o ginagamit ito
ng ibang app. Hindi pinaliliit ng equipment table ang form sa tabi; sa dati
nitong scroll container gumagalaw ang malapad na table.

## Laptop at cellphone

Kailangan ng HTTPS o localhost para sa live preview. Karaniwang haharangin ng
browser ang getUserMedia sa `http://192.168.66.74:3000`. May malinaw na mensahe
ang bagong button sa ganitong kondisyon. Para sa laptop, maaaring gumamit ng
SSH local forwarding at buksan ang localhost; ituturo ito nang hiwalay sa chat.
Hindi kailangan ng pagbabago sa browser security settings.

Ginagamit ng Use Phone Camera ang dati nang file input na may
`capture="environment"`. Depende sa cellphone at browser ang pagpili ng native
camera. Puwede ring gamitin ang Upload Photos. Hindi nagdaragdag ang patch ng
bagong cellphone-to-laptop relay o nagbabago ng lumang floating camera panel.

## Pagsusuri at hangganan

Sa Chromium browser, nasuri ang tunay na video/canvas/file flow gamit ang
synthetic camera: isang capture, isang entry sa React state, file upload,
navigation cleanup, muling pagbukas ng page, denied permission, at delayed
permission matapos umalis. Nasuri ang mobile layout at native capture input
sa mobile emulation. Ginaya ang insecure-context flag upang suriin ang
mensaheng pang-HTTP. Pumasa rin ang JavaScript syntax at frontend asset build.

Kailangan pang subukan sa aktuwal na laptop camera at cellphone ng may-ari.
Hindi ito pagsusuri ng OCR accuracy. Sa recovered Smart Capture page, wala ring
nakikitang Scan/OCR action; hiwalay pang susuriin ang pagkakabit ng OCR sa
workflow matapos gumana ang pagkuha ng larawan. Hindi awtomatikong nangangahulugan
na nabasa na ng OCR ang isang larawang nasa Captured Images.

Hindi binago ng patch ang server.ts, OCR engine, database, o API endpoints.
Nananatiling hiwalay ang naunang OCR module; kailangan pa rin nitong live image
verification bago ituring na kumpleto ang pag-aayos ng OCR.

## Paglalapat at pagbabalik

Ang installer ay sumusuri ng baseline hashes, gumagawa ng hiwalay na staging
frontend build, at nagba-backup ng bawat file na babaguhin. Inilalapat nito ang
tatlong source file at dalawang katumbas na generated file sa dist. Huling
pinapalitan ang runtime HTML upang mauna ang bagong script.

Hindi nito binabago ang backend bundle, .env, phase2b.py, Git index, service,
dependencies, o database. Hindi kailangan ng backend restart; kailangan ng
browser refresh pagkatapos ng matagumpay na paglalapat. Kapag nagkaroon ng
write error, awtomatikong ibinabalik ang dating files. Itabi ang ipapakitang
backup path at rollback command. Kung may mas bagong pagbabago sa apektadong
file, hihinto ang manual rollback para hindi ito mapatungan.
