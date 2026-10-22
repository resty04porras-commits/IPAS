# IPAS seasonal live login background: editable source guide

The login combines a dark readable sign-in card with seasonal CSS motion. During
October, a locally hosted photographic Halloween scene shows moonlit woodland,
a distant manor, pumpkins and lanterns. A coherent-noise fog renderer moves textured clouds and mist across the scene,
a separate photographic foreground branch sways, and lantern light flickers.
The base landscape is a generated photograph; atmospheric motion is rendered
by the browser, and the form remains fixed.

On screens at least 768 pixels wide, the complete Halloween photograph fills
the scene using `background-size: 100% 100%`, without cropping, camera zoom,
blurred side fills or margins. Its width and height scale independently to
keep the moon and foreground pumpkins in frame, so proportions vary with the
screen shape. Fog and branches still move. Narrow phones retain the close-up
composition for a useful full-screen background.

## Editable files

| File | Purpose |
| --- | --- |
| `frontend-prebuilt/assets/ipas-login.css` | Scenery layers, animation, seasonal palettes, readable form styling and responsive layout |
| `frontend-prebuilt/assets/ipas-login.js` | Exact login detection, scene lifecycle, date-based theme, pause/play and visibility/reduced-motion handling |
| `frontend-prebuilt/assets/ipas-login-halloween.png` | Locally served photographic October scenery |
| `frontend-prebuilt/assets/ipas-login-branch.png` | Transparent photographic foreground branch, animated separately |
| `frontend-prebuilt/assets/ipas-login-christmas.png` | Locally served Christmas courtyard, reused for holiday/New Year modes |
| `frontend-prebuilt/index.html` | Load the two editable assets with an updated cache version |
| `docs/IPAS-LOGIN-APPEARANCE.md` | Editing, deployment, validation and rollback guide |

No animation or image library is installed. The compiled React bundle, existing
camera scripts and authentication handlers keep their current implementation.
The original React/Vite source is absent in this checkout, so the editable assets
integrate with the existing compiled frontend. If its login markup changes in a
future build, update `findLogin` and rerun the browser checks.

## Login scope and motion

The script requires the exact Employee ID placeholder, heading, password input,
Sign In button and login container. It first rejects views containing the app
sidebar. Decorations mount inside that login surface and are removed when it
unmounts. CSS targets its scoped attributes. Body/dashboard/sidebar styles are
not set, and the script does not read field values, replace handlers, send
requests, use storage or change backend/database behavior.

The scene has no pointer events. A separate keyboard-accessible Pause background
button sits below the form. Motion pauses when the document is hidden. The
system reduced-motion preference pauses it by default; Play background explicitly
enables it. The Halloween fog renderer uses small precomputed noise textures and scaled
bitmap draws on a canvas capped at 960 pixels wide and at most 25 draws per
second. Pause/reduced-motion/hidden-tab handling stops its animation frame loop.
Removing the scene on login cancels that loop, removes its resize listener,
and removes the canvas and CSS animations. Christmas light points and New Year fireworks use small dedicated canvas
renderers with the same lifecycle. Other modes use CSS atmosphere/candlelight.
Changing modes disposes the old renderer before creating its replacement;
a browser without a usable 2D canvas retains the CSS atmospheric fallback.
The initial session-loading screen and authenticated password-change dialogs do
not mount scenery or request the Halloween image.

The original **13 seasonal modes and their rule priority** are restored.
The browser's local date chooses the mode; a single timer checks after midnight
while the login is open, and page resume/visibility also rechecks the date.

| Original mode | Original schedule | Revised professional appearance |
| --- | --- | --- |
| `newyear_eve` | December 31 | Holiday courtyard photo with gold fireworks |
| `newyear` | January 1–15 | Holiday courtyard photo with gold fireworks |
| `dinagyang` | January 16–31 | Copper/festival atmospheric lighting |
| `valentine` | February 1–14 | Muted rose atmospheric lighting |
| `holyweek` | Maundy Thursday through Easter Sunday, computed each year | Quiet dark background and candlelight |
| `summer` | March 15–May 31, except the Holy Week override | Warm dark atmosphere and light rays |
| `rainy` | June–August | Rain and moving atmosphere |
| `ber_months` | September | Christmas courtyard photo and twinkling warm lights |
| `halloween_season` | October 1–30 | Halloween photo, textured moving fog and swaying branch |
| `halloween` | October 31 | Halloween photo, textured moving fog and swaying branch |
| `undas` | November 1–2 | Quiet dark atmosphere and candlelight |
| `christmas_prep` | November 3–30 | Christmas courtyard photo and twinkling warm lights |
| `christmas` | December 1–30 | Christmas courtyard photo and twinkling warm lights |

