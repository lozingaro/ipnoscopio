# Oscilloscopio della Gleba

Analog oscilloscope simulator — plain HTML/CSS/JS (`index.html` + `styles.css` + `app.js`), no build step, zero dependencies.

**Live:** <https://lozingaro.github.io/oscilloscope>

## Features

- **2 channels** (CH1 / CH2), each with its own colour, frequency, amplitude, gain and Y-offset
- **Synth waveforms:** sine, square, sawtooth, triangle
- **Microphone input** with trigger sync (progressive `getUserMedia` fallback, works on iOS Safari)
- **Display modes:**
  - `WAVE` — time domain
  - `DOT` — single moving point
  - `XY` — Lissajous (channel X vs channel Y)
  - `DRAW` — sketch a shape, turn it into a looping stereo signal (L=X, R=Y) and watch it traced in XY
- Global timebase, noise and trigger-level controls
- Phosphor CRT afterglow, scanlines and vignette
- Dr. Pira / *Fumetti della Gleba* comic-strip visual style
- Mobile-first, responsive layout

## Run locally

Just open `index.html` in any browser. Microphone input requires HTTPS (or `localhost`).

## Roadmap

- SVG upload → XY audio
- XY audio effects (rotation, scale, wobble LFO)
- Image upload → edge detection → XY audio

## Credits

- Inspired by [osci-render](https://osci-render.com) by James H. Ball (GPLv3)
- Visual style: [Dr. Pira / Fumetti della Gleba](https://fumettidellagleba.org)

## License

[GPLv3](LICENSE)
