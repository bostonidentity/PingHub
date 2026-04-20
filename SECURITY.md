# Security Policy

## Reporting a Vulnerability

**Please do not open public GitHub issues for security vulnerabilities.**

If you believe you have found a security issue in PingHub, report it privately so we can triage and fix it before disclosure.

Report by emailing: **security@bostonidentity.com**

Please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, ideally a minimal proof-of-concept.
- The commit hash, tag, or version you tested against.
- Any suggested remediation, if you have one.

We aim to acknowledge new reports within **3 business days** and to provide a first status update within **10 business days**. Timelines for a fix depend on severity and complexity; we'll keep you informed throughout.

## Scope

In scope:

- The PingHub web application (code in this repository).
- Vendored source under `src/vendor/` as included in a PingHub release.

Out of scope:

- Third-party dependencies — please report those upstream. If the issue is exploitable specifically through PingHub's usage, we still want to know.
- Vulnerabilities in Ping Advanced Identity Cloud itself — report those to Ping Identity.
- Issues in your own tenant configuration or service-account credential hygiene.

## Coordinated disclosure

We ask that you give us reasonable time to ship a fix before publicly disclosing details. Once a fix is released, we're happy to coordinate on an advisory and credit you by name (or a handle) if you'd like.

## Safe-harbor

Good-faith security research that complies with this policy will not be pursued as a violation of applicable computer-use laws. This explicitly does not authorize:

- Testing against tenants or systems you don't own.
- Destructive testing, data exfiltration, or denial-of-service.
- Social engineering of maintainers or users.
