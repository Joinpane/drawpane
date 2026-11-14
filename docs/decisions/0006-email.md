# 0006. Email: one sender interface, many providers, nothing required

- Status: accepted
- Date: 2026-11-14
- Deciders: Ziyang (lead maintainer)

## Context

The PRD's v0.1 collaboration row promises "Comments, mentions, resolve; email digests". The inbox (in the app) tells people about mentions, replies and resolved threads, but only while they're in Drawpane. Email reaches them when they aren't, and is also how invites usually travel.

Drawpane is self-hosted: whoever runs it chooses where email goes, and many will want none at all. Email is never required to sign in (passkeys and providers are), so an instance without email loses nothing but the reminders.

The maintainer's direction: support as many providers as is sensible, since people bring the email setup they already have.

What a Worker can send through (November 2026):

| Way | How | Notes |
| --- | --- | --- |
| Cloudflare Email Service | `send_email` binding | In beta. Sends to anyone once a sending domain is onboarded, on Workers Paid; before that, only to verified addresses. No key to manage. |
| Resend, Postmark, SendGrid, Mailgun, Amazon SES | HTTPS API with a key | The common transactional providers. Each a few dozen lines over `fetch`; SES needs SigV4 signing. |
| SMTP | TCP sockets (`cloudflare:sockets`) with STARTTLS | Any mail server people already have: Google Workspace, Microsoft 365, Fastmail, their own. |

## Decision

**One small interface, `EmailSender`, with an adapter per way of sending.** The rest of Drawpane only ever builds a message (to, subject, plain text, HTML, headers) and hands it over.

- Adapters: `cloudflare`, `resend`, `postmark`, `sendgrid`, `mailgun`, `ses`, `smtp`, plus `log` (for development: prints instead of sending) and `off` (the default).
- Chosen with `EMAIL_PROVIDER`, from `EMAIL_FROM` (a verified sender, like `Drawpane <design@example.com>`). Keys and passwords are Worker secrets (`EMAIL_API_KEY`, or `SMTP_URL`), never vars.
- The installer asks how to send email (default: not at all), stores secrets with `wrangler secret`, and `upgrade` keeps them. The health page shows how email is set up, and an admin can send a test.

**What sends email**, built on the inbox's `notifications` rows (decision: the inbox already records what someone should hear about):

1. **Mentions and replies**, batched: a Cron Trigger every few minutes collects notifications that are still unread after a short grace period (read in the app means already seen: no email), and sends one email per person listing them, linking each to its comment. A row is marked `emailed_at` so it's sent once.
2. **A daily digest** instead, for those who prefer it: the same, once a day at an hour they pick, in their time zone.
3. **Invites by email**: an owner can send the invite link to an address, besides copying it.

**People choose** in Account settings: mentions and replies as they happen (batched), a daily digest, or no email. Every email has a one-click unsubscribe (RFC 8058 `List-Unsubscribe` with a signed link), and says why it was sent.

No queue service: a Cron Trigger and D1 are enough at a team's volume and stay on the free plan. Sending is idempotent per notification (claim, send, mark), and a failure leaves the row to retry, with a cap.

## Consequences

- A new `email/` module in the Worker: the interface, the adapters, message templates (plain text first, a simple HTML twin), and the cron job. Each adapter is tested against a fake HTTP server or socket.
- New columns: `notifications.emailed_at`; on users, an email preference, digest hour and time zone. New secrets and vars in the installer's prompts and the self-hosting guide.
- Deliverability (SPF, DKIM, DMARC) is the sending provider's job; the docs say what each needs, and the health page's test email makes problems visible early.
- Adapters are small and independent, so adding another provider later is one file and its tests.