The original calendar's `christmas` fallback for otherwise unmatched dates is
also preserved, including February 15–March 14. This is an existing calendar
rule, not a new holiday/date correction. Calendar outputs are compared with the
original inline code over 2020–2035 in `calendar-equivalence.json`.

Two scenes use photographs: Halloween woodland and a Filipino-inspired Christmas
courtyard with a parol and warm lights. The other seasonal modes use animated
CSS atmosphere/candlelight; New Year adds a gold-fireworks renderer to the holiday
courtyard. These distinctions preserve automatic seasonal selection without
restoring the previous cartoon particle art. All scenes remain login-only.

## Copy and deploy

The installed static-login HTML before this revision has SHA256:

```text
91e6e361ef16d00cc799446353c436cffc15828b7faeb4193f57464e2d596678
```

The previous static-login CSS and JS hashes are recorded in SOURCE-HASHES.json.
Back up `frontend-prebuilt/assets/ipas-login.css`, `ipas-login.js` and the source
`frontend-prebuilt/index.html` before replacing them. Their basenames are distinct,
so they can share one backup directory. Preserve the older backup at
`/tmp/ipas-login-appearance-backup-LtyjTd` as well.

Copy all three PNGs, the CSS and JS to `/srv/IPAS-PUBLISH/frontend-prebuilt/assets/`, replace
`/srv/IPAS-PUBLISH/frontend-prebuilt/index.html`, and put this guide in `docs/`.
The revised HTML uses `?v=20261022-seasons3` for the CSS and JS. Then run from the
project root:

```bash
node --check frontend-prebuilt/assets/ipas-login.js
npm run build:web
```

The frontend build copies the files to `dist/`. No server rebuild or service
restart is needed for these static assets. Hard-refresh the laptop with
Ctrl+Shift+R, and refresh the phone. Keep all PNG filenames exactly as supplied.

## Verification

Confirm the Halloween photo loads and fog moves while the form stays stable.
Test Pause/Play, an invalid login, successful login, logout and a narrow viewport.
Confirm the dashboard, settings and password-change dialog have no scenery.
If motion is initially paused by system preferences, use Play background.

Cloud checks run the actual compiled frontend in Chromium against synthetic
local API responses. They check material changes in the actual fog canvas pixels, branch transforms,
paused canvas-pixel equality, settled CSS pause timing, resume, hidden-tab pause,
all thirteen original date-based modes,
reduced-motion default and explicit play, image loading, mobile/landscape layout,
login error and unchanged login request payload, successful login, logout,
initial loading and authenticated password-change dialogs. Dashboard colors
are compared with the original frontend, and scenery/animation removal is
checked. Additional checks compare encoded MP4 frames and verify that login-card bounds stay unchanged and raw form captures remain visually stable
while the background moves.
These do not validate real credentials, owner database writes, real
server authentication or external services. See VERIFICATION.json and the
browser report for the completed checks and their scope.

The screenshots, MP4 and animated GIF are preview artifacts, not runtime
dependencies. The app does not download or decode a background video.
All runtime assets are served from the same IPAS origin; no external photo or
video host is requested by these new files.

## Rollback and Git

To return to the previous static login, restore the backed-up source CSS, JS and
index.html, run `npm run build:web`, and hard-refresh. The Halloween PNG becomes
unused; deleting it is not necessary for rollback. The older two-HTML backup can
restore the earlier particle version if required.

Commit only the seven files listed above after owner verification, then push
`refactor/modular-server`. The supplied Halloween PNG and branch PNG are unchanged from the versions already
copied to the owner VM; the Christmas PNG is the additional image asset.
The comparison-module extraction remains pending;
keep it, staged `phase2b.py` and `ipas-ocr-label-check.mjs` outside this change.
