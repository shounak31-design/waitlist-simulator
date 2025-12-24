# Security Policy

## Supported Versions

This is a static, client-side demo hosted on GitHub Pages (HTML/CSS/JS).
There is no server component and no user accounts. Updates are applied to the `main` branch.

| Version | Supported |
| ------: | :-------- |
| latest  | ✅        |
| older   | ❌        |

## Reporting a Vulnerability

If you believe you have found a security issue, please report it responsibly.

**How to report**
- Open a GitHub issue titled: **[SECURITY] <short description>**
- Include:
  - Steps to reproduce
  - Expected vs actual behaviour
  - Browser + OS
  - Screenshots or a short screen recording (if helpful)

**What to report**
- XSS or HTML/JS injection issues
- Dependency/CDN concerns (e.g., Chart.js)
- Unexpected data persistence or leakage

**What not to report**
- Issues requiring access to private systems or user accounts (none exist)
- Reports involving patient data (this project uses synthetic data only)

**Response timeline**
I will acknowledge reports within **7 days** and aim to provide a fix or mitigation within **30 days**, depending on severity and complexity.

## Scope & Data

- This project is a **synthetic waitlist simulation** for service planning demonstrations.
- **No patient data** is collected, stored, or processed.
- All computations run locally in the user’s browser.
