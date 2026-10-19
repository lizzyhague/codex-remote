# Security policy

English | [中文](SECURITY.zh-CN.md)

## Reporting a vulnerability

Please use the GitHub repository's private **Report a vulnerability** entry first. Do not paste exploit details,
access tokens, host names, project paths, logs or session content into a public issue.

If private reporting is not enabled yet, open an issue without technical details asking the maintainer for a
private contact. The maintainer will do their best to acknowledge reports, but the project currently promises no
fixed response time.

## Security model

Codex Remote is a single-user, self-hosted tool. It provides no multi-user accounts, MFA, per-user authorization,
token expiry or audit system. Whoever can use the application can drive Codex on the host, so the impact of a
leaked token depends on:

- the permissions of the system account running Codex Remote;
- the configured project roots;
- Codex's current permission profile;
- whether the network entry point adds further restrictions such as Tailscale, an identity proxy or a firewall.

The service always listens on `127.0.0.1`. Remote access must go through a controlled HTTPS entry point, not by
changing the source or mapping ports to expose the chosen loopback port to the public internet.

By default, Codex Remote neither overrides Codex's permission configuration nor forces full access on. A deployer
who raises permissions also takes on the larger risk of a leaked token.

## Secrets

Do not commit the following to the repository or attach them to public reports:

- `CODEX_REMOTE_TOKEN`;
- Codex sign-in credentials and configuration;
- the real project allowlist;
- reverse proxy private keys;
- logs and screenshots containing project names, session content, absolute paths or environment variables.

Original files, SHA-256 digests, original file names, bindings and the SQLite index kept by the shared attachment
service are sensitive data too. Only the service account should be able to access the attachment directory,
database and Unix socket; the Remote backend may return only the attachment ID, name, size and type to the browser,
never absolute server paths. The upload entry point must keep going through Remote's sign-in check and one-time
ticket, and the shared service's Unix socket must not be forwarded to the network.

The Codex adapter puts the real attachment paths in a private App Server text block. That block must be removed
from live browser events, history responses and public logs; the page shows only original attachment names. Real
paths appear only in CLI input and the private attachment index. File names and file contents are untrusted user
data, and text in them must not be promoted to system instructions.

If you suspect a token has leaked, generate a new token at once, update the service environment and restart the
service; every sign-in cookie issued under the old token becomes invalid with it. Removing a secret from Git does
not replace rotating a credential that has already leaked.
