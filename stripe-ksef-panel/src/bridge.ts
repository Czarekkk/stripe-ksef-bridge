/**
 * URL Twojego wdrożonego mostu `stripe-ksef-bridge` (np. Railway / własny host).
 *
 * USTAW przed `stripe apps upload`. Ten sam host MUSI być wpisany w `stripe-app.json`
 * (`ui_extension.content_security_policy.connect-src`) — inaczej Stripe zablokuje zapytania panelu.
 *
 * Set this to your deployed bridge URL before uploading the app, and mirror the host
 * in `stripe-app.json` connect-src.
 */
export const BRIDGE_URL = "https://your-bridge.example.com";
