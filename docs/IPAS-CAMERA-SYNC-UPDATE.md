# Camera-sync update pagkatapos ng Module 03

## Nasuring daloy

May gumaganang camera-sync sa lumang `ipas-cam.js` at
`controllers/cameraSyncController.ts`:

| Pinanggalingan sa cellphone | captureType | Tatanggap sa laptop |
| --- | --- | --- |
| Floating Equipment button | equipment | Accountability → Smart Capture |
| Floating Tickets button | ticket | Travel Expense Report → Supporting Document |
| Bagong Use Phone Camera o Upload Photos sa Smart Capture | equipment | Accountability → Smart Capture |

Ang huling hanay ang kulang sa unang bersiyon ng Module 03. Dati, sa lokal na
React state ng cellphone lang napupunta ang file. Ngayon, nakukuha pa rin ng
parehong phone form ang orihinal na file, at ipinapadala rin ito sa dati nang
`POST /api/cam/push`. Ginagamit ang employeeId mula sa kasalukuyang
`GET /api/auth/me`, at `captureType: "equipment"` ang ipinadadala.

Ang dati nang desktop SSE receiver (`/api/cam/events`), pending retrieval,
deduplication, at paglalagay sa module ang ginagamit. Hindi binago ang
`ipas-cam.js`, compiled React bundle, camera controller, routes, o backend.
Ipinapadala ang orihinal na larawan; walang bagong compression na nagtatapon
ng detalye sa asset tag. Sunod-sunod ang upload mula sa bagong controls upang
maiwasan ang sabay-sabay na pagpapadala ng isang batch.

## Nakikitang pag-uugali

Sa cellphone na HTTP ang koneksiyon, Use Phone Camera at Upload Photos ang
ipinapakita. Kailangan pa rin ng HTTPS ang browser live preview sa cellphone.
Nananatili ang live camera controls sa localhost ng laptop.

May status para sa pagpapadala, server acknowledgement, at error. Ang
"Saved on the server" ay kumpirmasyon ng server; hindi ito pangakong bukas na
o natanggap na ng laptop ang larawan. Kailangang parehong account ang gamit
at buksan ang Smart Capture sa laptop. Kapag ibang tab ang bukas, ginagamit
ang dati nang equipment retry queue ng receiver hanggang mabuksan ang Smart
Capture. Nananatili ang pag-route ng Tickets sa Supporting Document.

May Retry Send kapag pumalya ang push. Nananatili sa phone form ang file.
Ang hindi pa naipadalang retry queue ay nasa memory lamang ng kasalukuyang
browser page; huwag i-refresh o isara ito habang may kailangang i-retry.
Kapag hindi makumpirma ang account bago magsimula, may mensaheng mag-sign in
at i-attach muli ang larawan. Ang muling pagpapadala ng larawang na-save na
ay gumagamit ng dating server deduplication. Ang dating lokal na capture
bago ang update ay kailangang i-attach muli upang maipadala.

## Pagsusuri

Ginamit ang Chromium na may dalawang magkahiwalay na browser context:
desktop at Android emulation. Tunay na camera controller at routes ang
pinatakbo, kasama ang recovered React frontend at lumang `ipas-cam.js`.
Kontrolado ang authentication fixture at nasa pansamantalang folder ang
server-side image storage; hindi ginamit ang production database o account.

Pumasa ang bagong native phone capture → isang entry sa phone form → real
push API → SSE → isang entry sa laptop React state. Pumasa rin ang lumang
Equipment at Tickets, kabilang ang file sa loob mismo ng Supporting Document.
Nasuri ang failed send/retry, nawawalang acknowledgement nang walang dobleng
larawan, multiple uploads, at equipment na naghihintay sa tamang tab.
Nasuri rin ang hiwalay na authenticated account at pagtanggi ng controller
sa employeeId na hindi tugma sa session.

Pumasa ang naunang camera tests para sa laptop video/canvas capture, uploads,
pag-alis sa page, denied permission, delayed permission cleanup, at mobile
file input. Ang HTTP branch ay sinuri gamit ang simulated insecure context.
Kailangan pang kumpirmahin ang update sa aktuwal na cellphone at laptop ng
may-ari pagkatapos ma-install.

Hindi pa nito pinatutunayang gumagana ang OCR sa tunay na larawan. Hiwalay
pa ring susuriin ang OCR action ng recovered Smart Capture workflow at ang
accuracy ng naunang OCR backend module. Hindi rin ito kumpletong security
audit: may employeeId fallback ang lumang camera endpoints kapag walang
session; kailangang isama ang awtorisasyon nito sa susunod na backend audit.

## Paglalapat

Para ito sa frontend pagkatapos ng unang Module 03. Sinusuri ang checksum
ng source at runtime files at ang lumang camera-sync script. Hihinto kapag
may ibang pagbabago sa mga ito. Nababasang code ang nasa
`frontend-prebuilt/assets/ipas-smart-capture-camera.js`.

Gumagawa ang installer ng hiwalay na syntax check at frontend asset build,
backup, at rollback command. Source at katumbas nitong dist files lang ang
inilalapat. May bagong script query version upang makuha ng browser ang
bagong code pagkatapos ng refresh sa parehong device. Hindi kailangan ng
service restart; hindi ginagalaw ang .env, phase2b.py, Git index, o database.
