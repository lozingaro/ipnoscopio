# Ipnoscopio

Oscilloscopio analogico simulato — plain HTML/CSS/JS (`index.html` + `styles.css` + `app.js`), nessun build, zero dipendenze.

**Live:** <https://lozingaro.github.io/oscilloscope>

## Funzionalità

### Due canali (CANALE UNO · L / CANALE DUE · R)

Ogni canale ha:

- **Sorgente:** SINTETIZZATORE (additivo), MICROFONO, LINEA (ingresso audio esterno con selettore dispositivo e canale)
- **Sintesi additiva:** fino a 4 oscillatori per canale, ognuno con FREQUENZA (20–2000 Hz), AMPIEZZA (0–1) e FASE (0–2π, mostrata in multipli di π)
- **Forma d'onda:** SENO, QUADRA, DENTE, TRIANGOLO
- **GUADAGNO** (×0.1–×10)
- **Pannello VISIVO:** SU-GIÙ (offset verticale), ASSE X/Y (solo in modalità X VS Y), selezione COLORE (8 colori)

### Mixer

Fader di volume + pulsante SUONA/ZITTO per ogni canale, più master volume e mute.

### Modalità display

| Pulsante | Descrizione |
|----------|-------------|
| **ONDA** | Dominio del tempo (time domain), una traccia per canale |
| **X VS Y** | Lissajous — un canale sull'asse X, l'altro sull'asse Y |

### Ergonomia slider

- **Snap magnetico** verso valori notevoli (configurato via `data-snap`)
- **Doppio tap** → reset al valore di default (`data-default`)
- **Click sul valore** → modifica diretta (contentEditable, conferma con Invio)

### Altre funzionalità

- **GIGANTE** (fullscreen) con barra mini-controlli auto-nascondente (stile YouTube)
- **VAI / FERMA** — avvio e pausa dell'acquisizione
- Trigger su zero-crossing per visualizzazione stabile in modalità ONDA
- CRT phosphor afterglow, scanline orizzontali, vignette
- Microfono: fallback progressivo su sample rate (44.1/48 kHz), funziona su iOS Safari
- Layout mobile-first, responsive a due colonne su desktop (≥ 860 px)
- Stile visivo fumettistico: Dr. Pira / *Fumetti della Gleba*

## Eseguire in locale

Apri `index.html` in qualsiasi browser. L'ingresso microfono e LINEA richiedono HTTPS (o `localhost`).

## Credits

- Ispirato a [osci-render](https://osci-render.com) di James H. Ball (GPLv3)
- Stile visivo: [Dr. Pira / Fumetti della Gleba](https://fumettidellagleba.org)

## Licenza

[GPLv3](LICENSE)
