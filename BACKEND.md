# HEARNEST local backend

## Start

On Windows, double-click `start-backend.cmd` and keep its window open. This launcher works even when PowerShell scripts are disabled. Alternatively, run `node backend/server.cjs` using Node 24 or newer. No npm packages need installing. Open **http://localhost:3000** instead of double-clicking HTML files. The existing MP3s and all app pages are served by the same process.

## Implemented

- Email/password sign-up with saved name, age, and hearing-age units.
- Login at `login.html`, persistent JSON accounts, expiring server-side sessions, and logout from Settings.
- Salted scrypt password hashes, random HttpOnly session cookies, signed CSRF tokens, origin validation, login/signup rate limits, and private data/source-file boundaries.
- Authenticated learner names appear on Home and Settings. Stage 1 and its instructions are always open. Later lesson/instruction pages require a signed-in account and the saved hearing-age threshold.

Passwords and session tokens are not stored in localStorage. The private data file is `backend/data/hearnest.json`; keep this directory private. A server restart preserves accounts and unexpired sessions.

## Apple and Google

The buttons now contact backend endpoints and show their setup status. They **do not authenticate** with Apple or Google yet. `/api/auth/apple` and `/api/auth/google` return a clear 503 response until provider integration is implemented and tested. There are no placeholder secrets or fake provider sessions.

The next step needs registered provider applications, client identifiers, a configured callback URL, and server-side credentials. Apple also requires its developer configuration/signing key. Keep secrets outside public assets. Use the official provider SDK/flow when implementing callbacks:

- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developer.apple.com/documentation/signinwithapplerestapi

## API

- `GET /api/auth/session` returns the signed CSRF token and current user, if any.
- `POST /api/auth/signup` creates an account and session.
- `POST /api/auth/login` signs in with email/password.
- `POST /api/auth/logout` revokes the current session.
- `GET /api/auth/providers` reports provider availability.

POST requests require JSON, the app Origin, and an `X-CSRF-Token` from the session endpoint. Cookies are sent with same-origin requests.

## Local use and deployment

`PORT` defaults to 3000 and `HOST` to 127.0.0.1. For a trusted LAN device, explicitly set `HOST=0.0.0.0` and `APP_ORIGIN=http://YOUR-LAN-IP:3000`, then open that exact address. This exposes the development server to that network; use local test accounts there.

For a deployed environment, set `NODE_ENV=production` and an HTTPS `APP_ORIGIN`, and terminate HTTPS at a configured reverse proxy preserving the original Host. This enables Secure cookies. This is a local authentication foundation, not a finished production identity service: email verification, password-reset delivery, account deletion, profile editing, OAuth callbacks, and production operational controls still need implementation. Existing preview controls for those features remain previews.

## Tests

Run `node --test backend/auth.test.cjs` or `npm test`. Tests use isolated temporary JSON files, not the app database.

Implementation references: https://nodejs.org/docs/latest-v24.x/api/fs.html and https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html

## Hearing-age stage access

Stages unlock cumulatively at 0, 4, 7, 10, 13, 16, and 19 months of hearing age. The saved hearing age is converted from years to months when needed; chronological age does not determine access. Earlier stages stay available for practice. Stage 1 is always open, including without an account. Missing or invalid hearing ages leave Stages 2-7 locked.

`GET /api/stages` returns the current account access. Home shows eligibility and locks; direct lesson/instruction URLs are checked by the backend. Stage 4â€“7 cards show Coming soon once eligible until their lesson files exist. New accounts default to locked controls until the server confirms their saved profile.
Temporary override: Stages 1, 2, and 3 are currently open to everyone for testing. Hearing-age requirements still apply to Stage 4 onward.

## Word counters and real activity

Word counters derive their totals from the buttons in each lesson (currently 8, 22, and 16). A different sound counts after playback finishes naturally without being muted. Stopping playback early or a playback error does not count. A replay increases completed playbacks/replays, but never unique words.

- Learning: different completed sounds divided by all implemented lesson sounds.
- Games: fully completed sound stages divided by implemented sound stages.
- Videos: 0% until video activities exist.
- Overall progress: the Learning percentage.

These are interaction measures, not assessments of learning mastery. Activity details show stage counts, total playbacks, and replays.

Guests save progress on the current device. Signed-in users save activity to JSON, with account-specific caches and retry queues. Guest progress does not automatically enter a new account. Event IDs deduplicate retry requests; requests verify the expected account ID so switching users cannot save activity to the wrong account. Existing stage eligibility is independent of completion, and Stages 1-3 remain temporarily open for testing.

`GET /api/progress` returns the catalog and current account summary. `POST /api/progress` records a completed playback with the existing JSON/Origin/CSRF requirements. Private learning_events rows are not served as public files.

Run `npm test` for account, stage-access, and progress tests. `tools/check-progress-browser.cjs` additionally checks actual playback completion, counters, activity rings, and responsive layouts with isolated browser test accounts.
Playback controls now display a relative 0-100 dB scale: 0 is silence and 100 is the original recording level. Values use 10^((level-100)/20) amplitude conversion, capped at unity. Actual acoustic loudness requires device calibration. The previous default volume is preserved at 96.5 on this scale.

## JSON storage

All server-managed accounts, hashed passwords, hashed sessions, and signed-in learning events are stored in `backend/data/hearnest.json`. This file is private and excluded from public serving and Git. Passwords are salted hashes, never plain text. Guest progress and theme preferences remain device-local.

Use one server process per JSON file. Writes use a flushed temporary file and atomic replacement. Stop the server before manually editing or backing up the file. Invalid JSON prevents startup rather than resetting accounts. JSON storage suits this local prototype; it is not designed for multiple server instances or large traffic.

The server and its JSON storage module are still required: browser HTML cannot securely write a shared account JSON file. Start the app as above and use http://localhost:3000. Apple and Google still need provider setup.

## Frontend file structure

Each HTML page contains its CSS in labeled `<style>` blocks and browser JavaScript in labeled `<script>` blocks. The original source names are preserved in `data-source` attributes to make sections easy to find. Scripts that need the page DOM run at the end of the body, in their original order. Theme restoration stays in the head before the first paint. External frontend CSS/JS files have been removed.

The server authorizes embedded styles/scripts using exact Content-Security-Policy SHA-256 hashes computed from each HTML response. It still stores private account data outside the public file allowlist. Backend `.cjs` files are server code and must remain external. MP3/image assets remain separate so sound paths can still be replaced manually.

## Vercel deployment

See DEPLOY-VERCEL.md. Deployed accounts use Upstash Redis rather than a local writable JSON file. Local operation remains unchanged.
