# Privacy Policy - Unraid Dash

**Last updated:** March 14, 2026

## Data Collection

Unraid Dash does **not** collect, transmit, or store any personal data externally. All data remains on your local machine and your local network. Period.

## How It Works

The extension communicates exclusively with the Unraid server addresses you configure. All API calls use the Unraid GraphQL API over your local network. The background service worker handles all network requests to avoid CORS restrictions -- no data passes through any external proxy or relay.

## What Is Stored Locally

The extension uses your browser's local storage (`chrome.storage.local`) to persist:

- **Server configurations** -- display name, URL, and API key for each server
- **UI preferences** -- theme (dark/light), auto-refresh interval, card visibility, collapsed card state
- **List settings** -- sort order, visible count, and custom order for Docker and VM cards
- **Docker URL overrides** -- custom WebUI URLs for individual containers

These are stored locally in your browser and are **never transmitted** to any external server.

## API Key Storage

Your Unraid API keys are encrypted at rest using **AES-256-GCM** via the Web Crypto API before being stored in `chrome.storage.local`. This data is:

- **Encrypted at rest** -- API keys are encrypted with AES-256-GCM before storage
- **Local only** -- never transmitted outside your device
- **Isolated per-extension** -- other extensions cannot read it

For additional security:
- Use a dedicated, least-privilege API key for this extension
- Revoke the key from the Unraid WebGUI at any time if you suspect compromise
- Remove servers from the extension settings when not in active use

## No External Servers

This extension does **not**:

- Send data to any external server or third-party service
- Use analytics, tracking, or telemetry of any kind
- Collect login credentials, tokens, or session data beyond the API keys you explicitly provide
- Store or cache any server metrics beyond the current popup session

## Permissions

| Permission | Purpose |
|------------|---------|
| `storage` | Save server configurations, UI preferences, and URL overrides locally |
| `alarms` | Periodic badge updates for unread notification counts |
| `optional_host_permissions (http/https)` | Connect to your Unraid servers. Granted per-server when you add one -- you control exactly which hosts the extension can access. |

All permissions are used exclusively for the extension's core functionality as described above.

## Open Source

This extension is fully open source. You can audit the complete source code at:

https://github.com/alien4u/unraid-dash

## Contact

If you have questions or concerns about this privacy policy, please open an issue on the GitHub repository.

---

*by Alien Technology LLC*
