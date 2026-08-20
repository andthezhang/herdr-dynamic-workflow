# Security policy

Herdr plugins run as the current user. They inherit the user's environment and
can call the full Herdr CLI. This plugin is not sandboxed.

## Report a vulnerability

Please do not open a public issue for a suspected vulnerability. Use
[GitHub private vulnerability reporting](https://github.com/andthezhang/herdr-dynamic-workflow/security/advisories/new)
and include reproduction steps, affected versions, and the expected impact.

Security fixes target the latest release. Older versions may not receive a
backport.
