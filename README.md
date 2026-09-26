# MARIO_Method

A local TikTok video composer powered by PostPeer. It supports account connection, a local video preview, Public/Friends/Private audience choices, immediate publishing, scheduling, and TikTok comment/Duet/Stitch controls.

## Run locally

Install Python 3.10 or newer. No Python packages are required.

In PowerShell, start the local server:

```powershell
python server.py
```

If `POSTPEER_API_KEY` is not already set, the server prompts for it in the terminal with hidden input. The key is held only in the server process environment; it is not saved to a project file or sent to browser JavaScript. The **Verify API Key** control checks it with PostPeer before account connection. The integrations link opens <https://www.postpeer.dev/dashboard/integrations>.

Open <http://127.0.0.1:4173>. The server binds to loopback only. Do not expose this posting proxy to the public internet: public hosting needs additional user authentication, authorization, CSRF protections, and deployment-specific secret management.

## Publishing flow

1. Select **Connect TikTok** and complete PostPeer's OAuth flow.
2. Select a connected TikTok account and wait for its creator-specific privacy options.
3. Choose a video, caption, audience, and immediate or scheduled delivery.
4. Confirm the review checkbox, then publish.

MARIO_Method requests a presigned media URL from PostPeer, uploads the selected video directly to that URL, and asks PostPeer to publish or schedule the resulting public media URL. Friends maps to PostPeer's `MUTUAL_FOLLOW_FRIENDS`; Private maps to `SELF_ONLY`. Available privacy options and maximum video duration depend on the connected TikTok account.

If the server is unavailable, the interface remains viewable but posting and account connection are disabled. API details: <https://www.postpeer.dev/docs/platforms/tiktok>.

## Deploy publicly on Render

1. Push this project to a private GitHub repository and create a Render Blueprint from that repository using `render.yaml`.
2. In the Render service environment, set `POSTPEER_API_KEY` from your PostPeer dashboard and choose a unique `MARIO_ACCESS_PASSWORD` of at least 16 characters. Never commit either value.
3. Deploy the service. The site can be browsed publicly, but TikTok account connection and publishing require the password. Sessions expire after 12 hours and are cleared when the service restarts.
4. In Render's custom-domain settings, add `mario.method` and create the DNS record Render specifies at your domain registrar. Wait for Render to issue its TLS certificate before sharing the URL.

The server refuses public binding unless `MARIO_ACCESS_PASSWORD` is configured. It uses same-origin checks, HttpOnly/SameSite session cookies, and throttles repeated failed sign-ins. Do not change `HOST` to `0.0.0.0` outside a protected deployment.
