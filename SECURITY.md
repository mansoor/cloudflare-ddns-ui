# Security policy

## Reporting a vulnerability

Please **don't** open a public issue for a security problem.

Use GitHub's private reporting — **Security → Report a vulnerability** on
[the repository](https://github.com/mansoor/cloudflare-ddns-plus/security/advisories/new) — or email the
maintainer via their GitHub profile.

Include what you did, what happened, and what you expected. A proof of concept helps but isn't required.
This is a single-maintainer hobby project, so expect a first response in days rather than hours. I'll
confirm receipt, agree a fix and disclosure timeline with you, and credit you in the release notes unless
you'd rather stay anonymous.

## Supported versions

Only the **latest release** gets fixes. There are no backports to older tags — update to the newest
version before reporting.

## Trust model — read this before deploying

This app holds credentials that can change your DNS. Please deploy it accordingly.

**Secrets are stored in plaintext.** `data/config.json` contains your Cloudflare API tokens, and any
DDNS provider tokens/passwords, webhook URLs and heartbeat URLs — unencrypted. There is no master
password or key derivation; the app must be able to read them unattended to do its job. This matches the
reference `cloudflare-ddns` config-file model.

What that means in practice:

- Keep the `data` directory private (`chmod 700`, non-world-readable volume).
- Anyone with read access to that directory, the host, or a backup of it has your API tokens.
- A **config backup** downloaded from Settings contains those same secrets in plaintext, which is why the
  export is password-gated and warns you. Treat the downloaded file like a password file.

**Scope your Cloudflare token.** Create a token limited to the zones you actually manage, with only
`Zone:DNS:Edit` (plus `Account:Account Filter Lists:Edit` if you use the WAF feature). Don't use a Global
API Key — the app deliberately doesn't support them.

**Don't expose it directly to the internet.** It's designed for a LAN or a private network. There's a
single admin account, no MFA, and no rate limiting or brute-force lockout on the login endpoint. If you
need remote access, put it behind a VPN, or a reverse proxy that adds TLS and its own authentication.

**Session cookies** are signed with `SESSION_SECRET` (auto-generated into `data/.session-secret` if you
don't set one), `httpOnly`, `sameSite=lax`, and `secure` when served over HTTPS. Passwords are hashed
with bcrypt, but the admin password itself comes from an environment variable, so anyone who can read the
container's environment can read it.

**The container** runs the app as a non-root user and needs no extra privileges. Give it a plain bridge
network and the `/data` mount; nothing else.

## Out of scope

These are known and intentional, so please don't report them as vulnerabilities — though suggestions for
improving any of them are welcome as normal issues:

- Plaintext secrets at rest in `data/config.json` (above).
- A single admin account with no MFA and no login rate limiting.
- The password-gated config export returning secrets in plaintext — that's what a restorable backup is.
- Requiring the operator to trust whatever DDNS or webhook endpoint they configure; URLs you enter are
  requested as given.
