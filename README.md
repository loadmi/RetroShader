# RetroShader CRT

A Chrome extension that plays web video through a real-time WebGL2 CRT shader. You get the look of a 90s TV or a broadcast monitor on
YouTube, Twitch, Vimeo and most other sites. It reproduces the *picture* of a CRT (scanlines, phosphor mask, glow, analog colour) and
deliberately leaves out curvature, vignettes and bezels.

## Install (developer mode)

1. Open `chrome://extensions` and switch on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `extension` folder of this project.
3. Pin the extension (puzzle icon → pin), then reload any tab that was already open.
4. Play a video. The effect switches on automatically for the largest playing video on the page.

To watch local video files, also switch on **Allow access to file URLs** on the extension's details page.

## Using it

Click the toolbar icon for the popup:

- **Power switch**: turns the effect on or off everywhere.
- **Enabled on _site_**: turns it off for the current site only.
- **Compare**: the left half of the picture shows the original video.
- **Preset**: pick a starting point, then fine-tune with the sliders. Changed sliders get a dot, and **Reset to preset** clears them.
  **Advanced** shows the expert controls.
- The status box shows what the shader is doing. For example, "1920×1080 video → 2880×2160 px · 240 lines (9 px/line) · slot mask 6×6px · 60 fps".

Keyboard shortcuts (change them at `chrome://extensions/shortcuts`):

| Shortcut | Action |
|---|---|
| <kbd>Alt+Shift+C</kbd> | Effect on/off |
| <kbd>Alt+Shift+P</kbd> | Next preset |
| <kbd>Alt+Shift+X</kbd> | Before/after split |

### Presets

| Preset | Look |
|---|---|
| **Consumer TV** (default) | 90s living-room TV: soft glowing scanlines, slot mask, composite colour bleed. Dithering melts into transparency. |
| **Trinitron TV** | Aperture grille (vertical stripes), S-Video, slightly cool Japanese-TV white. |
| **PVM / BVM monitor** | Studio monitor over RGB: crisp pixels, deep black gaps between lines, fine grille. |
| **Arcade cabinet** | Low-resolution RGB arcade monitor: chunky lines, dot mask, punchy colour. |
| **Composite console** | Cheap composite cable with rainbow artifacts on stripes and dithering. |
| **Living-room TV (movies)** | For films and TV: 480-line interlaced look, gentle mask, warm glow. |
| **Subtle** | Just a hint of CRT. |

### Tips for the best picture

- **Watch fullscreen, or at least in theater mode.** Scanlines need roughly 4 or more screen pixels per line. At 240 lines that means a picture
  about 1000 px tall or more, where 4K fullscreen gives 9 px per line. On small embedded players the scanlines fade out automatically
  instead of making moiré.
- **Turn your monitor brightness up.** A real CRT darkens the picture with its mask and scanline gaps. The shader compensates, but some
  extra backlight helps a lot.
- **Keep Windows/browser zoom at a whole number if you can**, e.g. 100% or 200%. The phosphor mask is drawn on exact physical
  pixels, and the extension handles 125%/150% scaling, but whole-number scaling is the cleanest.
- **Game footage:** pick the original-resolution YouTube rendition (e.g. 1080p rather than an "enhanced" upscale). If the uploader already
  added scanlines, switch ours off (Scanlines → beam widths to max) or they will beat against each other.
- **Mask looks colourful or striped in the wrong way?** Your panel may use BGR subpixel order (Advanced → Screen subpixel order). OLED or
  scaled laptop screens can also fringe; try **Mask type → Mono grille** in that case.

## How it works

Everything runs on the GPU in **linear light**, with the video decoded using CRT gamma 2.4 and re-encoded for the display at 2.2:

1. **Resample**: the video frame is area-averaged onto a "virtual CRT raster". That is 240 lines by default, or the video's own height
   if it's 300 lines or less, and about 4 samples per colour-subcarrier cycle across. This undoes YouTube's upscaling of 240p footage.
2. **Signal**: RGB, S-Video, composite or RF. For composite, the colour really is QAM-modulated onto a carrier and decoded with a notch
   filter plus a chroma low-pass, just like a TV did. That makes dithering blend, colours bleed, and (optionally) rainbow artifacts appear.
   Saturation, white point and black level are applied here too.
3. **Horizontal beam**: each line is filtered with a Gaussian beam spot at the output width. Optional misconvergence shifts red and blue.
4. **Glow**: bloom (about 1 line) and halation (about 4% of the picture height) are blurred at low resolution.
5. **Composite** (the only full-resolution pass): brightness-dependent scanline beams integrated over each screen pixel (bright lines
   swell and merge, dark ones stay thin), an energy-conserving phosphor mask drawn on physical pixels (it redistributes light instead of
   darkening the picture), bloom and halation, per-channel soft clipping, and dithering.

The canvas is inserted right after the page's `<video>` element, so the site's own controls and subtitles stay on top and clicks pass
straight through. It redraws only when a new video frame arrives, e.g. 24 times per second for film.

Measured cost on an Intel Iris Xe laptop GPU, including the frame upload: about 3–4 ms per frame at 1080p and about 7 ms at full 4K
(3840×2160). That's comfortably inside a 60 fps budget.

## Limitations

- DRM-protected services (Netflix, Disney+, Prime Video…) cannot be processed. The browser blocks access to their pixels.
- Videos served from another domain without CORS headers can't be read by WebGL either. The extension then leaves them untouched and says
  so in the popup.
- Picture-in-picture shows the original video.
- Muted, looping videos without controls (page backgrounds, GIF-style clips) are skipped on purpose. Small muted hover previews are
  low priority, so the CRT stays on the video you're actually watching.

Fullscreen works both ways. YouTube, Twitch and Vimeo fullscreen their player container. Pages with the browser's native controls,
and local files, fullscreen the bare `<video>`; for those the CRT layer is lifted into the browser's top layer (Chrome 114+).
Native WebVTT subtitles are re-drawn above the CRT, and native controls show through while the video is paused or the mouse moves.

## Development

- `node test/serve.js` then open <http://localhost:8787/test/index.html>. This is a harness that runs the real content script and
  popup (with a small `chrome.*` stub) on generated test cards: 240p pixel art with dithering, 480p TV, and a 1080p scope film.
  `?mode=240p|480p|1080p`, `?size=WxH`, `?src=/path/to/video`.
  `test/native.html` is a plain `<video controls>` with a WebVTT track. Use it to test native subtitles and bare-video fullscreen.
- `node tools/make-icons.js` regenerates the icons.

## Credits

The algorithms follow published work by the CRT-shader community. The code is original and no shader source was copied:

- Timothy Lottes (public-domain CRT shader, masks)
- guest.r (crt-guest-advanced: brightness-dependent beams, mask and glow ideas)
- TroggleMonkey (CRT-Royale: beam integration over the pixel, bloom as energy recovery)
- Hyllian and EasyMode (resampling and mask approaches)
- Themaister/blargg (NTSC signal simulation)
- hunterk (subpixel mask catalogue)
- RetroTINK (energy-conserving "spatial redistribution" masks)
