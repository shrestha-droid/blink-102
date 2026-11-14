# Blink 102

**Pluto was found by blinking two photographs. This blinks the infrared sky in 102 colours.**

Live: **https://blink-102.vercel.app**

Built during NASA Space Apps Challenge 2026 (14–15 November 2026) for the challenge **"Planet X and SPHEREx"**.

## What it does

Type a sky position or an object name. Blink 102 finds every image NASA's SPHEREx telescope has released of that spot, lines them all up, and flips between dates like a blink comparator, the instrument Clyde Tombaugh used to find Pluto in 1930. Anything that moved or changed brightness catches the eye.

SPHEREx photographs the sky in 102 infrared colours, so Blink 102 also lets you:

- **choose the colours** that go into the picture with one slider (or press **Sweep** to slide through all of them);
- **click any star** to get its spectrum, its brightness over time and its measured motion, from every single exposure;
- **see where known stars should be** on each date: Gaia, SIMBAD and CatWISE positions are moved forward by their proper motion;
- **scan the field** for anything that moves, and see which movers are not in a catalogue;
- **share a link** that reopens exactly the same view, or embed the viewer in another page.

## How to use it

| You want to… | Do this |
|---|---|
| Look somewhere | Type a name (`Barnard's star`) or coordinates (`08 55 10.83 -07 14 42.5` or `133.79 -7.24`) and press Go |
| Step through dates | `←` `→`, or click a small picture. `Space` plays and pauses |
| Change colour | Drag the window on the colour bar, click a detector (D1–D6), or press `S` to sweep |
| Measure a star | Click it. Hover a point in the spectrum to see the exact exposure it came from |
| See what moved | `D` for difference mode, or **Scan for movers** |
| See what SPHEREx flagged | `F` |
| Share | **Copy link**. Add `&embed=1` to the link to embed only the viewer in an `<iframe>` |

URL parameters: `target` or `ra` + `dec` (degrees), `fov` (field in pixels of 6.15″: 48–160), `wmin` + `wmax` (µm), `epoch`, `mode` (`difference` or `colour`), `sel` (selected `ra,dec`), `embed`.

## Results on the challenge's test targets

Measured with `node scripts/validate.mjs`, which uses the same routines as the page.

| Target | What Blink 102 shows | Measured | Catalogue |
|---|---|---|---|
| **Barnard's Star** | Steps north between the three passes (Sep 2025, Apr 2026, Sep 2026) | 10.26 ± 0.50″/yr | 10.39″/yr |
| **eps Indi B** | Drifts across four passes | 4.50 ± 0.06″/yr | 4.68″/yr |
| **WISE 0855−0714** | Invisible at short wavelengths; a dot at 3.8–5.0 µm that follows the predicted track | 450–550 µJy (AB ≈ 17.1), signal-to-noise 9–17 per date, within 4″ of the predicted position on every date | W2 = 13.9 mag (≈ 480 µJy) |
| **RW Aur** | Brightness changes between passes, differently at different wavelengths | 0.12 mag change in its outer light (all colours); larger at 3.8–5.0 µm | irregular variable |
| **R Dra** | Brightness swings over 17 monthly dates | 1.7 mag range (faintest Sep–Oct 2025 and Jun 2026, about 245 days apart) | Mira variable, period ≈ 246 days |

Honest limits:

- **Barnard's Star, RW Aur and R Dra are too bright for SPHEREx.** Their cores are saturated (blank or flagged) in most exposures. Blink 102 says so with a badge, locates them from their unsaturated outer light, and measures their brightness changes from that outer light. Their absolute spectra are not reliable.
- **eps Indi B** is measured 4 % below the catalogue motion. It is a close pair of brown dwarfs orbiting each other, and parallax is not removed.
- **The challenge's coordinates for WISE 0855 are its position around 2010.** It has since moved about 2′. Blink 102 recentres on where an object is now, and offers to recentre when you type old coordinates.
- **WISE 0855 at short wavelengths:** a faint background star sits a few arcseconds from its current position, so light measured there below 2.4 µm is not the brown dwarf. The motion readout warns when measured and catalogue motions disagree.
- Fluxes are aperture sums (radius 15″) with no aperture correction, so expect them about 10 % low.
- The motion scan can be fooled next to a very bright moving star, whose glow drags neighbours' centres along. It prints the catalogue value beside each measurement for comparison.

