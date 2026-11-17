# Google Drive and phone capture (browser version)

The browser version can optionally use the user's **own** Google Drive to

* save experiments (per experiment, or all of them) and load them on another computer;
* auto-save an experiment every time a plate is saved;
* send photos taken with a phone (**Capture**) to `AntibiogramJ/Inbox`, and analyse them later on a computer
  (**Inbox** → *Analyse* opens the wizard with the photo and organism data; after saving, the photo goes to
  `Inbox/Processed`).

The **Inbox** also has a local import queue (no cloud) for photos copied to the computer by other means.

## How it works

* Sign-in: [Google Identity Services](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
  token client. `accounts.google.com/gsi/client` is loaded only when the user clicks *Connect Google Drive*.
  The access token (≈1 h) is kept in memory only; when it expires the app asks the user to reconnect and keeps
  pending work (auto-saves, photo uploads) queued.
* Scope: `https://www.googleapis.com/auth/drive.file` only (non-sensitive): the app sees only files it created.
* Drive REST API v3 from the browser (`src/browser/drive.ts`, tested by `npm run test:drive`).
* Layout in Drive:
  ```
  AntibiogramJ/
    Backups/   <experiment>.antibiogramj.json          one file per experiment, updated in place
               All experiments <date>.antibiogramj.json  "Save all" (new file each time)
    Inbox/     <date> <organism> <id>.jpg / .json (sidecar) [/ original.<ext>]
      Processed/
  ```
* Backups use the same format as *Back up* to a file. Experiments have a stable `uid`; loading never overwrites
  (an experiment already present is added as a copy).
* Conflicts: each device remembers the Drive `version` of the files it wrote/read. If the file changed in Drive
  since (another computer saved it), the device writes a separate `(conflict, <device> <date>)` copy instead.
* Captures: photos are downscaled to 3000 px JPEG (the original can be added); the JSON sidecar (organism,
  strain, sample, notes, device, date, small thumbnail) is uploaded last and marks the capture complete. Uploads
  are queued in IndexedDB (`antibiogramj-capture` database) and retried when back online; interrupted uploads
  reuse the parts already sent.

## Google Cloud setup (owner of the deployment)

1. Create a project at <https://console.cloud.google.com/> and enable the **Google Drive API**.
2. OAuth consent screen: *External*; app name, support and developer e-mails; scope `.../auth/drive.file`;
   publishing status *Testing* with the test users' Gmail addresses (max. 100).
3. Credentials → *OAuth client ID* → *Web application*, authorised JavaScript origins
   `https://joheras.github.io` and `http://localhost:8090` (no redirect URIs; no client secret is used).
4. Put the client ID (public, not a secret) in `frontend/.env.browser` as `VITE_GOOGLE_CLIENT_ID`.
5. To leave *Testing* (so anyone can sign in without the "unverified app" warning) Google verifies the brand:
   home page `https://joheras.github.io/antibiogramj-web/`, privacy policy
   `https://joheras.github.io/antibiogramj-web/privacy.html` (linked from the app footer), the domain verified in
   Google Search Console by a project owner, and optionally a logo. `drive.file` needs no scope verification.

Local testing with the real client ID: `npm run build:browser` and serve `dist-browser/` at
`http://localhost:8090` (e.g. `python3 -m http.server 8090 --directory dist-browser`); open it as `localhost`,
not `127.0.0.1`.
