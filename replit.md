# Overview

This project is a multi-user subscription service for automated Shuffle.com promo code redemption. It allows users to subscribe multiple Shuffle accounts simultaneously using cryptocurrency payments (OxaPay). The primary goal is to provide a seamless and automated experience for redeeming promo codes found in various Telegram Shuffle groups.

**Key Capabilities:**
*   Monitors multiple Telegram Shuffle groups for promo codes.
*   Automatically extracts codes and their metadata (amount, wager, deadline).
*   Manages user subscriptions and crypto payments.
*   Auto-redeems codes for all subscribed user accounts on Shuffle.com.
*   Provides a client-side dashboard for users to track codes and their redemption status.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

The system is built upon a three-component architecture designed for efficiency and user autonomy:

1.  **Telegram Client (client.js):**
    *   Uses GramJS MTProto to connect as a regular Telegram user, monitoring 5 specific Shuffle Telegram groups.
    *   Forwards detected messages containing promo codes to a designated Telegram channel (`@shufflecodesdrops`) without the "Forwarded from" label.
    *   Sends messages to the Dashboard Server for code detection and processing.
    *   Event-driven using `NewMessage` handler for real-time monitoring.

2.  **Dashboard Server (dashboard/server.js):**
    *   An Express.js server that receives messages from the Telegram Client.
    *   Automatically detects promo codes using regex patterns (4-20 character alphanumeric).
    *   Extracts comprehensive metadata including code amount, wager requirement, and deadline.
    *   Temporarily stores codes in memory (5-minute cache) for immediate availability.
    *   Provides a REST API for the Tampermonkey script to fetch codes and mark them as claimed.

3.  **Tampermonkey Script (ShuffleCodeClaimer.user.js):**
    *   A single, unified script that runs on Shuffle.com.
    *   **Auto-polls the Dashboard API every 3 seconds** for new codes.
    *   Injects a built-in dashboard UI into the Shuffle.com page, displaying code details, claim status, and statistics.
    *   **Instant Auto-Redeem:** Automatically opens the redeem tab and clicks the "Redeem" button, leveraging the Geetest SDK on the page for captcha handling.
    *   Monitors DOM alerts and GraphQL responses for success/error messages related to redemption.
    *   Uses browser's `GM_setValue` storage to prevent duplicate code processing and maintain a user-specific history.

**Design Rationale:**
*   MTProto user client was chosen due to the absence of admin access for bot integration in source groups.
*   The Dashboard server centralizes code detection logic for consistency and easier maintenance.
*   Tampermonkey fetches from the API, ensuring a clean separation of concerns.
*   The client-side dashboard and local storage (`GM_setValue`) enable a personalized experience without relying on a backend database for individual user code history.

**Configuration Management:**
*   Environment variables (`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`) are used for Telegram API credentials.
*   Source groups and the target channel are defined as constants.

**Error Handling:**
*   Employs graceful failure patterns with try-catch blocks and comprehensive console logging.
*   Includes connection retry logic for the Telegram Client.

**UI/UX Decisions:**
*   The Tampermonkey script directly injects a dashboard UI into Shuffle.com, featuring a header bar and a slide-out panel for code information.
*   Visual cues like a pulsing green dot indicate active code searching.
*   Browser notifications are used to alert users of new codes with direct redemption instructions.

