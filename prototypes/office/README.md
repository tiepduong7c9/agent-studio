# Office prototype

Throwaway three.js scenes used to settle the look of the session "office"
view. `office.html` is the approved reference scene; the others record the
options that were compared (see `reference/`).

## Assets (not committed)

Model packs are CC0 and re-downloadable; unzip them into `assets/`:

- Kenney Mini Characters → `assets/mini-characters/`
  (https://kenney.nl/assets/mini-characters)
- Kenney Furniture Kit → `assets/furniture-kit/`
  (https://kenney.nl/assets/furniture-kit)
- Quaternius Ultimate Animated Character Pack → `assets/quaternius/uacp/`
  (only used by `compare.html`;
  https://opengameart.org/content/animated-characters-pack)

## Run

```bash
npm install
python3 -m http.server 8765
# http://localhost:8765/office.html            (?zoom=x,z,view for a close-up)
# http://localhost:8765/compare.html?room=0    (character style comparison)
# http://localhost:8765/charlook.html?cam=low  (lighting/outline comparison)
```

Screenshots at 2x via the app's Electron (from the repo root):

```bash
PAGE=office.html OUT=prototypes/office/screenshots/office.png \
  env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron prototypes/office/shot2.cjs
```
