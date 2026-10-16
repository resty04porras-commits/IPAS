# Unang pagsusuri at paghihiwalay ng module

Batayan: `ipas-backend-audit.tar.gz` mula sa `/srv/IPAS-PUBLISH`, matapos ang
commit `f36a70e` sa `refactor/modular-server`. Hindi binago ang server ng may-ari
habang ginagawa ang pagsusuring ito.

## Unang package: Document Repository

May `routes/documentRepository.ts` na sa ipinadalang source, ngunit hindi ito
ginagamit ng `server.ts`. Nasa loob pa rin ng server ang siyam na endpoint.

Sa package na ito:

- Ikinekonekta ang umiiral na route module sa `server.ts` at inaalis ang dobleng
  inline registration. Pareho ang siyam na URL, HTTP method, at controller.
- Inililipat sa `services/documentRepositoryMime.ts` ang pagpili ng MIME type
  para sa preview at download. Pareho ang mga suportadong extension at fallback.
- Itinutugma ang controller types sa totoong controller factory. Ang mga handler
  nito ay nagbabalik ng Express response, kaya hindi tama ang dating `Promise<void>`.
- Pinananatili ang kasalukuyang upload contract: field na `files`, hanggang 100
  file; HTTP 400 at `Multer error: ...` para sa Multer errors; HTTP 500 at
  `Unknown upload error: ...` para sa ibang upload error.
- Inilalagay ang JSON error handler pagkatapos ng lahat ng API module at bago
  ang API 404 at frontend fallback. May proteksiyon din kapag naipadala na ang
  response headers.

Nabawasan ang `server.ts` mula 7,870 tungo sa 7,806 linya. Walang binago sa
database schema, OCR engine, account records, o Nextcloud configuration.

## Mga pagsusuring pumasa

- `npm run lint` at `npm run build`, bago at pagkatapos ng pagbabago.
- `node --import tsx --test tests/documentRepositoryRoutes.test.ts`: anim na
  test, kabilang ang lahat ng siyam na endpoint, request body at URL parameters,
  multipart upload, invalid field, limit na 100 file, filesystem error na may
  error code, at mga MIME type.
- Aktuwal na login, cookie session, at document metadata create/read/update/delete
  gamit ang totoong auth at document controllers sa hiwalay na test database.
  HTTP 401 ang pag-create nang walang login; HTTP 404 ang naburang record.
- Sa compiled production app, bumubukas ang login page sa Chromium at na-load
  ang frontend assets nang walang JavaScript exception o failed response.
- Pumasa ang auth-me, health, storage-status, at JSON API 404 checks.
- Ang invalid encoded document URL ay dating HTTP 400 na HTML error page;
  HTTP 400 na JSON na ito pagkatapos ng pagbabago.

Ang database test ay gumamit ng PGlite, isang hiwalay na PostgreSQL engine sa
WebAssembly, na may pgcrypto. Hindi ito koneksiyon sa totoong database.

## Kalagayan ng mga module sa ipinadalang source

| Bahagi | Nakita | Kailangang sundan |
| --- | --- | --- |
| Authentication | May controller, routes, user repository, at bcrypt | Suriin ang access checks sa ibang module at pagpapanatili ng session |
| Inventory | May controller, routes, at repository | Authorization at validation ng numeric input |
| Accountability | May controller, routes, at repository | Export at OCR helpers ay marami pa ring nasa server; hiwalay pa ang history |
| TER | May controller, routes, repository, at schema | Extraction/export helpers ay nasa server pa; may hindi na ginagamit na JSON persistence helpers |
| Document Repository | May controller, repository, at WebDAV service | Nakumpleto ang route wiring sa unang package; totoong Nextcloud test ay kasunod pa |
| Management/RBAC | May controller, routes, repositories, at role seeds | Hindi pa naikakabit ang permission checks sa mga endpoint |
| Settings | May repository at schema migration | Walang nakitang controller/route wiring para sa settings repository sa source na ito |
| Camera sync | May controller at routes | Kailangang subukan sa tunay na dalawang device at network |
| OCR | May EasyOCR service at legacy worker | Engine selection, rotated text, crop validation, at aktuwal na accuracy test |
| Runtime/system | Health, host configuration, startup, at ilang route ay nasa server pa | Ilipat sa sariling module pagkatapos ng mahahalagang functional checks |

## Mga napatunayang puwang at susunod na pag-aayos

1. **Kontrol ng access.** Walang login requirement sa kasalukuyang user-list
   endpoint. Napatunayang HTTP 200 ang `GET /api/users` nang walang session sa
   hiwalay na test app gamit ang totoong management routes at controller.
   May `roleHasPermission` sa repository ngunit wala itong caller sa ipinadalang
   routes/controllers. Kailangang ayusin ang authentication at authorization
   bago ituring na kumpleto ang RBAC. Hindi ito binago ng unang package.
