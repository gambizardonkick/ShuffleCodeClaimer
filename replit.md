# Overview

This project is a multi-user subscription service for automated Shuffle.com promo code redemption. It allows users to subscribe multiple Shuffle accounts simultaneously using cryptocurrency payments. The primary goal is to provide a seamless and automated experience for redeeming promo codes found in various Telegram Shuffle groups. Key capabilities include monitoring Telegram groups, extracting promo codes, managing user subscriptions and crypto payments, and auto-redeeming codes for subscribed accounts. It also provides a client-side dashboard for users to track redemption status.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

The system employs a three-component architecture:

1.  **Telegram Client (client.js):** Utilizes GramJS MTProto to monitor five specific Telegram Shuffle groups. It forwards promo code messages to a designated Telegram channel and sends them to the Dashboard Server for processing.
2.  **Dashboard Server (dashboard/server.js):** An Express.js server that receives messages from the Telegram Client. It detects promo codes using regex, extracts metadata (amount, wager, deadline), and temporarily caches them. It provides a REST API for the Tampermonkey script to fetch codes and a WebSocket for instant code delivery.
3.  **Tampermonkey Script (ShuffleCodeClaimer.user.js):** Runs on Shuffle.com, auto-polls the Dashboard API (with WebSocket fallback), and injects a built-in dashboard UI. It features instant auto-redeem functionality, handles Geetest captchas, monitors GraphQL responses for redemption status, and uses browser storage for user-specific code history.

**Design Rationale:** The architecture separates concerns, centralizes code detection, and enables a personalized client-side experience without a backend database for individual user code history.

**UI/UX Decisions:** The Tampermonkey script injects a modern glass-morphism dashboard UI directly into Shuffle.com with visual cues, browser notifications for new codes, and a professional design.

**Technical Implementations & Feature Specifications:**
*   **Comprehensive Metadata Extraction:** Accurately extracts code value, limit, wager, and timeline.
*   **Client-Side Dashboard:** Manages user code history and claim status locally using `GM_setValue`.
*   **Authentication System:** Robust JWT-based authentication for secure interaction between the Tampermonkey script and the backend.
*   **Multi-User Subscription Service:** Supports multiple Shuffle accounts per user, varied pricing, and crypto payments via OxaPay with webhook handling for subscription activation and Telegram notifications.
*   **30-Minute Free Trial with Abuse Prevention:** Provides a trial tracked by a permanent `trialHistory` collection to prevent abuse, even after account deletion.
*   **Auto-Check On Page Load:** Automatically verifies subscription status and retrieves the user's Shuffle username.
*   **Tab-Based Auto-Redemption:** Redeems codes by opening and automatically closing tabs, detecting success/error messages.
*   **Manual Code Claiming:** Allows users to manually enter and redeem codes via a dedicated UI.
*   **Timezone Handling:** All timestamps are stored in UTC, displayed in user-friendly formats.
*   **WebSocket Instant Code Delivery:** Replaces polling for real-time code delivery to clients, with Telegram notifications for connection events.
*   **Currency Picker:** Allows users to select their preferred cryptocurrency for rewards, with bidirectional sync to Shuffle.com.
*   **Direct Browser-to-Telegram Notifications:** Notifications are sent directly from the browser to the Telegram Bot API, reducing backend load.
*   **Telegram DM Notifications UI & Status Updates:** Integrated toggle for Telegram notifications with status updates for successful or failed claims.

# External Dependencies

*   **Telegram (GramJS)**: For MTProto API client capabilities, message events, and forwarding within Telegram.
*   **input**: Command-line helper for interactive prompts during session generation.
*   **express**: Web server framework for the Dashboard API.
*   **cors**: Enables Cross-Origin Resource Sharing for the Dashboard API.
*   **node-fetch**: HTTP client used by the Telegram bot.
*   **Firebase Realtime Database**: NoSQL database for user, subscription, plan, shuffle account, and authentication data.
*   **OxaPay**: Cryptocurrency payment gateway for processing subscriptions and handling webhooks.