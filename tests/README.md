# Tests

    npm test               engine, launcher, flight and tester checks (Node only)
    npm run test:browser   the same, plus every page in a real browser (needs `npm install`
                           and `npx playwright install chromium` once)

- `engine.test.js` — every search result, bit for bit, against digests recorded from the
  engine the in-game checks were made with (`golden/search.json`, `make-golden.js`).
- `launch.test.js` — the launcher, run in full, lands the cart where the search assumes.
- `flight.test.js` — the flight rules against ticks 1–18 of the challenge's recorded run.
- `tester.test.js` — every "Download with tester" build is clean; hand-placed testers are
  byte for byte as recorded (`node tests/tester.test.js --record` after a deliberate change).
- `browser/` — the finder, the 3D viewers and the homepage in Chromium.

GitHub runs all of them on every push and pull request (`.github/workflows/tests.yml`).
