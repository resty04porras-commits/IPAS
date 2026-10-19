# Pagpapabilis ng camera-sync

## Sanhi at pagbabago

Ang unang sync update ay nagpapadala ng buong orihinal na larawan. Ang lumang
Equipment button ay may 1600-pixel/JPEG 0.82 na paghahanda bago mag-upload.
May 500–600 ms ding nakatakdang paghihintay sa desktop bago mailagay ang
equipment photo sa form, kahit handa na ang Smart Capture.

Ginagamit na ng Use Phone Camera ang parehong maximum na 1600 pixels at JPEG
quality 0.82 para sa kopyang ipinapadala. Nananatiling orihinal ang File sa
React form ng cellphone. Pinapanatili ang PNG transparency, at hindi kino-convert
ang GIF/SVG. Ginagamit ang orihinal kapag hindi mas maliit ang bagong encoding
o hindi ito ma-decode sa browser. Hindi nito ginagawang mas malinaw ang malabong
larawan; kailangang malapit at malinaw ang kuha para sa maliliit na label.

Sabay na ginagawa ang session check at paghahanda ng unang larawan. Nananatili
ang account verification sa bawat batch. Naka-cache ang eksaktong prepared
bytes sa job upang hindi magbago ang payload sa retry at gumana ang kasalukuyang
server deduplication. Sunod-sunod pa rin ang push sa loob ng batch.

Kapag handa na ang Smart Capture at walang mas naunang pending equipment,
agad ginagamit ng desktop receiver ang dati nang file-input handoff. Walang
nakapirming timer sa kasong ito. Kapag wala pa ang form, nananatili ang retry
queue at dating fallback timing upang hindi mawala o mapunta sa maling tab
ang larawan. Hindi binago ang ticket routing.

## Sukat sa kontroladong pagsubok

Dalawang browser context (desktop at Android emulation), tunay na camera-sync
controller/routes, kontroladong test sessions, at pansamantalang image storage
ang ginamit. Chromium network emulation: 1 MiB/s upload at 10 ms latency.

| Sukat para sa isang 4032×3024 test JPEG | Bago | Pagkatapos |
| --- | ---: | ---: |
| Orihinal na file | 7,992,375 bytes | 7,992,375 bytes |
| Ipinadalang data URL | 10,656,523 bytes | 607,679 bytes |
| Mula pagpili ng larawan hanggang pagdagdag sa laptop form | 13.749 s | 2.423 s |
| Mula pagtanggap ng SSE hanggang pagdagdag sa form | 676 ms | 26 ms |
| Larawan sa cellphone form | 4032×3024 | 4032×3024 |
| Kopya sa laptop | 4032×3024 | 1600×1200 |

94.3% ang ibinaba ng data-URL payload sa test na ito. Hindi ito benchmark ng
aktuwal na Wi-Fi, cellphone, o server ng may-ari. Hindi rin nito pinatutunayan
ang OCR accuracy. Hindi maaaring garantiyahan ang zero delay: may pagproseso,
upload, server save, at browser rendering pa rin.

Pumasa ang end-to-end tests para sa bagong phone control, dating Equipment,
Tickets → Supporting Document, retry, nawawalang acknowledgement nang walang
dobleng larawan, multiple uploads, at kagamitan na naghihintay sa tamang tab.
Pumasa rin ang laptop video/canvas capture, upload, denied permission,
navigation cleanup, at delayed camera permission cleanup.

## Live camera at ang HTTP message

Ang live camera ng browser ay nangangailangan ng secure context. Hindi secure
context ang `http://192.168.66.74:3000`; hindi ito malulutas sa upload code o
sa pagtanggal ng warning. Gumagana ang live preview sa localhost o sa wastong
trusted HTTPS connection. Patuloy na gumagana ang native Use Phone Camera at
Upload Photos sa cellphone sa kasalukuyang HTTP address.

May link sa laptop HTTP page patungo sa `http://localhost:3001`, ang port ng
naunang SSH camera connection. Kailangang tumatakbo ang koneksiyong iyon sa
laptop. Hindi awtomatikong nagsisimula ng SSH, gumagawa ng certificate,
naglalagay ng HTTPS, o nagbabago ng browser security settings ang update.
Hihingi pa rin ng camera permission sa localhost kung hindi pa pinapayagan.

Kung sarado na ang koneksiyon, sa CMD ng laptop muling patatakbuhin:

```bat
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3001:127.0.0.1:3000 resty@192.168.66.74
```

Panatilihing bukas iyon habang ginagamit ang `http://localhost:3001` sa laptop.
Ang same-account sync ay dumaraan sa server, kaya magkaugnay ang phone na nasa
LAN HTTP address at ang laptop na nasa localhost. Para sa live preview mismo
sa LAN address ng lahat ng device, hiwalay pang kailangang ihanda ang trusted
HTTPS at tukuyin ang domain/certificate na gagamitin.

## Paglalapat at pagbabalik

Para ito sa bersiyon pagkatapos ng `ipas-camera-sync-update`. May hash check,
hiwalay na syntax checks at frontend build, backup, at rollback. Dalawang
browser JS file, index.html, dokumentong ito, at ang tatlong katumbas na runtime
files sa dist ang apektado. May bagong query version ang dalawang script para
makuha ng browser ang bagong code pagkatapos ng refresh sa parehong device.

Hindi kailangan ng backend restart. Hindi binabago ang server bundle, OCR
backend, database, .env, phase2b.py, o Git index. Huwag i-refresh ang cellphone
habang may hindi pa naipapadalang retry queue. Itabi ang backup at rollback
command; susuriin muna sa tunay na mga device bago mag-commit.
