> **Disclaimer:** This is a personal project shared under the [FSL-1.1-MIT License](LICENSE). It is not affiliated with, endorsed by, or sponsored by Lime Technology, Inc. (the makers of Unraid). Use it as you see fit, at your own risk.

---

# Unraid Dash

**Monitor your Unraid servers at a glance: system metrics, array status, Docker containers, VMs, and notifications in a single popup.**

![Version](https://img.shields.io/badge/version-1.3.0-blue)
![License](https://img.shields.io/badge/license-FSL--1.1--MIT-green)
![Manifest](https://img.shields.io/badge/manifest-v3-orange)

## 🏪 Store Availability

| Store | Version | Link |
|-------|---------|------|
| Chrome Web Store | v1.2.0 | [Install](https://chromewebstore.google.com/detail/agdbddldhhjehjplobapnnpijojcaafk) |
| Edge Add-ons | v1.2.0 | [Install](https://microsoftedge.microsoft.com/addons/detail/unraid-dash/mkejneiecljggcdblblgpcfoaipjdpie) |
| Firefox Add-ons | v1.2.0 | [Install](https://addons.mozilla.org/en-US/firefox/addon/unraid-dash/) |

## 📖 Overview

Unraid Dash is a browser extension that gives you a quick dashboard view of your Unraid 7.x servers without opening the WebGUI. Click the extension icon to see CPU, RAM, disk health, running containers, VMs, and unread notifications, all fetched live from the Unraid GraphQL API.

Supports multiple servers, configurable auto-refresh, per-card visibility and sort settings, container/VM start-stop and resume controls, a More menu with container restart and pause and VM restart, container updates, parity check status, temperatures, container WebUI links, a refresh error strip, notification archiving, and light/dark themes.

## ✨ Features

### 📊 Dashboard Cards

- **System** - CPU brand, cores/threads, total memory, CPU and RAM usage bars, uptime, server version, and LAN IP address. Temperature summary (average, hottest, warning/critical sensor counts) on API 4.37.6+, computed from the temperature sensors only. Clickable server name links directly to the WebGUI.

- **Array** - Array state, total capacity with usage bar, per-disk health indicators with temperature and error counts, parity and cache pools. Hard drive chips turn orange/red at Unraid's default disk temperature warning/critical thresholds (SSD/NVMe chips are not colored by temperature, as their thresholds are not available from the API). Parity check status: progress and speed while running, paused state, or the last check result.

- **Docker** - All containers with running/stopped/paused status, start/stop/resume controls, and a More menu with Restart (API 4.36+) and Pause (API 4.30+). WebUI links from the Unraid template (API 4.30+) with port detection as fallback, per-container URL overrides, update indicators, and one-click Update or Update all (API 4.30+, admin key); progress is restored when the popup is reopened.

- **VMs** - All virtual machines with running/stopped/paused status, start/stop/resume controls, and Restart from the More menu for running VMs (the VM is shut down and started again; the restart continues when the popup is closed).

- **Notifications** - Unread alert, warning, and info counts. Expandable list with individual and bulk archive actions. Badge count on the extension icon.

### 🖥️ Multi-Server

- Add unlimited servers with display name, URL, and API key.
- Tab bar for switching between servers.
- Per-server host permissions, you control exactly which hosts the extension can access.
- Automatic API key type detection, read-only keys see a full dashboard with mutation controls (start/stop, archive) disabled. A key the server reports as forbidden also switches the controls to view-only.
- The server form keeps what you typed across the browser's permission prompt, and the popup reopens by itself after you click Allow on Chrome and Edge 127+ and Firefox 149+; if it does not reopen, as expected on Firefox 142 to 148, click the toolbar icon and the form or save continues.

### 📋 List Settings (Docker & VMs)

- **Sort order** - Running first A-Z (default), A-Z, Z-A, or custom drag-and-drop order.
- **Visible count** - Show 5, 6, 10, 15, 20, or all items before the "Show all" toggle.
- **Custom order** - Drag-and-drop reordering via a modal interface. New items are appended automatically. Each server keeps its own order.
- **Custom display names** - Rename Docker containers and VMs with friendly labels shown on the dashboard.

### 🎨 UI & Preferences

- **Dark / Light mode** - Toggle with setting persistence.
- **Compact mode** - Condensed layout for smaller screens.
- **Resizable popup** - Drag the corner grip to adjust width and height. Your preferred size is remembered across sessions.
- **Card visibility** - Show or hide individual cards from Settings.
- **Card order** - Drag-to-reorder dashboard cards in Settings.
- **Collapsible cards** - Click any card header to collapse/expand. State persists across sessions.
- **Auto-refresh** - Configurable interval: 30s, 60s, 5 minutes, or off. Silent in-place refresh without popup reload.
- **Refresh error strip** - A failed refresh with data already on screen shows a strip above the cards: `Last refresh failed: <message>. Showing data from HH:MM.`

### 🔐 Security

- **Encrypted API key storage** - API keys are encrypted at rest using AES-256-GCM via the Web Crypto API. Keys are never written to disk in plaintext.
- **Server form draft and pending save** - The form values (key not yet encrypted) are copied to in-memory session storage, never written to disk, until the save or test finishes, the restored form is shown, or the browser closes. A Save also stores the server in local storage marked pending with the key encrypted, undone if permission is denied.

## 📋 Requirements

- **Unraid 7.2+** with the GraphQL API enabled
- An API key generated from the Unraid WebGUI

## ⚙️ How It Works

1. Click the Unraid Dash icon in the browser toolbar.
2. On first use, open Settings (gear icon) and add a server with its URL and API key.
3. The extension fetches data from the Unraid GraphQL API via the background service worker.
4. Dashboard cards render with live data. Auto-refresh keeps them updated.
5. Use start/stop/resume buttons to control Docker containers and VMs directly from the popup.
6. Click the notification summary to expand and browse individual notifications. Archive them individually or in bulk.
7. Open the More menu for container Restart and Pause and VM Restart, and use Update or Update all to update containers (admin key).
8. A VM Restart shuts the VM down and starts it again, and continues when the popup is closed.
9. When you click Save or Test Connection in the server form, the browser asks for access to that server if it is not already granted; after you click Allow the popup reopens by itself on Chrome and Edge 127+ and Firefox 149+, and if it does not, click the toolbar icon and the form or save continues.

All API calls route through the background service worker to avoid CORS restrictions. The service worker sends all requests and the popup sends none. The popup communicates with the service worker via `chrome.runtime.sendMessage`.

## 🏗️ Architecture

```
[Popup - Dashboard UI]
        |
    popup.html / popup.js
        |
        +-- Renders: System | Array | Docker | VMs | Notifications
        |
        +-- Card settings, collapsible headers, modals
        |
        +-- chrome.permissions.request (one origin, on Firefox one host, on Save or Test Connection)
        |
        +-- chrome.runtime.sendMessage
                    |
                    v
[Background - Service Worker]
        |
    background.js
        |
        +-- GraphQL queries (parallel per section)
        |       Core | Array | Network | Docker | VMs | Parity | Temperature | WebUI
        |
        +-- Docker/VM control mutations (start, stop, restart, pause, resume, update)
        |
        +-- Notification queries + archive mutations
        |
        +-- chrome.alarms
        |       badgeUpdate (every 5 min, badge count)
        |       vmRestart   (every 1 min, only during a VM restart)
        |
        +-- permissions.onAdded -> action.openPopup
        |       (reopens after Allow; if it does not, click the toolbar icon and the form or save continues)
        |
        +-- chrome.storage.session
        |       |
        |       +-- serverFormDraft (in memory)
        |
        +-- chrome.storage.local
                |
                +-- servers[]        (id, name, url, enabled)
                +-- encryptedKeys    (AES-256-GCM encrypted API keys)
                +-- _ek              (raw AES key bytes)
                +-- settings         (theme, refresh, visibility, list settings)
                +-- dockerUrlOverrides
                +-- itemNameOverrides
                +-- pendingUpdates
                +-- pendingRestarts
```

## 🔧 Installation

### From Source (Developer Mode)

1. Clone this repository
2. Open your browser's extension management page:
   - **Chrome:** `chrome://extensions`
   - **Edge:** `edge://extensions`
   - **Firefox:** `about:debugging#/runtime/this-firefox`
3. Enable **Developer Mode**
4. Click **Load unpacked** and select the project folder

> **Firefox users:** Before loading, rename `manifest_firefox.json` to `manifest.json` (replacing the original). The Firefox manifest includes the required `background.scripts` fallback and `browser_specific_settings` for Firefox compatibility.

### 🔑 Generating an API Key

1. Open your Unraid WebGUI
2. Navigate to **Settings > Management Access > API Keys**
3. Create a new API key with appropriate permissions
4. Copy the key and paste it into the extension settings

## 🔒 Permissions

| Permission | Purpose |
|------------|---------|
| `storage` | Save server configurations, UI preferences, and URL overrides locally. In-memory session storage holds the server form draft. |
| `alarms` | Badge refresh every 5 minutes for unread notification counts, plus a one-minute alarm only while a VM restart runs |
| `optional_host_permissions (http/https)` | Connect to your Unraid servers. Granted per server origin when you click Save or Test Connection (on Firefox the grant covers every port on that host), you control exactly which hosts the extension can access. |

## 🌐 Browser Compatibility

Chrome and Edge 127+, Firefox 142+ (MV3).

> The default `manifest.json` targets Chrome and Edge. A `manifest_firefox.json` is included for Firefox, which adds the `background.scripts` fallback and `browser_specific_settings` required by Firefox's extension platform.

## 🙏 Acknowledgments

- Code co-authored with **Claude Code**

## 📝 Changelog

### v1.3.0 - 2026-10-30

- Container WebUI links from the Unraid template, with port detection as fallback (API 4.30+)
- Update one container or all containers from the popup (API 4.30+, admin key)
- Container Restart and Pause and VM Restart via a new More menu; paused containers and VMs get Resume in place of Start
- Parity check progress, speed and last result on the Array card
- System temperature summary (API 4.37.6+) and hard drive temperature warning/critical colors
- Fixed saving and editing servers on Firefox, and editing a server no longer deletes it when the permission prompt is denied
- Fixed the server form losing what you typed when the permission prompt closes the popup
- The popup reopens by itself after you click Allow on the permission prompt (Chrome/Edge and Firefox 149+); if it does not, click the toolbar icon and the form or save continues
- Fixed Firefox not reaching a server on a non-default port after Allow: the grant now covers every port on that host. A server added before this version needs one edit and Save, which asks again
- Fixed the toolbar badge disappearing after a browser restart; it now also refreshes after server and notification changes
- Refresh errors are shown in a strip above the cards instead of being silently ignored
- Fixed responses from one server overwriting another server's view when switching quickly
- Failed container/VM actions now show the server's error on the row; Stop stays pending until the container/VM has stopped
- Custom sort order is now kept per server
- Readable timeout and server error messages on every browser
- Temperature summary computed from temperature sensors only (the API's own summary counts fans, voltages and power readings as temperatures)
- An invalid API key shows the authentication error on Unraid 7.3, which reports it with HTTP 200
- A server error that mentions "permission denied" (for example a Docker mount error) is shown as the error; only a key the server reports as forbidden switches the controls to view-only
- VM Restart shuts the VM down and starts it again, so slow-to-stop guests are no longer left off; offered for running VMs only

### v1.2.0 - 2026-03-14

- Fixed custom names and URL overrides being lost when Docker containers are updated or recreated (override keys now use container names instead of IDs)
- Fixed custom sort order being lost on container recreation (same root cause)
- Fixed sort and custom order ignoring custom display names
- One-time automatic migration converts existing overrides and sort order to the new format
- Server deletion now shows a confirmation dialog and cleans up all associated data (overrides, encrypted keys)
- Fixed `chrome.permissions.request()` not firing callback on Firefox (converted to async/await)
- Dynamic version display in footer via `chrome.runtime.getManifest()`
- Updated PRIVACY.md to reflect AES-256-GCM encryption added in v1.1.0
- Added JSDoc documentation to all named functions
- Code quality improvements (naming conventions, timer cleanup)

### v1.1.0 - 2026-03-08

- AES-256-GCM encrypted API key storage via Web Crypto API, keys are never written to disk in plaintext
- Docker container update indicators (orange dot badge when updates are available, requires Docker Auto Update Check enabled in Unraid)
- Clickable server name linking directly to the Unraid WebGUI
- Custom display names for Docker containers and VMs
- Drag-to-reorder dashboard cards in Settings
- Compact mode toggle for condensed layout
- Resizable popup with persisted dimensions
- Silent in-place data refresh without popup reload
- Parallel badge count fetches across all servers
- Eliminated all `innerHTML` usage, full DOM API rendering for Firefox AMO compliance
- Cross-browser compatibility verified (Chrome, Edge, Firefox MV3, 0 blockers)

### v1.0.0

- Initial public release

## 📄 License

[FSL-1.1-MIT](LICENSE) - Free to use for any non-competing purpose. Converts to MIT automatically after two years.

---

*by Alien Technology LLC*