## How it works

1. **Search.** `api/search.py` asks NASA/IPAC IRSA's image service which SPHEREx exposures cover the position (collections DR1 and QR3, wide and deep). Nothing is hard-coded, so new weekly releases appear automatically. Exposures are grouped into sky passes; long continuous coverage is split into monthly dates.
2. **Read only what is needed.** Each exposure is a 65 MB file. `api/frames.py` reads a few hundred kilobytes of it from the public AWS copy with HTTP range requests: the header, the rows around the target, the matching rows of the compressed flag layer, and the wavelength table.
3. **Line everything up.** Every exposure is resampled with Astropy's WCS (including the SIP distortion) onto one north-up grid centred on the target, the sky background is fitted and removed, and SPHEREx's 23 flag bits are folded into 8 plain categories.
4. **Everything else happens in the browser.** Stacking per date and per colour window, the blink, difference and colour modes, photometry, spectra, brightness histories, motion fits and the motion scan all run instantly on the exposures already loaded (`public/sky.js`).
5. The five test targets are precomputed (`public/cache/`) so they open at once. Any other position is fetched live.

```
api/_spx.py      shared reading code      api/search.py  api/frames.py  api/catalog.py
public/          index.html, style.css, app.js (interface), sky.js (maths), charts.js, catalogs.js, cache/
scripts/         check.py (live self-checks), precache.mjs, validate.mjs
dev.py           local server
```

## Run it yourself

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python dev.py          # then open http://localhost:8791
.venv/bin/python scripts/check.py   # live checks of the data pipeline
node public/sky.js               # self-check of the maths
```

Deploys to Vercel as static files plus three Python functions (`vercel.json`).

## Data

**NASA data**

- SPHEREx Level-2 spectral images, Data Release 1 (DOI 10.26131/IRSA678) and Quick Release 3 (DOI 10.26131/IRSA662), from NASA/IPAC Infrared Science Archive (IRSA), read from the SPHEREx bucket on AWS Open Data (`nasa-irsa-spherex`).
- IRSA Simple Image Access and Table Access services.
- CatWISE 2020 catalogue (Marocco et al. 2021), from NASA's WISE mission, via IRSA.
- AllWISE, 2MASS and DSS2 sky images (HiPS) served by IRSA, in the "Wider sky" panel.

**Space agency partner data**

- ESA Gaia Data Release 3 (Gaia Collaboration, Vallenari et al. 2023), via VizieR `I/355/gaiadr3`.

**Other data and services**

- SIMBAD and the Sesame name resolver (CDS, Strasbourg; Harvard CfA mirror). VizieR (CDS).

## References

- SPHEREx Explanatory Supplement, version 2.0 (2026-08-25), Caltech/IPAC.
- Akeson et al., "The SPHEREx Image and Spectrophotometry Processing Pipeline", arXiv:2511.15823.
- Rustamkulov et al. 2026, "SPHEREx 0.75 to 5 µm Spectra for a Sequence of Nearby Brown Dwarfs", arXiv:2607.00543 (the molecule bands marked on the spectrum, and the WISE 0855 comparison).
- IRSA SPHEREx tutorial notebooks, https://caltech-ipac.github.io/irsa-tutorials (BSD-3).
- WiseView (Caselden et al. 2018, ascl:1806.004), the tool the challenge names as a model.
- Software: Astropy, NumPy, SciPy (Python); Aladin Lite v3.8.2 (CDS, Strasbourg; Boch & Fernique 2014; LGPL-3), loaded from the jsDelivr CDN only when the "Wider sky" panel is opened. No other JavaScript libraries are used.
- Fonts: IBM Plex Sans, Mono and Serif (SIL Open Font License), from Google Fonts.
- Hosting: Vercel.

## AI use

This project was built with AI assistance, as the Space Apps rules allow, and we declare it here.

- **Tool:** Claude (Anthropic), used through Claude Code.
- **What it wrote:** the code in `api/`, `public/`, `scripts/` and `dev.py`, and the first draft of this README. Every source file says so in its header comment.
- **What it did not generate:** no images, video or audio. All pictures on the site are drawn from NASA SPHEREx data.
- **Human work:** the team chose the challenge, set the direction and the feature list, reviewed and tested the tool on the test targets, and is responsible for the submission.

No code from any earlier prototype was reused; this repository was started during the event.
