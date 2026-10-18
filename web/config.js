// Supabase project the dashboard talks to. The publishable (anon) key is
// meant to be public: what each user can do is enforced by row-level
// security in the database, not by keeping this key secret.

const LOCAL = {
  supabaseUrl: "http://127.0.0.1:54321",
  supabaseKey: "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH", // the CLI's fixed local key
};

const PRODUCTION = {
  supabaseUrl: "https://obphhqliecczbghbpqiv.supabase.co",
  supabaseKey: "sb_publishable_weZtIFZPwAfY2dzDo7HfAA_wfNBwERP",
};

const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);

export const config = isLocal ? LOCAL : PRODUCTION;