**Technical Implementations & Feature Specifications:**
*   **Comprehensive Metadata Extraction:** The system accurately extracts all 4 code fields (value, limit, wager requirement, and timeline) from various Telegram message formats.
*   **Client-Side Dashboard:** Each user's code history and claim status are managed locally in their browser using `GM_setValue`, providing persistence across sessions.
*   **Authentication System:** A robust authentication flow (connect, verify, refresh, logout) using JWT access and rotating refresh tokens secures the Tampermonkey script's interaction with the backend, ensuring only subscribed users can claim codes. Includes comprehensive error handling with `onerror`, `ontimeout` (10-second timeout), and proper status checking to prevent "stuck on verifying" issues.
*   **Multi-User Subscription Service:** A complete subscription system is integrated, supporting multiple Shuffle accounts per user, varied pricing tiers, and crypto payments via OxaPay with webhook handling. When payment is confirmed, the webhook automatically activates all shuffle accounts and sends a Telegram confirmation message to the user.
*   **Payment Webhook Integration:** The OxaPay webhook handler automatically activates subscriptions, creates/updates shuffle accounts with proper expiry dates, and sends Telegram notifications to users when payment is confirmed. Uses a shared TelegramNotifier utility (shared/telegramNotifier.js) that makes raw HTTPS requests to Telegram Bot API without requiring Telegraf.
*   **30-Minute Free Trial:** First-time users receive a 30-minute free trial (tracked via `trialClaimedAt` in database) to test the service before subscribing. The bot implements a strict eligibility check: after username submission, it verifies both the Telegram ID and all submitted usernames against the database. Only if BOTH are new will the user see the "Claim Free Trial" button. Otherwise, users proceed directly to paid plan selection. One-time only per Telegram ID with duplicate prevention at the callback level.
*   **Auto-Check On Page Load:** Upon visiting Shuffle.com, the script automatically performs a subscription check and retrieves the user's Shuffle username from a background VIP tab.
*   **Tab-Based Auto-Redemption:** Codes are redeemed by opening active tabs that auto-click the redeem button and capture success/error messages, then close automatically using Tampermonkey's privileged `GM_closeTab()` API. The system includes specific detection for "This bonus code is not found" errors with case-insensitive matching to ensure proper rejection recording and tab closure.
*   **Manual Code Claiming:** Users can click "⚡ Enter Code Manually" in the header to open a dedicated popup panel for entering promo codes. The system validates code format (4-20 alphanumeric characters), prevents duplicate processing, adds it to the dashboard with a "Manual Entry" label, and automatically opens a redemption tab. The panel is isolated from the 200ms polling refresh, ensuring smooth typing without flickering. Manual codes persist in browser storage alongside automatic codes.
*   **Timezone Handling:** All timestamps are stored in UTC in the database. User-facing displays show human-friendly formats (e.g., "30 mins", "5 days", or "YYYY-MM-DD HH:MM:SS UTC") for clarity and ease of understanding.
*   **Professional UI Design:** Modern glass-morphism header with gradient backgrounds, glowing effects, logo display, and prominent "Buy Subscription" button linking to @ShuffleSubscriptionBot on Telegram. Includes smooth animations and professional color scheme matching the Shuffle brand.

# External Dependencies

*   **Telegram (GramJS)**: Used for MTProto API client capabilities, handling user authentication, message events, and forwarding within Telegram. Requires `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and `TELEGRAM_SESSION`.
*   **input**: A command-line helper used in `login.js` for interactive prompts during session generation.
*   **express**: The web server framework for building the Dashboard API.
*   **cors**: Enables Cross-Origin Resource Sharing for the Dashboard API to allow requests from the Tampermonkey script.
*   **node-fetch**: An HTTP client used by the Telegram bot to communicate with the Dashboard API.
*   **Firebase Realtime Database**: The NoSQL database used for storing user, subscription, plan, shuffle account, and authentication token/session data. Requires `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, and `FIREBASE_DATABASE_URL`.
*   **OxaPay**: A cryptocurrency payment gateway integrated for processing user subscriptions, including webhook handling for payment status updates.

# Recent Changes

## November 17, 2025 - Database Migration to Firebase
- **Migrated from PostgreSQL to Firebase Realtime Database**: Replaced Drizzle ORM and PostgreSQL with Firebase Admin SDK for better scalability and real-time capabilities.
- **Database Structure**: All data is stored as JSON in Firebase with the following collections:
  - `users`: User profiles with Telegram IDs and subscription status
  - `plans`: Subscription plans with pricing and duration
  - `subscriptions`: Active and pending subscriptions with payment tracking
  - `shuffleAccounts`: User shuffle accounts with expiry dates
  - `authTokens`: Authentication tokens for user sessions
  - `authSessions`: JWT refresh token sessions
  - `codes`: Promo codes with claim status
  - `claimJobs`: Code claiming job queue
  - `auditLogs`: System audit trail
- **Updated Files**:
  - `server/firebase.js`: Firebase Admin SDK initialization
  - `server/firebaseDb.js`: Database helper functions for all CRUD operations
  - `server/api.js`: Updated all endpoints to use Firebase queries
  - `subscription-bot-v2.js`: Updated bot to use Firebase
  - `scripts/seed-plans.js`: Updated seed script for Firebase
- **Removed Files**: `server/db.js`, `server/db.ts`, `drizzle.config.ts`, `shared/schema.js`, `shared/schema.ts` (PostgreSQL/Drizzle ORM files)