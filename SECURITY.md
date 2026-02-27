# Security Policy

## Reporting a Vulnerability

Please do not open public issues for suspected vulnerabilities.

Use one of these private channels:

1. GitHub Security Advisories for this repository (preferred).
2. Directly contact repository maintainers if advisory tooling is unavailable.

Include:

- affected workflow/script path
- impact and exploitability
- reproduction steps
- suggested mitigation (if available)

## Response Expectations

- Initial triage acknowledgment: target within 3 business days.
- Confirmed issues are prioritized based on severity and exploitability.
- Fixes are released with updated docs when behavior changes.

## Scope Notes

This repository is a reusable GitHub workflow and Node runtime scripts. Reports in scope include:

- trust-boundary violations (base vs head revision handling)
- unsafe path handling or command injection
- incorrect permission/authorization behavior in GitHub API operations
- signature bypasses for prior finding memory trust
