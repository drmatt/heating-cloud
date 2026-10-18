# Tests

`api.test.mjs` checks the database rules against a local Supabase: registering
and claiming a controller, syncing, and that customers can only see and change
their own home.

```bash
supabase start
supabase functions serve   # in another terminal
node tests/api.test.mjs
```

Local test account used when trying the dashboard by hand (local Supabase only):
`test-customer@example.com` / `local-test-pass-1`