2. **Pagpili ng OCR engine.** Sa `recognizeOcrSnapshot` at
   `recognizeOcrSnapshotBatch`, laging nauuna ang legacy Paddle worker para sa
   image input kahit enabled ang HTTP EasyOCR service. Napatunayan ang call order
   gamit ang mismong function code at test doubles. Apektado ang regional intake
   extraction at liquidation receipt extraction; hiwalay ang direktang `/ocr-v2`
   flow na gumagamit muna ng HTTP service. Kailangang gawing pare-pareho ayon sa
   `OCR_ENGINE` at subukan ang fallback at timeout behavior.
3. **Pagkilala sa nakatagilid na teksto.** Binabasa at ipinapakita sa health ang
   `OCR_USE_ANGLE_CLS`, pero walang rotation option na ipinapasa sa EasyOCR
   `readtext`. Code finding ito; kailangan pa ng aktuwal na rotated-image test.
4. **OCR crop sa gilid.** Ang `crop_image` ay maaaring magbalik ng rectangle sa
   labas ng image bounds. Halimbawa, sa 100×80 na image at crop na nagsisimula sa
   `(100,80)`, ang nakuwentang box ay `(100,80,101,81)`. Kailangang i-validate ang
   empty/outside crop at batch input sa hiwalay na OCR patch.
5. **History persistence.** Ang `/api/history` ay gumagamit pa ng `apiHistory`
   array sa memory. May `form_history` table sa schema ngunit hindi ito ginagamit
   ng kasalukuyang history handlers. Hindi mananatili ang bagong in-memory history
   kapag nag-restart ang proseso. Kailangan ng maingat na migration ng API behavior.
6. **Migration workflow.** Walang nakitang migration runner o migration tracking
   command sa kasamang package scripts/tools. Kailangang suriin ang aktuwal na
   deployment procedure bago magdagdag o magpatakbo ng schema changes.

## Database: ano ang nasuri at hindi pa nasuri

Pumasa mula sa malinis na test database ang lahat ng kasamang schema migration:
`001_initial_schema.sql`, `003_user_registry_compatibility.sql`,
`004_rbac_seed.sql`, at `005_system_settings.sql`.

Pumasa ang pagbasa ng users, inventory, accountability, travel entries, documents,
audit logs, settings, roles, permissions, at role-permission assignments. Pumasa
rin ang pag-create ng test user at bcrypt verification, inventory item,
accountability form na may items, TER entry, document na may foreign keys,
audit log, at settings record; pati document update/delete.

Sadyang hindi isinama sa archive ang `002_migrate_ter_entries.sql` dahil maaari
itong maglaman ng tunay na business data. Ang agwat na iyon sa numbering ay
hindi ebidensiyang nawawala ang schema migration sa tunay na server.

Hindi pa nakuha ang schema-only inventory ng tunay na database. Kaya walang
inaangking kulang o nawawalang table sa production.

## Mga hangganan ng unang pagsusuri

Hindi kasama sa backend archive ang `.env`, production data, `middleware/`,
orihinal na frontend source, at lahat ng runtime/deployment files. Hindi dapat
ipagpalagay na wala ang mga iyon sa server dahil wala sila sa archive.

Hindi pa nasusubukan ang tunay na Nextcloud upload/download, aktuwal na EasyOCR
inference at accuracy, device camera/SSE, Windows Excel exports, o lahat ng
database CRUD at business workflows. Ang ipinakitang frontend sa cloud tests ay
mula sa naunang recovery archive.

## Paraan ng paglalapat

Ang kasamang installer ay:

1. Naghahambing ng checksum ng mga papalitang source file sa ipinadalang baseline.
2. Nagsusuri ng package integrity at humihinto kapag may hindi inaasahang file change.
3. Gumagawa ng hiwalay na staging copy na walang root `.env`; ginagamit ang
   naka-install nang Node dependencies ng server.
4. Nagpapatakbo ng route tests, TypeScript check, at build sa staging.
5. Gumagawa ng backup ng mga papalitang file at kasalukuyang server bundle.
6. Inilalapat ang source files at bagong bundle kapag pumasa ang mga check.
   Ibinabalik ang backup kapag may error habang kinokopya ang mga pagbabago.

Hindi ito nag-i-install ng dependency, nagra-run ng migration, nagpu-push sa
GitHub, o nagre-restart ng app. Kailangang tukuyin muna ang kasalukuyang paraan
ng pagpapatakbo ng app bago ang kontroladong restart at production checks.

Nasubukan ang installer sa hiwalay na kopya: pagtanggi sa mas bagong source,
pagkabigo ng staging check nang walang nabagong live file, matagumpay na
paglalapat, muling paglalapat bilang no-op, tahasang rollback na eksaktong
nagbalik ng dating file bytes, at awtomatikong rollback matapos ang sinadyang
write failure. Nanatiling buo ang test `.env` at hiwalay na `phase2b.py`.
