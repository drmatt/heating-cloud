# Heating cloud

The online dashboard for the heating controller. Customers create an account,
connect their controller (a Raspberry Pi) with the code on its label, and
control their heating from anywhere.

- `web/`: the dashboard, a static site published to GitHub Pages
- `supabase/`: the database (accounts, homes, zones, schedules, sensors,
  readings) and the function that registers new controllers
- `tests/`: checks that each customer can only see and change their own home

The controller software lives in the private `drmatt/heating` repository
(`server/cloud-connector.js`).

## How it fits together

```
Customer's browser ──▶ GitHub Pages (web/)
        │
        ▼
     Supabase  ◀── controller connects out every 15 s: reports state,
        ▲          gets zones/schedule/sensors, uploads readings,
        │          runs commands such as Bluetooth pairing
        │
 Raspberry Pi in the house ──▶ boiler relays (runs locally, even offline)
```

- The controller never accepts incoming connections, so customers need no
  router set-up.
- The heating runs from the controller's own database. If the internet is
  down it keeps following the last schedule it received.
- Each controller is its own Supabase user, created by the
  `register-controller` function. Row-level security lets a customer see only
  their own home, and a controller only the home it has been claimed by.
- The cloud never changes which relay a zone uses.

## Setting up a Supabase project

1. Create a project at supabase.com.
2. Link this folder and apply the database and function:
   ```bash
   supabase login
   supabase link --project-ref <project-ref>
   supabase db push
   supabase functions deploy register-controller --no-verify-jwt
   ```
3. In Authentication → URL Configuration, set the Site URL to the dashboard's
   address (for example `https://<user>.github.io/heating-cloud/`) and add it
   to the redirect URLs.
4. Put the project URL and publishable key in `web/config.js` under
   `PRODUCTION`. The publishable key is meant to be public.

## Publishing the dashboard

Pushing changes under `web/` to `main` runs `.github/workflows/pages.yml`,
which publishes the folder to GitHub Pages. Turn Pages on under
Settings → Pages → Source: GitHub Actions.

## Local development

```bash
supabase start
supabase functions serve          # in another terminal
cd web && python3 -m http.server 3000
node tests/api.test.mjs
```

`web/config.js` uses the local Supabase automatically on `localhost`.

## Licence

No licence is granted. All rights reserved.
