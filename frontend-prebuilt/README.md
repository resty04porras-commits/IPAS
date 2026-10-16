# Naibalik na frontend ng IPAS

Galing ang mga compiled file na ito sa `ipas-frontend.tar.gz` na ibinigay ng
may-ari ng proyekto noong 2026-10-16, mula sa `/srv/IPAS-PUBLISH/dist`.
Hindi isinama ang mga lumang `.before-*` at `index.html.backup`. Walang binago
sa runtime HTML, JavaScript, CSS, PDF worker, at mga form template.

SHA256 ng orihinal na archive:
`820adf5fd92a25d8b571ac22b6e90a73bf1be41f5cf420e18a5ed03ca482aebe`

Wala pa ang orihinal na React/Vite source (`index.html` sa ugat ng proyekto at
`src/`). Mapapatakbo ng mga compiled file ang kasalukuyang interface, pero
hindi nito naibabalik ang nae-edit na React source.

Kinokopya ng `npm run build:web` ang folder na ito sa `dist/` kapag walang
`index.html` sa ugat ng proyekto. Sinusuri muna nito kung naroon ang mga lokal
na script at stylesheet na tinutukoy ng HTML. Binubuo rin ng `npm run build`
ang Express server. Pinapatakbo ng `npm start` ang interface at API sa iisang
Express server. Gawin ang mga ito sa ugat ng proyekto pagkatapos ng `npm ci`
at pag-aayos ng `.env` ayon sa `.env.example`.

Generated na `dist/` lang ang binubura ng `npm run clean`; ibinabalik ito ng
susunod na build. Huwag direktang gamitin ang `vite build` o `vite preview`
para sa frontend na ito. Kailangan ng orihinal na source ang Vite development
mode.

Kailangan pa rin ng sariling pagsasaayos ang database, OCR, at external storage.
Huwag isama sa Git ang `.env` o mga credential.

## Pagsusuring ginawa sa cloud

- Pumasa ang `npm run clean` kasunod ang `npm run build`, at `npm run lint`.
- Naibalik nang walang pagbabago ang lahat ng 13 runtime file mula sa archive.
- Pumasa ang pagsubok sa nawawalang frontend, muling build pagkatapos ng clean,
  at pagtanggi sa kopyang may nawawalang JavaScript asset.
- Lumabas ang login page sa Chromium nang walang JavaScript exception. Lahat
  ng walong script/stylesheet reference ay may HTTP 200 at tamang asset MIME type.
- Na-download nang walang pagbabago ang dalawang form template. Gumagana ang
  frontend navigation fallback; JSON 404 pa rin ang hindi kilalang API route.
- Nasubukan ang login at pagpapanatili ng session sa browser matapos mag-reload.
  Ginamit ang lokal na server at trusted `X-Forwarded-Proto: https` test header
  upang masubukan ang kasalukuyang secure-cookie configuration.
- Hindi konektado sa totoong database, OCR, o Nextcloud ang cloud test.
  `unavailable` ang OCR sa health endpoint; hindi pa napapatunayan ang TER
  database operations, OCR processing, at pag-upload sa external storage.
