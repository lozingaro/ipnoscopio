# DIDASCOPE

Analog oscilloscope simulator — plain HTML/JS, zero dependencies.

**Live:** <https://scope.didaflow.ai>

## Run

Open `index.html` in any browser. No build step, no server needed.

For mic input on iPhone, HTTPS is required — GitHub Pages provides it automatically.

## Deploy

Push `index.html` to a GitHub repo, enable Pages from Settings → Pages → main → / (root).

For a custom domain (`scope.didaflow.ai`), add a CNAME record on Hetzner DNS:

|Type |Name   |Value                |
|-----|-------|---------------------|
|CNAME|`scope`|`lozingaro.github.io`|

Then set the custom domain in Settings → Pages.
