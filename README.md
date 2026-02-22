> **Disclaimer:** This is a personal project shared under the [FSL-1.1-MIT License](LICENSE). It is not affiliated with, endorsed by, or sponsored by Lime Technology, Inc. (the makers of Unraid). Use it as you see fit, at your own risk.

---

# Unraid Dash

**Monitor your Unraid servers at a glance: system metrics, array status, Docker containers, VMs, and notifications in a single popup.**

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-FSL--1.1--MIT-green)
![Manifest](https://img.shields.io/badge/manifest-v3-orange)

## 🏪 Store Availability

| Store | Version | Link |
|-------|---------|------|
| Chrome Web Store | - | Coming soon |
| Edge Add-ons | - | Coming soon |
| Firefox Add-ons | - | Coming soon |

## 📖 Overview

Unraid Dash is a browser extension that gives you a quick dashboard view of your Unraid 7.x servers without opening the WebGUI. Click the extension icon to see CPU, RAM, disk health, running containers, VMs, and unread notifications, all fetched live from the Unraid GraphQL API.

Supports multiple servers, configurable auto-refresh, per-card visibility and sort settings, container/VM start-stop controls, notification archiving, and light/dark themes.

## ✨ Features

### 📊 Dashboard Cards

- **System** - CPU brand, cores/threads, total memory, CPU and RAM usage bars, uptime, server version, and LAN IP address.

- **Array** - Array state, total capacity with usage bar, per-disk health indicators with temperature and error counts, parity and cache pools.

- **🐳 Docker** - All containers with running/stopped status, start/stop controls, auto-detected WebUI links, and per-container URL overrides.

- **💻 VMs** - All virtual machines with running/stopped/paused status and start/stop controls.

- **🔔 Notifications** - Unread alert, warning, and info counts. Expandable list with individual and bulk archive actions. Badge count on the extension icon.

### 🖥️ Multi-Server

- Add unlimited servers with display name, URL, and API key.
- Tab bar for switching between servers.
- Per-server host permissions, you control exactly which hosts the extension can access.
- Automatic API key type detection -- read-only keys see a full dashboard with mutation controls (start/stop, archive) disabled.

### 📋 List Settings (Docker & VMs)

- **Sort order** - Running first A-Z (default), A-Z, Z-A, or custom drag-and-drop order.
- **Visible count** - Show 5, 6, 10, 15, 20, or all items before the "Show all" toggle.
- **Custom order** - Drag-and-drop reordering via a modal interface. New items are appended automatically.

### 🎨 UI & Preferences

- **Dark / Light mode** - Toggle with setting persistence.
- **Card visibility** - Show or hide individual cards from Settings.
- **Collapsible cards** - Click any card header to collapse/expand. State persists across sessions.
- **Auto-refresh** - Configurable interval: 30s, 60s, 5 minutes, or off.

## 📋 Requirements

- **Unraid 7.2+** with the GraphQL API enabled
- An API key generated from the Unraid WebGUI

## ⚙️ How It Works

1. Click the Unraid Dash icon in the browser toolbar.
2. On first use, open Settings (gear icon) and add a server with its URL and API key.
3. The extension fetches data from the Unraid GraphQL API via the background service worker.
4. Dashboard cards render with live data. Auto-refresh keeps them updated.
5. Use start/stop buttons to control Docker containers and VMs directly from the popup.
6. Click the notification summary to expand and browse individual notifications. Archive them individually or in bulk.

All API calls route through the background service worker to avoid CORS restrictions. The popup communicates with the service worker via `chrome.runtime.sendMessage`.

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
        +-- chrome.runtime.sendMessage
                    |
                    v
[Background - Service Worker]
        |
    background.js
        |
        +-- GraphQL queries (parallel per section)
        |       Core | Array | Network | Docker | VMs
        |
        +-- Docker/VM control mutations (start/stop)
        |
        +-- Notification queries + archive mutations
        |
        +-- Badge update via chrome.alarms (every 5 min)
        |
        +-- chrome.storage.local
                |
                +-- servers[]        (url, apiKey, name)
                +-- settings         (theme, refresh, visibility, list settings)
                +-- dockerUrlOverrides
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
| `storage` | Save server configurations, UI preferences, and URL overrides locally |
| `alarms` | Periodic badge updates for unread notification counts |
| `optional_host_permissions (http/https)` | Connect to your Unraid servers. Granted per-server when you add one, you control exactly which hosts the extension can access. |

## 🌐 Browser Compatibility

Chrome, Edge, and Firefox (MV3, 142+).

> The default `manifest.json` targets Chrome and Edge. A `manifest_firefox.json` is included for Firefox, which adds the `background.scripts` fallback and `browser_specific_settings` required by Firefox's extension platform.

## 🙏 Acknowledgments

- Code co-authored with **Claude Code**

## 📄 License

[FSL-1.1-MIT](LICENSE) - Free to use for any non-competing purpose. Converts to MIT automatically after two years.

---

*by Alien Technology LLC*
