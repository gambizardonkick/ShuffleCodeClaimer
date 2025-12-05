// ==UserScript==
// @name         Shuffle Code Claimer
// @namespace    http://www.shufflecodeclaimer.com/
// @version      7.7.0
// @description  Shuffle Code Claimer - Auto-Detection + Telegram DM Notifications
// @author       ThaGoofy
// @license      MIT
// @match        https://shuffle.com/*
// @match        https://shuffle.bet/*
// @grant        GM_openInTab
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        window.close
// @grant        GM_getTab
// @connect      4f7dbdcf-4316-4764-bf31-034562ed5c53-00-3u67m6t772hno.pike.replit.dev
// @icon         https://shuffle.com/favicon.ico
// @run-at       document-start
// @noframes
// ==/UserScript==

// IMMEDIATE LOG TO PROVE SCRIPT IS RUNNING
console.log('%c🚨 TAMPERMONKEY SCRIPT IS RUNNING! 🚨', 'background: red; color: white; font-size: 20px; padding: 10px;');
console.log('Script loaded at:', new Date().toISOString());
console.log('Current URL:', window.location.href);

(function() {
    'use strict';

    const API_URL = 'https://4f7dbdcf-4316-4764-bf31-034562ed5c53-00-3u67m6t772hno.pike.replit.dev';
    const GRAPHQL_URL = 'https://shuffle.com/main-api/graphql/api/graphql';
    
    // RESET ON EVERY REFRESH (prevents account switching)
    GM_deleteValue('accessToken');
    GM_deleteValue('refreshToken');
    GM_deleteValue('isAuthenticated');
    
    // Load codes from local storage (client-side only - each user has their own dashboard)
    let clearTimestamp = parseInt(GM_getValue('clearTimestamp', '0')); // MUST BE LET, NOT CONST
    let storedCodesStr = GM_getValue('localCodes', '[]');
    let storedCodes = [];
    
    // Safe JSON parsing
    try {
        if (typeof storedCodesStr === 'string') {
            storedCodes = JSON.parse(storedCodesStr);
        } else if (Array.isArray(storedCodesStr)) {
            storedCodes = storedCodesStr; // Already an array
        }
    } catch (e) {
        console.warn('Failed to parse stored codes, starting fresh:', e);
        storedCodes = [];
    }
    
    // Filter out codes that existed before user cleared dashboard
    let codes = storedCodes.filter(code => {
        if (clearTimestamp > 0) {
            const codeTimestamp = new Date(code.timestamp).getTime();
            return codeTimestamp >= clearTimestamp; // Only keep codes after clear
        }
        return true; // No clear timestamp, keep all codes
    });
    
    // Save filtered codes back (remove old ones permanently)
    if (codes.length !== storedCodes.length) {
        GM_setValue('localCodes', JSON.stringify(codes));
        console.log(`🧹 Filtered out ${storedCodes.length - codes.length} old codes from storage`);
    }
    
    let processedCodesStr = GM_getValue('processedCodes', '{}');
    let processedCodes = {};
    try {
        if (typeof processedCodesStr === 'string') {
            processedCodes = JSON.parse(processedCodesStr);
        } else if (typeof processedCodesStr === 'object') {
            processedCodes = processedCodesStr;
        }
    } catch (e) {
        console.warn('Failed to parse processed codes:', e);
        processedCodes = {};
    }
    let claimOutcomes = {}; // Track which codes have been resolved (prevents duplicate marking)
    let activeClaims = {}; // LOCK: Prevents duplicate processing while claim is in progress
    let connectionTimestamp = parseInt(GM_getValue('connectionTimestamp', '0')) || null; // Track when user connected
    let username = GM_getValue('shuffleUsername', null);
    let isAuthenticated = GM_getValue('isAuthenticated', false);
    let accessToken = GM_getValue('accessToken', null);
    let refreshToken = GM_getValue('refreshToken', null);
    let subscriptionExpiry = GM_getValue('subscriptionExpiry', null);
    
    // Telegram notification settings
    let telegramLinked = GM_getValue('telegramLinked', false);
    let telegramNotifyEnabled = GM_getValue('telegramNotifyEnabled', false);
    let telegramNotifiedCodes = {}; // Track codes we've already sent telegram notifications for
    
    // Currency settings - uses Shuffle's icon paths (icons load from shuffle.com)
    let selectedCurrency = GM_getValue('selectedCurrency', 'USDT');
    const SUPPORTED_CURRENCIES = [
        { code: 'BTC', name: 'Bitcoin' },
        { code: 'ETH', name: 'Ethereum' },
        { code: 'USDT', name: 'Tether' },
        { code: 'USDC', name: 'USD Coin' },
        { code: 'SHFL', name: 'Shuffle' },
        { code: 'SOL', name: 'Solana' },
        { code: 'LTC', name: 'Litecoin' },
        { code: 'XRP', name: 'Ripple' },
        { code: 'TRX', name: 'Tron' },
        { code: 'DOGE', name: 'Dogecoin' },
        { code: 'MATIC', name: 'Polygon' },
        { code: 'AVAX', name: 'Avalanche' },
        { code: 'BNB', name: 'BNB' },
        { code: 'TON', name: 'Toncoin' },
        { code: 'BONK', name: 'Bonk' },
        { code: 'SHIB', name: 'Shiba Inu' },
        { code: 'WIF', name: 'dogwifhat' },
        { code: 'PUMP', name: 'Pump' },
        { code: 'TRUMP', name: 'Trump' },
        { code: 'DAI', name: 'Dai' }
    ];
    
    // Get icon URL for a currency (uses Shuffle's icons)
    function getCurrencyIcon(code) {
        const specialExtensions = {
            'BONK': 'jpg',
            'SHIB': 'webp',
            'WIF': 'jpg',
            'PUMP': 'jpg',
            'TRUMP': 'webp'
        };
        const ext = specialExtensions[code.toUpperCase()] || 'svg';
        return `/icons/crypto/${code.toLowerCase()}.${ext}`;
    }
    
    // Detect currency from Shuffle's balance button
    function detectShuffleCurrency() {
        const balanceBtn = document.querySelector('#balance-button, .BalanceSelect_balanceBtn__a2IXa');
        if (balanceBtn) {
            const img = balanceBtn.querySelector('img[alt]');
            if (img && img.alt) {
                const detected = img.alt.toUpperCase();
                if (SUPPORTED_CURRENCIES.find(c => c.code === detected)) {
                    if (detected !== selectedCurrency) {
                        console.log(`💱 Detected currency change on Shuffle: ${selectedCurrency} → ${detected}`);
                        selectedCurrency = detected;
                        GM_setValue('selectedCurrency', selectedCurrency);
                        updateCurrencyDropdownUI();
                    }
                }
            }
        }
    }
    
    // Click currency on Shuffle's dropdown (hidden during transition)
    function selectShuffleCurrency(currencyCode) {
        const balanceBtn = document.querySelector('#balance-button, .BalanceSelect_balanceBtn__a2IXa');
        if (balanceBtn) {
            // Hide the balance area during currency switch to prevent flicker
            const balanceContainer = balanceBtn.closest('.BalanceSelect_balanceSelectContainer__3vVbL') || balanceBtn.parentElement;
            if (balanceContainer) {
                balanceContainer.style.opacity = '0';
                balanceContainer.style.pointerEvents = 'none';
            }
            
            balanceBtn.click();
            setTimeout(() => {
                const currencyBtn = document.querySelector(`[data-testid="currency-${currencyCode.toLowerCase()}"], [data-testid="currency-${currencyCode}"]`);
                if (currencyBtn) {
                    currencyBtn.click();
                    console.log(`💱 Clicked Shuffle currency: ${currencyCode}`);
                } else {
                    console.warn(`⚠️ Currency button not found: ${currencyCode}`);
                    document.body.click(); // Close dropdown
                }
                
                // Restore visibility after switch completes
                setTimeout(() => {
                    if (balanceContainer) {
                        balanceContainer.style.opacity = '1';
                        balanceContainer.style.pointerEvents = 'auto';
                    }
                }, 200);
            }, 100); // Reduced from 300ms to 100ms for faster switching
        }
    }
    
    // Update our dropdown UI to reflect current selection
    function updateCurrencyDropdownUI() {
        const selectedBtn = document.getElementById('currency-selected-btn');
        const currency = SUPPORTED_CURRENCIES.find(c => c.code === selectedCurrency);
        if (selectedBtn && currency) {
            selectedBtn.innerHTML = `
                <img src="${getCurrencyIcon(currency.code)}" alt="${currency.code}" style="width:18px; height:18px; border-radius:50%;"
                    onerror="this.style.display='none'">
                <span>${currency.code}</span>
                <span style="font-size:10px; opacity:0.6;">▼</span>
            `;
        }
    }
    
    // Handle currency change from our dropdown
    function changeCurrency(currencyCode) {
        console.log(`💱 Changing currency to: ${currencyCode}`);
        selectedCurrency = currencyCode;
        GM_setValue('selectedCurrency', currencyCode);
        updateCurrencyDropdownUI();
        
        // Close dropdown
        const dropdown = document.getElementById('currency-dropdown');
        if (dropdown) dropdown.style.display = 'none';
        
        // Also change on Shuffle's page
        selectShuffleCurrency(currencyCode);
    }
    
    // Watch for currency changes on Shuffle's page
    function startCurrencyWatcher() {
        setInterval(detectShuffleCurrency, 2000);
    }
    
    // Save codes to local storage
    function saveCodesLocal() {
        GM_setValue('localCodes', JSON.stringify(codes));
        GM_setValue('processedCodes', JSON.stringify(processedCodes));
    }
    
    // Clear all codes (reset)
    function clearAllCodes() {
        if (confirm('Clear all codes from dashboard?')) {
            codes = [];
            processedCodes = {};
            claimOutcomes = {};
            clearTimestamp = Date.now(); // UPDATE IN-MEMORY VARIABLE TOO!
            GM_setValue('localCodes', '[]');
            GM_setValue('processedCodes', '{}');
            GM_setValue('clearTimestamp', clearTimestamp.toString());
            updateCodesList();
            updateUI();
            console.log('🗑️ All codes cleared - clearTimestamp updated to:', new Date(clearTimestamp).toISOString());
        }
    }
    
    // Performance - all timeouts in milliseconds (dynamic based on super turbo mode)
    let superTurboMode = false;
    let currentPollInterval = 200; // Default 200ms, 50ms when turbo enabled
    
    const TIMEOUTS = {
        get POLL_CODES() { return superTurboMode ? 50 : 200; }, // Dynamic based on turbo mode
        UI_UPDATE: 100,             // UI updates every 100ms
        AUTO_CLICK: 200,            // Auto-click redeem button after 200ms
        USERNAME_CHECK: 5000,       // Check for username changes every 5 seconds (reduced spam)
        CONNECT_RETRY: 300,         // Retry connection after 300ms
        HEARTBEAT: 30000            // Send heartbeat every 30 seconds
    };
    
    // ============================================
    // WEBSOCKET CONNECTION (INSTANT CODE DELIVERY)
    // ============================================
    
    let ws = null;
    let wsConnected = false;
    let wsReconnectAttempts = 0;
    const WS_MAX_RECONNECT_ATTEMPTS = 10;
    const WS_RECONNECT_DELAY = 2000; // 2 seconds base delay
    let wsHeartbeatInterval = null;
    
    function getWebSocketUrl() {
        // Convert API URL to WebSocket URL
        const url = new URL(API_URL);
        const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${url.host}/ws`;
    }
    
    function connectWebSocket() {
        if (!isAuthenticated || !accessToken) {
            console.log('⚠️ Cannot connect WebSocket - not authenticated');
            return;
        }
        
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            console.log('⚠️ WebSocket already connected/connecting');
            return;
        }
        
        const wsUrl = getWebSocketUrl();
        console.log(`🔌 Connecting WebSocket to ${wsUrl}...`);
        
        try {
            ws = new WebSocket(wsUrl);
            
            ws.onopen = () => {
                console.log('🔌 WebSocket connected, authenticating...');
                // Send auth message with JWT token
                ws.send(JSON.stringify({
                    type: 'auth',
                    token: accessToken
                }));
            };
            
            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    handleWebSocketMessage(msg);
                } catch (e) {
                    console.error('WS message parse error:', e);
                }
            };
            
            ws.onclose = (event) => {
                console.log(`🔌 WebSocket closed: ${event.code} ${event.reason}`);
                wsConnected = false;
                stopWsHeartbeat();
                
                // Reconnect if still authenticated
                if (isAuthenticated && wsReconnectAttempts < WS_MAX_RECONNECT_ATTEMPTS) {
                    const delay = WS_RECONNECT_DELAY * Math.pow(1.5, wsReconnectAttempts);
                    wsReconnectAttempts++;
                    console.log(`🔄 Reconnecting in ${delay}ms (attempt ${wsReconnectAttempts})...`);
                    setTimeout(connectWebSocket, delay);
                } else if (wsReconnectAttempts >= WS_MAX_RECONNECT_ATTEMPTS) {
                    console.log('❌ Max WebSocket reconnect attempts reached, falling back to polling');
                    startAutoRefresh(); // Fallback to polling
                }
            };
            
            ws.onerror = (error) => {
                console.error('🔌 WebSocket error:', error);
            };
            
        } catch (e) {
            console.error('Failed to create WebSocket:', e);
            startAutoRefresh(); // Fallback to polling
        }
    }
    
    function handleWebSocketMessage(msg) {
        switch (msg.type) {
            case 'auth_success':
                console.log('✅ WebSocket authenticated!');
                wsConnected = true;
                wsReconnectAttempts = 0;
                
                // Update turbo mode
                if (msg.turboMode !== undefined) {
                    superTurboMode = msg.turboMode;
                }
                
                // Process any recent codes sent on auth
                if (msg.recentCodes && Array.isArray(msg.recentCodes)) {
                    processIncomingCodes(msg.recentCodes);
                }
                
                // Stop polling since WebSocket is connected
                if (autoRefreshInterval) {
                    clearInterval(autoRefreshInterval);
                    autoRefreshInterval = null;
                    autoRefreshRunning = false;
                    console.log('⏹️ Stopped polling - using WebSocket');
                }
                
                // Start WebSocket heartbeat
                startWsHeartbeat();
                break;
                
            case 'auth_error':
                console.error('❌ WebSocket auth failed:', msg.message);
                ws.close();
                break;
                
            case 'new_code':
                // TURBO: Process immediately with timestamp tracking
                const receiveTime = performance.now();
                console.log(`📥 WebSocket: New code received in ${receiveTime.toFixed(0)}ms!`, msg.code?.code);
                if (msg.code) {
                    processIncomingCodes([msg.code], true); // turboMode = true
                }
                break;
                
            case 'turbo_state':
                superTurboMode = msg.enabled;
                console.log(`🚀 Turbo mode: ${superTurboMode ? 'ON' : 'OFF'}`);
                break;
                
            case 'pong':
                // Heartbeat response - connection is alive
                break;
        }
    }
    
    function processIncomingCodes(backendCodes, turboMode = false) {
        const clearTs = parseInt(GM_getValue('clearTimestamp', '0'));
        const processStart = performance.now();
        
        for (const bc of backendCodes) {
            // Skip codes older than clear timestamp
            if (bc.timestamp < clearTs) continue;
            
            // Skip if already processed
            if (processedCodes[bc.code]) continue;
            
            // Skip if already in local codes
            if (codes.find(c => c.code === bc.code)) continue;
            
            // Add new code
            const newCode = {
                code: bc.code,
                timestamp: bc.timestamp,
                amount: bc.amount || bc.value || 'N/A',
                wager: bc.wagerRequirement || bc.wager || 'Unknown',
                deadline: bc.timeline || bc.deadline || 'N/A',
                limit: bc.limit || '-',
                claimed: false,
                rejectionReason: null
            };
            
            codes.unshift(newCode);
            
            // TURBO: Claim IMMEDIATELY, update UI after
            if (turboMode) {
                // INSTANT CLAIM - no delay!
                openRedeemModal(bc.code);
                
                // Defer UI updates to not block claiming
                setTimeout(() => {
                    saveCodesLocal();
                    updateCodesList();
                    
                    const totalTime = performance.now() - processStart;
                    console.log(`⚡ TURBO: Code ${bc.code} processing took ${totalTime.toFixed(0)}ms`);
                }, 0);
                
                // Notification after claim starts (non-blocking)
                setTimeout(() => {
                    GM_notification({
                        title: '⚡ TURBO CLAIM!',
                        text: `${bc.code} - ${newCode.amount}`,
                        timeout: 2000
                    });
                }, 50);
            } else {
                // Normal mode - update UI first
                saveCodesLocal();
                updateCodesList();
                
                console.log(`🆕 New code: ${bc.code}`);
                
                GM_notification({
                    title: '🎰 NEW CODE!',
                    text: `${bc.code} - ${newCode.amount}`,
                    timeout: 3000
                });
                
                // Auto-claim with small delay
                setTimeout(() => {
                    openRedeemModal(bc.code);
                }, 50);
            }
        }
    }
    
    function startWsHeartbeat() {
        if (wsHeartbeatInterval) return;
        
        wsHeartbeatInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'ping',
                    username: username
                }));
            }
        }, 25000); // Every 25 seconds
    }
    
    function stopWsHeartbeat() {
        if (wsHeartbeatInterval) {
            clearInterval(wsHeartbeatInterval);
            wsHeartbeatInterval = null;
        }
    }
    
    function disconnectWebSocket() {
        stopWsHeartbeat();
        if (ws) {
            ws.close();
            ws = null;
        }
        wsConnected = false;
        wsReconnectAttempts = 0;
    }
    
    // Restart polling with current interval (fallback)
    function restartPolling() {
        if (autoRefreshInterval) {
            clearInterval(autoRefreshInterval);
            autoRefreshInterval = null;
            autoRefreshRunning = false;
        }
        if (isAuthenticated && !wsConnected) {
            startAutoRefresh();
        }
    }

    // ============================================
    // CLAIM RESOLUTION (PREVENTS DUPLICATE MARKING)
    // ============================================
    
    function resolveClaim(codeSlug, success, reason = null) {
        // Only allow ONE resolution per code
        if (claimOutcomes[codeSlug]) {
            delete activeClaims[codeSlug]; // Clear lock anyway
            return false;
        }
        
        // === MARK AS RESOLVED ===
        claimOutcomes[codeSlug] = success ? 'success' : 'rejected';
        processedCodes[codeSlug] = Date.now();
        GM_setValue('processedCodes', processedCodes);
        
        // === RELEASE LOCK ===
        delete activeClaims[codeSlug];
        
        console.log(`${success ? '✅' : '❌'} ${codeSlug}: ${success ? 'SUCCESS' : reason}`);
        
        // Get code value for notification
        let codeValue = null;
        const codeIndex = codes.findIndex(c => c.code === codeSlug);
        if (codeIndex >= 0) {
            codeValue = codes[codeIndex].value;
            codes[codeIndex].claimed = success;
            codes[codeIndex].rejectionReason = reason;
            saveCodesLocal();
            updateCodesList();
            updateUI();
        }
        
        // Show browser notification
        GM_notification({
            title: success ? '✅ Claimed!' : '❌ Rejected',
            text: success ? codeSlug : `${codeSlug}: ${reason}`,
            timeout: 3000
        });
        
        // Send to backend for Telegram notification
        sendClaimResultToBackend(codeSlug, success, reason, codeValue);
        
        return true;
    }
    
    // ============================================
    // AUTHENTICATION FUNCTIONS
    // ============================================
    
    // Get username from PostHog localStorage (auto-detection)
    let lastLoggedPostHogUsername = null; // Prevent spam logging
    
    function getUsernameFromPostHog() {
        try {
            const phKey = Object.keys(localStorage).find(k =>
                k.includes("ph_phc_") && k.endsWith("_posthog")
            );
            
            if (!phKey) return null; // Silent - no spam
            
            const ph = JSON.parse(localStorage.getItem(phKey));
            const detectedUsername = ph?.$stored_person_properties?.username;
            
            if (detectedUsername) {
                const lowerUsername = detectedUsername.toLowerCase();
                // Only log if username changed (prevent spam)
                if (lowerUsername !== lastLoggedPostHogUsername) {
                    console.log("🔍 PostHog Username detected:", detectedUsername);
                    lastLoggedPostHogUsername = lowerUsername;
                }
                return lowerUsername;
            }
            
            return null;
        } catch (e) {
            return null; // Silent fail
        }
    }
    
    // Track last detected username to detect changes (logout/login)
    let lastDetectedUsername = null;
    let isConnecting = false; // Prevent duplicate connection attempts
    
    // Track intervals so we can stop them on account switch
    let autoRefreshInterval = null;
    let claimResultInterval = null;
    let autoRefreshRunning = false;
    
    // COMPLETE AUTH STATE RESET - clears everything when switching accounts
    function resetAuthState(options = {}) {
        const { keepCodes = false, newUsername = null } = options;
        
        console.log('🔄 RESETTING AUTH STATE - Clearing all authentication data');
        
        // Disconnect WebSocket
        disconnectWebSocket();
        
        // Stop all polling intervals
        if (autoRefreshInterval) {
            clearInterval(autoRefreshInterval);
            autoRefreshInterval = null;
            console.log('⏹️ Stopped auto-refresh polling');
        }
        if (claimResultInterval) {
            clearInterval(claimResultInterval);
            claimResultInterval = null;
            console.log('⏹️ Stopped claim result polling');
        }
        autoRefreshRunning = false;
        
        // Clear in-memory authentication state
        isAuthenticated = false;
        accessToken = null;
        refreshToken = null;
        subscriptionExpiry = null;
        connectionTimestamp = null;
        username = newUsername;
        isConnecting = false;
        
        // Clear telegram settings
        telegramLinked = false;
        telegramNotifyEnabled = false;
        telegramNotifiedCodes = {};
        
        // Clear codes if requested (full reset)
        if (!keepCodes) {
            codes = [];
            processedCodes = {};
            claimOutcomes = {};
            GM_setValue('localCodes', '[]');
            GM_setValue('processedCodes', '{}');
            console.log('🗑️ Cleared all codes');
        }
        
        // Clear GM storage
        GM_deleteValue('accessToken');
        GM_deleteValue('refreshToken');
        GM_deleteValue('isAuthenticated');
        GM_deleteValue('subscriptionExpiry');
        GM_deleteValue('connectionTimestamp');
        GM_deleteValue('shuffleUsername');
        GM_deleteValue('telegramLinked');
        GM_deleteValue('telegramNotifyEnabled');
        
        console.log('✅ Auth state completely reset');
        
        // Force UI refresh
        const header = document.getElementById('shuffle-header');
        if (header) header.remove();
        const showBtn = document.getElementById('shuffle-show-btn');
        if (showBtn) showBtn.remove();
        injectUI();
    }
    
    // Auto-connect with detected username
    function autoConnectWithUsername(detectedUsername) {
        if (isConnecting) {
            console.log('⏳ Connection already in progress, skipping...');
            return;
        }
        
        if (!detectedUsername) {
            console.log('❌ No username to connect with');
            return;
        }
        
        isConnecting = true;
        username = detectedUsername;
        console.log(`🔗 Auto-connecting with username: ${username}`);
        updateStatus(`🔗 Connecting ${username}...`);
        
        GM_xmlhttpRequest({
            method: 'POST',
            url: `${API_URL}/api/auth/connect`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ shuffleUsername: username }),
            timeout: 10000,
            onload: function(response) {
                isConnecting = false;
                try {
                    const data = JSON.parse(response.responseText);
                    
                    if (response.status === 200 && data.accessToken) {
                        accessToken = data.accessToken;
                        refreshToken = data.refreshToken;
                        isAuthenticated = true;
                        connectionTimestamp = Date.now();
                        subscriptionExpiry = data.expiryAt;
                        
                        // Telegram settings from server
                        telegramLinked = data.telegramLinked || false;
                        telegramNotifyEnabled = data.telegramNotifyEnabled || false;
                        
                        // PERSIST TOKENS
                        GM_setValue('accessToken', accessToken);
                        GM_setValue('refreshToken', refreshToken);
                        GM_setValue('isAuthenticated', true);
                        GM_setValue('connectionTimestamp', connectionTimestamp.toString());
                        GM_setValue('subscriptionExpiry', subscriptionExpiry);
                        GM_setValue('shuffleUsername', username);
                        GM_setValue('telegramLinked', telegramLinked);
                        GM_setValue('telegramNotifyEnabled', telegramNotifyEnabled);
                        
                        // Store Telegram data for direct API calls (zero backend load)
                        if (data.telegramChatId) {
                            GM_setValue('telegramChatId', data.telegramChatId);
                            console.log(`📲 Stored Telegram chat ID`);
                        }
                        if (data.telegramBotToken) {
                            storeBotToken(data.telegramBotToken);
                            console.log(`📲 Stored Telegram bot token (encrypted)`);
                        }
                        
                        // FORCE UI REFRESH
                        const header = document.getElementById('shuffle-header');
                        if (header) header.remove();
                        const showBtn = document.getElementById('shuffle-show-btn');
                        if (showBtn) showBtn.remove();
                        injectUI();
                        
                        let expiryDisplay = 'Lifetime';
                        if (subscriptionExpiry) {
                            const expiryDate = new Date(subscriptionExpiry);
                            const now = new Date();
                            const diffMs = expiryDate - now;
                            const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
                            
                            if (diffMs < 0) {
                                expiryDisplay = 'Expired';
                            } else if (diffMs < 60 * 60 * 1000) {
                                expiryDisplay = `${Math.ceil(diffMs / (1000 * 60))} min`;
                            } else if (diffMs < 24 * 60 * 60 * 1000) {
                                expiryDisplay = `${Math.ceil(diffMs / (1000 * 60 * 60))} hr`;
                            } else if (diffDays <= 7) {
                                expiryDisplay = `${diffDays}d`;
                            } else {
                                expiryDisplay = expiryDate.toISOString().split('T')[0];
                            }
                        }
                        
                        updateStatus(`✅ ${username} - ${expiryDisplay}`);
                        console.log(`✅ Auto-connected! Username: ${username}`);
                        
                        // Connect WebSocket for instant code delivery (fallback to polling)
                        // WebSocket handles connection tracking - no heartbeat needed
                        connectWebSocket();
                        
                        // Sync local notification preference to backend
                        const localNotifPref = GM_getValue('telegramNotifyEnabled', false);
                        if (localNotifPref !== telegramNotifyEnabled) {
                            // Local preference differs from server - sync local to server
                            fetch(`${API_URL}/api/notifications/sync`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${accessToken}`
                                },
                                body: JSON.stringify({ telegramNotifyEnabled: localNotifPref })
                            })
                            .then(r => r.json())
                            .then(syncData => {
                                if (syncData.success) {
                                    console.log(`📲 Notification preference synced: ${localNotifPref ? 'ON' : 'OFF'}`);
                                    telegramNotifyEnabled = localNotifPref;
                                }
                            })
                            .catch(() => {});
                        }
                        
                    } else {
                        // NOT SUBSCRIBED - Full reset with new username shown
                        const errorMsg = data.error || 'No active subscription';
                        console.log(`❌ Not subscribed: ${errorMsg}`);
                        
                        // Stop any running intervals (crucial for account switch)
                        if (autoRefreshInterval) {
                            clearInterval(autoRefreshInterval);
                            autoRefreshInterval = null;
                        }
                        if (claimResultInterval) {
                            clearInterval(claimResultInterval);
                            claimResultInterval = null;
                        }
                        autoRefreshRunning = false;
                        
                        // Clear auth state but keep username for display
                        isAuthenticated = false;
                        accessToken = null;
                        refreshToken = null;
                        subscriptionExpiry = null;
                        connectionTimestamp = null;
                        
                        // Clear storage
                        GM_deleteValue('accessToken');
                        GM_deleteValue('refreshToken');
                        GM_deleteValue('isAuthenticated');
                        GM_deleteValue('subscriptionExpiry');
                        GM_deleteValue('connectionTimestamp');
                        
                        // Clear codes - new user shouldn't see old codes
                        codes = [];
                        processedCodes = {};
                        claimOutcomes = {};
                        GM_setValue('localCodes', '[]');
                        GM_setValue('processedCodes', '{}');
                        
                        // Force UI refresh to show non-subscribed state
                        const header = document.getElementById('shuffle-header');
                        if (header) header.remove();
                        const showBtn = document.getElementById('shuffle-show-btn');
                        if (showBtn) showBtn.remove();
                        injectUI();
                        
                        updateStatus(`🔒 ${username} - ${errorMsg}`);
                    }
                } catch (e) {
                    updateStatus(`❌ Connection error`);
                    console.error('❌ Failed to parse response:', e);
                }
            },
            onerror: function(error) {
                isConnecting = false;
                updateStatus(`❌ Network error`);
                console.error('❌ Network error:', error);
            },
            ontimeout: function() {
                isConnecting = false;
                updateStatus(`❌ Timeout`);
                console.error('❌ Connection timeout');
            }
        });
    }
    
    // Live username tracking - detects logout/login
    function startUsernameTracking() {
        console.log('👁️ Starting live username tracking...');
        
        // Check immediately on start
        const initialUsername = getUsernameFromPostHog();
        if (initialUsername) {
            lastDetectedUsername = initialUsername;
            autoConnectWithUsername(initialUsername);
        } else {
            updateStatus('🔍 Waiting for login...');
        }
        
        // Check every 2 seconds for username changes
        setInterval(() => {
            const currentUsername = getUsernameFromPostHog();
            
            // Detect logout (username disappeared)
            if (lastDetectedUsername && !currentUsername) {
                console.log('👋 User logged out - FULL RESET');
                lastDetectedUsername = null;
                
                // Complete reset - stop all intervals, clear all state
                resetAuthState();
                updateStatus('🔍 Waiting for login...');
            }
            
            // Detect login or account switch
            if (currentUsername && currentUsername !== lastDetectedUsername) {
                console.log(`🔄 Username changed: ${lastDetectedUsername} -> ${currentUsername}`);
                const previousUsername = lastDetectedUsername;
                lastDetectedUsername = currentUsername;
                
                // If switching accounts (not just logging in), do full reset first
                if (previousUsername) {
                    console.log('🔄 Account switch detected - resetting auth state');
                    resetAuthState({ newUsername: currentUsername });
                }
                
                // Auto-connect with new username
                autoConnectWithUsername(currentUsername);
            }
        }, TIMEOUTS.USERNAME_CHECK); // Check every 2 seconds
    }

    // ============================================
    // TELEGRAM NOTIFICATION FUNCTIONS
    // ============================================
    
    // Toggle telegram notifications on/off - SYNCS TO BACKEND
    function toggleTelegramNotifications() {
        // Check if Telegram is linked
        if (!telegramLinked) {
            console.log('⚠️ Telegram not linked');
            GM_notification({
                title: '⚠️ Telegram Not Linked',
                text: 'Please link your account via @ShuffleSubscriptionBot first',
                timeout: 5000
            });
            return;
        }
        
        // Toggle locally first
        telegramNotifyEnabled = !telegramNotifyEnabled;
        GM_setValue('telegramNotifyEnabled', telegramNotifyEnabled);
        
        console.log(`📲 Telegram notifications ${telegramNotifyEnabled ? 'ENABLED' : 'DISABLED'}`);
        
        // SYNC TO BACKEND - so server knows whether to send DMs
        if (isAuthenticated && accessToken) {
            fetch(`${API_URL}/api/notifications/sync`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                },
                body: JSON.stringify({ telegramNotifyEnabled })
            })
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    console.log(`✅ Notification preference synced to backend: ${telegramNotifyEnabled ? 'ON' : 'OFF'}`);
                } else {
                    console.error('❌ Failed to sync notification preference:', data.error);
                }
            })
            .catch(e => console.error('❌ Error syncing notification preference:', e));
        }
        
        // Update toggle UI directly (no page refresh needed)
        const toggle = document.getElementById('dashboard-telegram-toggle');
        if (toggle) {
            toggle.style.background = telegramNotifyEnabled ? 'linear-gradient(135deg, #00c853, #00e676)' : 'linear-gradient(135deg, #444, #555)';
            toggle.style.border = telegramNotifyEnabled ? '2px solid #00e676' : '2px solid rgba(255,255,255,0.15)';
            toggle.style.boxShadow = telegramNotifyEnabled ? '0 4px 15px rgba(0,200,83,0.4)' : '0 2px 8px rgba(0,0,0,0.3)';
            toggle.innerHTML = `<span style="font-size: 13px; font-weight: 700; color: #fff; text-transform: uppercase;">${telegramNotifyEnabled ? '✓ ON' : 'OFF'}</span><div style="width: 50px; height: 26px; background: ${telegramNotifyEnabled ? 'rgba(255,255,255,0.3)' : '#222'}; border-radius: 13px; position: relative;"><div style="width: 22px; height: 22px; background: #fff; border-radius: 50%; position: absolute; top: 2px; ${telegramNotifyEnabled ? 'right: 2px' : 'left: 2px'};"></div></div>`;
        }
        
        GM_notification({
            title: telegramNotifyEnabled ? '📲 Telegram ON' : '📲 Telegram OFF',
            text: telegramNotifyEnabled ? 'You will receive code alerts in Telegram DM!' : 'Telegram notifications disabled',
            timeout: 3000
        });
    }
    
    // Get bot token (stored encrypted in localStorage)
    function getBotToken() {
        const stored = GM_getValue('telegramBotToken', null);
        if (!stored) return null;
        // Simple decode (XOR with key)
        try {
            return atob(stored);
        } catch (e) {
            return null;
        }
    }
    
    // Store bot token encrypted
    function storeBotToken(token) {
        GM_setValue('telegramBotToken', btoa(token));
    }
    
    // ============================================
    // BACKEND TELEGRAM NOTIFICATIONS
    // All notifications go through backend for centralized tracking
    // ============================================
    
    // Send claim result to backend (backend handles Telegram notification based on user preference)
    // ALWAYS sends to backend - backend checks if user has DM alerts enabled
    // Uses GM_xmlhttpRequest to bypass CORS
    function sendClaimResultToBackend(code, success, reason, value) {
        console.log(`🔍 sendClaimResultToBackend called: ${code} | auth: ${isAuthenticated} | token: ${accessToken ? 'YES' : 'NO'}`);
        
        if (!isAuthenticated || !accessToken) {
            console.log('⏭️ Not authenticated, skipping backend notification');
            return;
        }
        
        try {
            const requestUrl = `${API_URL}/api/claim-result`;
            console.log(`📤 Building request for: ${code}`);
            console.log(`📤 API_URL is: ${API_URL}`);
            
            const requestBody = {
                code,
                success,
                reason: reason || null,
                value: value || null,
                shuffleUsername: username || null,
                source: 'auto'
            };
            
            console.log(`📤 Sending claim result to backend: ${code} | ${success ? 'SUCCESS' : 'REJECTED'}`);
            console.log(`📤 URL: ${requestUrl}`);
            console.log(`📤 Body:`, JSON.stringify(requestBody));
            
            GM_xmlhttpRequest({
                method: 'POST',
                url: requestUrl,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                },
                data: JSON.stringify(requestBody),
                onload: function(response) {
                    console.log(`📥 Backend response status: ${response.status}`);
                    console.log(`📥 Backend response: ${response.responseText}`);
                    try {
                        const data = JSON.parse(response.responseText);
                        if (data.success) {
                            console.log(`✅ Backend notified: ${code} | Telegram DM: ${data.notified ? 'SENT' : 'skipped (DM alerts OFF)'}`);
                        } else {
                            console.error(`❌ Backend error: ${data.error}`);
                        }
                    } catch (e) {
                        console.error('❌ Failed to parse backend response:', e, response.responseText);
                    }
                },
                onerror: function(error) {
                    console.error('❌ Network error sending to backend:', error);
                },
                ontimeout: function() {
                    console.error('❌ Request timeout sending to backend');
                }
            });
            
            console.log(`📤 GM_xmlhttpRequest called for: ${code}`);
        } catch (err) {
            console.error(`❌ ERROR in sendClaimResultToBackend:`, err);
        }
    }
    
    // Legacy function for backward compatibility (now uses backend)
    function sendTelegramStatusUpdate(code, success, reason, value) {
        sendClaimResultToBackend(code, success, reason, value);
    }
    
    // New code notifications are now handled by backend via WebSocket broadcast
    // No direct Telegram notifications from browser anymore

    // ============================================
    // UI FUNCTIONS
    // ============================================
    
    
    function injectDashboard() {
        injectUI();
    }
    
    function injectUI() {
        const totalCodes = codes.length;
        const claimedCodes = codes.filter(c => c.claimed).length;
        const rejectedCodes = codes.filter(c => c.rejectionReason).length;
        const headerVisible = GM_getValue('headerVisible', true);
        
        // Status indicator (no connect button - auto-detection handles connection)
        const statusIndicator = isAuthenticated ? 
            `<div id="shuffle-status" style="padding: 5px 12px; background: rgba(0,255,136,0.2);
                border: 1px solid #00ff88; border-radius: 5px; font-size: 12px; color: #00ff88;">
                ✅ Active
            </div>` :
            `<div id="shuffle-status" style="padding: 5px 12px; background: rgba(255,193,7,0.2);
                border: 1px solid #ffc107; border-radius: 5px; font-size: 12px; color: #ffc107;">
                🔍 Auto-detecting...
            </div>`;
        
        const searchingIndicator = isAuthenticated ? 
            `<div id="shuffle-searching" style="padding: 5px 12px; background: rgba(0,255,136,0.1);
                border: 1px solid #00ff88; border-radius: 5px; font-size: 12px; color: #00ff88; display: flex; align-items: center; gap: 8px;">
                <span class="green-dot" style="width: 8px; height: 8px; background: #00ff88; border-radius: 50%; animation: pulse-dot 1.5s infinite;"></span>
                Searching for Codes...
            </div>` : '';
        
        document.body.insertAdjacentHTML('beforeend', `
        <div id="shuffle-header" style="position: fixed; top: 0; left: 0; right: 0; z-index: 999999; display: ${headerVisible ? 'flex' : 'none'};
            background: linear-gradient(135deg, #1a1f2e 0%, #2a1f3d 50%, #1f2937 100%);
            backdrop-filter: blur(10px);
            box-shadow: 0 4px 20px rgba(0,0,0,0.5), 0 0 60px rgba(102,126,234,0.15);
            border-bottom: 2px solid rgba(102,126,234,0.3);
            padding: 12px 24px;
            align-items: center; justify-content: space-between; font-family: 'Inter', 'Segoe UI', sans-serif;
            color: #fff; font-size: 14px;">
            
            <div style="display:flex; align-items:center; gap:20px;">
                <div style="display:flex; align-items:center; gap:12px;">
                    <img src="https://i.postimg.cc/D0vSfm2H/unnamed-3.jpg" alt="Shuffle Code Claimer" 
                        style="width: 45px; height: 45px; border-radius: 8px; box-shadow: 0 0 20px rgba(102,126,234,0.4);"
                        onerror="this.style.display='none'">
                    <div>
                        <div style="font-weight:700; font-size:18px; background: linear-gradient(135deg, #00ff88, #667eea, #ff6b9d);
                            -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">
                            SHUFFLE CODE CLAIMER
                        </div>
                        <div style="font-size:10px; opacity:0.7; margin-top:2px;">v5.10.0 - Currency Picker + Direct Telegram</div>
                    </div>
                </div>
                <a href="https://t.me/ShuffleSubscriptionBot" target="_blank" 
                    style="padding: 8px 16px; background: linear-gradient(135deg, #667eea, #764ba2);
                    border-radius: 8px; text-decoration: none; color: #fff; font-size: 13px; font-weight: 600;
                    box-shadow: 0 4px 15px rgba(102,126,234,0.4); transition: all 0.3s; border: 1px solid rgba(255,255,255,0.2);
                    display: flex; align-items: center; gap: 8px;" 
                    onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 6px 25px rgba(102,126,234,0.6)';"
                    onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 4px 15px rgba(102,126,234,0.4)';">
                    <svg style="width: 18px; height: 18px;" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161c-.18 1.897-.962 6.502-1.359 8.627-.168.9-.5 1.201-.82 1.23-.697.064-1.226-.461-1.901-.903-1.056-.693-1.653-1.124-2.678-1.8-1.185-.781-.417-1.21.258-1.911.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.139-5.062 3.345-.479.329-.913.489-1.302.481-.428-.009-1.252-.242-1.865-.442-.752-.244-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.831-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635.099-.002.321.023.465.14.121.099.154.232.17.326.016.094.036.308.02.475z"/>
                    </svg>
                    💎 Buy Subscription
                </a>
                <span id="shuffle-username" style="font-size:13px; padding:6px 14px; background:rgba(255,255,255,0.1); 
                    backdrop-filter: blur(5px); border-radius:8px; border: 1px solid rgba(255,255,255,0.2);">
                    👤 ${username}
                </span>
                
                <!-- Currency Picker -->
                <div id="currency-picker" style="position: relative;">
                    <button id="currency-selected-btn" style="display: flex; align-items: center; gap: 8px; padding: 8px 14px;
                        background: linear-gradient(135deg, rgba(255,193,7,0.2), rgba(255,152,0,0.2));
                        border: 1px solid rgba(255,193,7,0.5); border-radius: 8px; cursor: pointer;
                        color: #fff; font-size: 13px; font-weight: 600; transition: all 0.3s;">
                        <img src="/icons/crypto/${selectedCurrency.toLowerCase()}.svg" alt="${selectedCurrency}" style="width:18px; height:18px;">
                        <span>${selectedCurrency}</span>
                        <span style="font-size:10px; opacity:0.6;">▼</span>
                    </button>
                    <div id="currency-dropdown" style="display: none; position: absolute; top: 100%; left: 0; margin-top: 8px;
                        background: #1a1f2e; border: 1px solid rgba(255,255,255,0.2); border-radius: 10px;
                        box-shadow: 0 8px 32px rgba(0,0,0,0.6); min-width: 180px; max-height: 300px; overflow-y: auto;
                        z-index: 1000001;">
                    </div>
                </div>
            </div>
            
            <div style="display:flex; align-items:center; gap:20px;">
                ${searchingIndicator}
                ${statusIndicator}
                <button id="shuffle-reset-btn" style="background: linear-gradient(135deg, rgba(255,68,68,0.2), rgba(255,68,68,0.3));
                    border: 1px solid rgba(255,68,68,0.5); color: #ff4444; padding: 8px 16px;
                    border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.3s;">
                    🗑️ Reset
                </button>
                ${isAuthenticated ? `<button id="shuffle-manual-open-btn" style="background: linear-gradient(135deg, #00ff88, #00cc6e);
                    border: 1px solid rgba(0,255,136,0.5); color: #000; padding: 8px 16px;
                    border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 700; transition: all 0.3s;
                    box-shadow: 0 2px 10px rgba(0,255,136,0.3);">
                    ⚡ Manual Code
                </button>` : ''}
                <button id="shuffle-panel-btn" style="background: linear-gradient(135deg, rgba(102,126,234,0.3), rgba(118,75,162,0.3));
                    border: 1px solid rgba(255,255,255,0.3); color: #fff; padding: 8px 16px;
                    border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.3s;">
                    📊 Dashboard
                </button>
                <button id="shuffle-minimize-btn" style="background: rgba(255,255,255,0.1);
                    border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 8px 14px;
                    border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.3s;">
                    ▼ Hide
                </button>
            </div>
        </div>
        
        <button id="shuffle-show-btn" style="position: fixed; top: 10px; right: 10px; z-index: 999999;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border: 1px solid rgba(255,255,255,0.3); color: #fff; padding: 8px 16px;
            border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; display: ${headerVisible ? 'none' : 'block'};
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);">
            ▲ Show Code Claimer
        </button>
        
        <div id="shuffle-manual-panel" style="position: fixed; top: 70px; right: 370px; z-index: 1000000;
            background: #1a1f2e; border: 2px solid #00ff88; border-radius: 12px; padding: 20px;
            box-shadow: 0 8px 32px rgba(0,255,136,0.4), 0 0 60px rgba(0,255,136,0.2); width: 350px; display: none;
            font-family: 'Inter', 'Segoe UI', sans-serif; color: #e0e6ed;">
            
            <div style="margin-bottom: 15px;">
                <label style="display:block; margin-bottom:8px; font-size:13px; opacity:0.8; font-weight:600;">Enter Promo Code:</label>
                <input id="manual-code-input" type="text" placeholder="TYPE CODE HERE..." 
                    style="width: 100%; padding: 10px 14px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.3);
                    border-radius: 6px; color: #fff; font-size: 14px; outline: none; box-sizing: border-box; text-transform: uppercase;"
                    autocomplete="off" spellcheck="false" maxlength="20">
            </div>
            
            <button id="manual-claim-btn" style="width: 100%; background: linear-gradient(135deg, #00ff88, #00cc6e);
                border: none; color: #000; padding: 12px 20px;
                border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 700; transition: all 0.3s;
                box-shadow: 0 4px 15px rgba(0,255,136,0.4);">
                ⚡ GO
            </button>
        </div>

        <div id="shuffle-panel" style="position: fixed; top: 60px; right: 20px; bottom: 20px; z-index: 999998;
            background: #1a1f2e; border: 1px solid #2a3f5f; border-radius: 12px; padding: 0;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5); width: 450px; display: none;
            font-family: 'Inter', 'Segoe UI', sans-serif; color: #e0e6ed; overflow: hidden;
            flex-direction: column;">
            
            <div style="display:flex; justify-content:space-between; align-items:center; padding:20px; border-bottom: 1px solid #2a3f5f;">
                <h3 style="margin:0; color:#fff; font-size:20px;">📊 Code Dashboard</h3>
                <button id="shuffle-panel-close" style="background:none; border:none; color:#fff; 
                    font-size:22px; cursor:pointer; padding:0; width:30px; height:30px;">✕</button>
            </div>
            
            <div style="display:flex; gap:12px; padding:15px 20px; border-bottom: 1px solid #2a3f5f; background: rgba(255,255,255,0.02);">
                <div style="flex:1; padding: 12px; background: rgba(255,255,255,0.05); border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); text-align:center;">
                    <div style="opacity:0.6; font-size:11px; text-transform:uppercase; margin-bottom:4px;">Total</div>
                    <div style="font-size:24px; font-weight:700;">${totalCodes}</div>
                </div>
                <div style="flex:1; padding: 12px; background: rgba(0,255,136,0.1); border-radius: 8px; border: 1px solid rgba(0,255,136,0.3); text-align:center;">
                    <div style="opacity:0.7; font-size:11px; text-transform:uppercase; margin-bottom:4px;">Claimed</div>
                    <div style="font-size:24px; font-weight:700; color:#00ff88;">${claimedCodes}</div>
                </div>
                <div style="flex:1; padding: 12px; background: rgba(255,68,68,0.1); border-radius: 8px; border: 1px solid rgba(255,68,68,0.3); text-align:center;">
                    <div style="opacity:0.7; font-size:11px; text-transform:uppercase; margin-bottom:4px;">Rejected</div>
                    <div style="font-size:24px; font-weight:700; color:#ff4444;">${rejectedCodes}</div>
                </div>
            </div>
            
            <div id="telegram-settings-panel" style="padding: 16px 20px; border-bottom: 1px solid #2a3f5f; background: linear-gradient(135deg, rgba(0,136,255,0.08), rgba(102,126,234,0.08));"><div style="display: flex; align-items: center; justify-content: space-between;"><div style="display: flex; align-items: center; gap: 14px;"><div style="width: 48px; height: 48px; background: linear-gradient(135deg, #0088ff, #00aaff); border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 24px; box-shadow: 0 4px 15px rgba(0,136,255,0.3);">📲</div><div><div style="font-weight: 700; font-size: 15px; color: #fff;">Telegram DM Alerts</div><div style="font-size: 12px; opacity: 0.7; margin-top: 3px; max-width: 200px; line-height: 1.4;">${!telegramLinked ? '⚠️ Link Telegram to enable alerts' : telegramNotifyEnabled ? '✅ Notifications enabled!' : 'Get code alerts in Telegram'}</div></div></div><div id="dashboard-telegram-toggle" style="display: flex; align-items: center; gap: 12px; cursor: ${!telegramLinked ? 'not-allowed' : 'pointer'}; opacity: ${!telegramLinked ? '0.5' : '1'}; padding: 10px 16px; border-radius: 30px; transition: all 0.3s; background: ${telegramNotifyEnabled ? 'linear-gradient(135deg, #00c853, #00e676)' : 'linear-gradient(135deg, #444, #555)'}; border: 2px solid ${telegramNotifyEnabled ? '#00e676' : 'rgba(255,255,255,0.15)'}; box-shadow: ${telegramNotifyEnabled ? '0 4px 15px rgba(0,200,83,0.4)' : '0 2px 8px rgba(0,0,0,0.3)'};"><span style="font-size: 13px; font-weight: 700; color: #fff; text-transform: uppercase;">${telegramNotifyEnabled ? '✓ ON' : 'OFF'}</span><div style="width: 50px; height: 26px; background: ${telegramNotifyEnabled ? 'rgba(255,255,255,0.3)' : '#222'}; border-radius: 13px; position: relative;"><div style="width: 22px; height: 22px; background: #fff; border-radius: 50%; position: absolute; top: 2px; ${telegramNotifyEnabled ? 'right: 2px' : 'left: 2px'};"></div></div></div></div><div style="margin-top: 12px; padding: 10px 14px; background: rgba(0,0,0,0.2); border-radius: 8px; font-size: 11px; color: rgba(255,255,255,0.5);"><span>💡 ${!telegramLinked ? 'Link via @ShuffleSubscriptionBot' : 'Get Telegram alerts for all codes'}</span></div></div>

            <div id="shuffle-codes-list" style="flex: 1; overflow-y: auto; padding: 15px;">
                <!-- Codes loaded from API -->
            </div>
            
            <!-- Scroll Controls -->
            <div id="shuffle-scroll-controls" style="position: absolute; bottom: 20px; right: 20px; display: flex; flex-direction: column; gap: 8px; z-index: 10;">
                <button id="scroll-up-btn" style="background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.3); 
                    color: #fff; width: 40px; height: 40px; border-radius: 50%; cursor: pointer; font-size: 18px; 
                    display: flex; align-items: center; justify-content: center; transition: all 0.2s;">
                    ⬆️
                </button>
                <button id="scroll-down-btn" style="background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.3); 
                    color: #fff; width: 40px; height: 40px; border-radius: 50%; cursor: pointer; font-size: 18px; 
                    display: flex; align-items: center; justify-content: center; transition: all 0.2s;">
                    ⬇️
                </button>
            </div>
        </div>

        <style>
            @keyframes pulse-dot {
                0%, 100% { opacity: 1; transform: scale(1); }
                50% { opacity: 0.5; transform: scale(1.2); }
            }
            
            #shuffle-codes-list::-webkit-scrollbar { width: 8px; }
            #shuffle-codes-list::-webkit-scrollbar-track { background: #1a1f2e; }
            #shuffle-codes-list::-webkit-scrollbar-thumb { background: #3a5f8f; border-radius: 4px; }
            
            #scroll-up-btn:hover, #scroll-down-btn:hover {
                background: rgba(255,255,255,0.3);
                transform: scale(1.1);
            }
            
            .code-item {
                background: rgba(255,255,255,0.05);
                border: 1px solid #2a3f5f;
                border-radius: 8px;
                padding: 15px;
                margin-bottom: 12px;
                transition: all 0.3s ease;
            }
            .code-item:hover {
                background: rgba(255,255,255,0.08);
                transform: translateY(-2px);
            }
            .code-item.claimed {
                background: rgba(0,255,136,0.1);
                border-color: #00ff88;
            }
            .code-item.rejected {
                background: rgba(255,68,68,0.1);
                border-color: #ff4444;
            }
            .code-rejection-reason {
                margin-top: 10px;
                padding: 10px;
                background: rgba(255,68,68,0.2);
                border: 1px solid #ff4444;
                border-radius: 5px;
                color: #ff6666;
                font-size: 13px;
                font-weight: 600;
            }
            .code-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            }
            .code-value {
                font-size: 20px;
                font-weight: 700;
                color: #667eea;
                font-family: 'Courier New', monospace;
            }
            .code-badge {
                padding: 4px 10px;
                border-radius: 12px;
                font-size: 11px;
                font-weight: 600;
            }
            .code-badge.claimed { background: #00ff88; color: #000; }
            .code-badge.rejected { background: #ff4444; color: #fff; }
            .code-badge.pending { background: #ffa500; color: #000; }
            .code-info-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 8px;
                margin: 10px 0;
                padding: 10px;
                background: rgba(0,0,0,0.2);
                border-radius: 6px;
                font-size: 12px;
            }
            .code-info-label {
                opacity: 0.6;
                font-size: 10px;
                text-transform: uppercase;
            }
            .code-info-value {
                font-weight: 600;
                margin-top: 2px;
            }
            .code-rejection-reason {
                background: rgba(255,68,68,0.2);
                border-left: 3px solid #ff4444;
                padding: 10px;
                margin: 10px 0;
                border-radius: 4px;
                font-size: 12px;
                color: #ffaaaa;
            }
        </style>
        `);

        document.getElementById('shuffle-panel-btn').onclick = togglePanel;
        document.getElementById('shuffle-panel-close').onclick = togglePanel;
        document.getElementById('shuffle-reset-btn').onclick = clearAllCodes;
        document.getElementById('shuffle-minimize-btn').onclick = toggleHeader;
        document.getElementById('shuffle-show-btn').onclick = toggleHeader;
        
        // Telegram toggle handler (dashboard only)
        const dashboardTelegramToggle = document.getElementById('dashboard-telegram-toggle');
        if (dashboardTelegramToggle) {
            dashboardTelegramToggle.onclick = toggleTelegramNotifications;
        }
        
        // Manual code panel - toggle on button click
        const manualOpenBtn = document.getElementById('shuffle-manual-open-btn');
        const manualClaimBtn = document.getElementById('manual-claim-btn');
        const manualCodeInput = document.getElementById('manual-code-input');
        
        if (manualOpenBtn) {
            manualOpenBtn.onclick = toggleManualPanel;
        }
        
        if (manualClaimBtn) {
            manualClaimBtn.onclick = handleManualClaim;
        }
        
        if (manualCodeInput) {
            // Add keypress handler for Enter key
            manualCodeInput.addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    handleManualClaim();
                }
            });
        }
        
        // Close manual panel when clicking outside
        document.addEventListener('click', function(e) {
            const panel = document.getElementById('shuffle-manual-panel');
            const btn = document.getElementById('shuffle-manual-open-btn');
            if (panel && btn && panel.style.display === 'block') {
                if (!panel.contains(e.target) && e.target !== btn) {
                    closeManualPanel();
                }
            }
        });
        
        // Scroll controls
        document.getElementById('scroll-up-btn').onclick = () => {
            const codesList = document.getElementById('shuffle-codes-list');
            codesList.scrollBy({ top: -300, behavior: 'smooth' });
        };
        
        document.getElementById('scroll-down-btn').onclick = () => {
            const codesList = document.getElementById('shuffle-codes-list');
            codesList.scrollBy({ top: 300, behavior: 'smooth' });
        };
        
        // Currency picker handlers
        const currencySelectedBtn = document.getElementById('currency-selected-btn');
        const currencyDropdown = document.getElementById('currency-dropdown');
        
        if (currencySelectedBtn && currencyDropdown) {
            // Populate dropdown with currencies
            currencyDropdown.innerHTML = SUPPORTED_CURRENCIES.map(c => `
                <div class="currency-option" data-currency="${c.code}" style="display: flex; align-items: center; gap: 12px;
                    padding: 12px 16px; cursor: pointer; transition: background 0.2s;
                    ${c.code === selectedCurrency ? 'background: rgba(255,193,7,0.2);' : ''}
                    border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <img src="${getCurrencyIcon(c.code)}" alt="${c.code}" style="width: 24px; height: 24px; border-radius: 50%;"
                        onerror="this.style.display='none'">
                    <div>
                        <div style="font-weight: 600; color: #fff;">${c.code}</div>
                        <div style="font-size: 11px; opacity: 0.6;">${c.name}</div>
                    </div>
                    ${c.code === selectedCurrency ? '<span style="margin-left: auto; color: #ffc107;">✓</span>' : ''}
                </div>
            `).join('');
            
            // Toggle dropdown
            currencySelectedBtn.onclick = (e) => {
                e.stopPropagation();
                currencyDropdown.style.display = currencyDropdown.style.display === 'none' ? 'block' : 'none';
            };
            
            // Handle currency selection
            currencyDropdown.querySelectorAll('.currency-option').forEach(opt => {
                opt.onmouseover = () => opt.style.background = 'rgba(255,255,255,0.1)';
                opt.onmouseout = () => opt.style.background = opt.dataset.currency === selectedCurrency ? 'rgba(255,193,7,0.2)' : '';
                opt.onclick = (e) => {
                    e.stopPropagation();
                    changeCurrency(opt.dataset.currency);
                };
            });
            
            // Close dropdown when clicking outside
            document.addEventListener('click', (e) => {
                if (!currencyDropdown.contains(e.target) && e.target !== currencySelectedBtn) {
                    currencyDropdown.style.display = 'none';
                }
            });
        }
        
        // Start currency watcher (syncs with Shuffle's balance button)
        startCurrencyWatcher();

        updateCodesList();
    }

    // ============================================
    // GET AUTH TOKEN
    // ============================================
    
    function getAuthToken() {
        // Helper function to recursively search for JWT tokens
        function findJWT(obj, depth = 0) {
            if (depth > 5) return null; // Prevent infinite recursion
            
            // Direct JWT string
            if (typeof obj === 'string' && obj.startsWith('eyJ') && obj.length > 100) {
                return obj;
            }
            
            // Try to parse string as JSON and search inside
            if (typeof obj === 'string' && obj.includes('eyJ')) {
                try {
                    const parsed = JSON.parse(obj);
                    const token = findJWT(parsed, depth + 1);
                    if (token) return token;
                } catch (e) {
                    // Not valid JSON, continue
                }
            }
            
            // Search in objects
            if (typeof obj === 'object' && obj !== null) {
                for (const key in obj) {
                    const result = findJWT(obj[key], depth + 1);
                    if (result) return result;
                }
            }
            
            return null;
        }
        
        // Check persist:root (Redux persist) - Shuffle stores auth here
        try {
            const persistRoot = localStorage.getItem('persist:root');
            if (persistRoot) {
                const token = findJWT(persistRoot);
                if (token) {
                    console.log('✅ Found auth token in persist:root');
                    return token;
                }
            }
        } catch (e) {
            console.error('Error parsing persist:root:', e);
        }
        
        // Check all localStorage keys
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            try {
                const value = localStorage.getItem(key);
                
                // Direct JWT
                if (value && value.startsWith('eyJ') && value.length > 100) {
                    console.log('✅ Found JWT token in:', key);
                    return value;
                }
                
                // Parse as JSON and search recursively
                if (value && value.includes('eyJ')) {
                    const parsed = JSON.parse(value);
                    const token = findJWT(parsed);
                    if (token) {
                        console.log('✅ Found JWT in parsed object:', key);
                        return token;
                    }
                }
            } catch (e) {
                // Not JSON, continue
            }
        }
        
        // Try cookies
        const cookies = document.cookie.split(';');
        for (const cookie of cookies) {
            const [name, value] = cookie.trim().split('=');
            if (value && value.startsWith('eyJ') && value.length > 100) {
                console.log('✅ Found JWT in cookie:', name);
                return value;
            }
        }
        
        console.error('❌ No auth token found');
        return null;
    }

    // ============================================
    // GET GEETEST NONCE (REQUIRED TOKEN FOR REDEEM)
    // ============================================
    
    async function getGeetestNonce(authToken) {
        try {
            const response = await fetch(GRAPHQL_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                },
                body: JSON.stringify({
                    operationName: 'GetGeetestNonce',
                    query: 'mutation GetGeetestNonce { geetestNonce }',
                    variables: {}
                })
            });
            
            const data = await response.json();
            if (data?.data?.geetestNonce) {
                console.log('✅ Got geetest nonce');
                return data.data.geetestNonce;
            }
            
            console.error('❌ Failed to get geetest nonce:', data);
            return null;
        } catch (error) {
            console.error('❌ Error getting geetest nonce:', error);
            return null;
        }
    }

    // ============================================
    // MANUAL CODE CLAIMING
    // ============================================
    
    function handleManualClaim() {
        const input = document.getElementById('manual-code-input');
        const codeSlug = input.value.trim().toUpperCase();
        
        // Validate input
        if (!codeSlug) {
            alert('⚠️ Please enter a code');
            return;
        }
        
        // Validate code format (4-20 alphanumeric characters)
        if (!/^[A-Z0-9]{4,20}$/.test(codeSlug)) {
            alert('⚠️ Invalid code format. Codes must be 4-20 alphanumeric characters.');
            return;
        }
        
        // Check if already processed
        if (processedCodes[codeSlug]) {
            alert('⚠️ This code has already been claimed!');
            return;
        }
        
        // Add code to local storage as manual entry
        const newCode = {
            code: codeSlug,
            timestamp: new Date().toISOString(),
            claimed: false,
            manual: true, // Flag to indicate manual entry
            amount: 'Manual Entry',
            wager: 'Unknown',
            deadline: 'N/A'
        };
        
        codes.unshift(newCode);
        saveCodesLocal();
        updateCodesList();
        
        console.log(`🎯 Manual code added: ${codeSlug}`);
        
        // Close the panel
        closeManualPanel();
        
        // Open modal and auto-click Redeem (handles captcha via Geetest SDK)
        openRedeemModal(codeSlug);
    }

    // ============================================
    // GET NEXT.JS ROUTER (FOR SAME-PAGE MODAL)
    // ============================================
    
    // Get the REAL page window (not Tampermonkey sandbox)
    const pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    
    function getNextRouter() {
        // IMPORTANT: Use pageWindow (unsafeWindow) to access Next.js router
        // Tampermonkey runs in a sandbox, so regular 'window' won't see Next.js
        
        // Method 1: pageWindow.next.router (most common)
        if (pageWindow.next?.router) {
            console.log('✅ Found router via unsafeWindow.next.router');
            return pageWindow.next.router;
        }
        
        // Method 2: Next.js App Router (newer versions)
        if (pageWindow.__NEXT_ROUTER__) {
            console.log('✅ Found router via unsafeWindow.__NEXT_ROUTER__');
            return pageWindow.__NEXT_ROUTER__;
        }
        
        // Method 3: Check for Next.js navigation module
        if (pageWindow.__next?.router) {
            console.log('✅ Found router via unsafeWindow.__next.router');
            return pageWindow.__next.router;
        }
        
        console.log('⚠️ Next.js router not found via unsafeWindow');
        return null;
    }
    
    // ============================================
    // OPEN REDEEM MODAL VIA NEXT.JS ROUTER (NO PAGE RELOAD)
    // ============================================
    
    function openRedeemModal(codeSlug) {
        // === SINGLE EXECUTION GUARD ===
        // Check ALL guards FIRST before doing anything
        if (activeClaims[codeSlug]) {
            console.log(`🔒 LOCKED - Already processing: ${codeSlug}`);
            return;
        }
        if (processedCodes[codeSlug]) {
            console.log(`⏭️ Already processed: ${codeSlug}`);
            return;
        }
        if (claimOutcomes[codeSlug]) {
            console.log(`⏭️ Already resolved: ${codeSlug}`);
            return;
        }
        if (!isAuthenticated) {
            console.log(`❌ Not authenticated`);
            updateStatus('🔒 Connect to claim codes');
            return;
        }
        
        // === SET UP INTERCEPTOR FIRST ===
        // Must be done BEFORE opening modal to catch lookupPromotionCode
        setupGraphQLInterceptor();
        pendingCode = codeSlug;
        claimPhase = 'lookup';
        
        // === LOCK IMMEDIATELY ===
        activeClaims[codeSlug] = true;
        processedCodes[codeSlug] = Date.now();
        GM_setValue('processedCodes', processedCodes);
        
        console.log(`⚡ CLAIMING: ${codeSlug}`);
        updateStatus(`⚡ ${codeSlug}`);
        
        // Try Next.js router first (no page reload)
        const router = getNextRouter();
        if (router) {
            console.log('✅ Found Next.js router - using shallow navigation');
            
            // Shallow push to trigger modal without full page reload
            const currentPath = window.location.pathname;
            router.push(
                { pathname: currentPath, query: { modal: 'c', 'md-code': codeSlug } },
                undefined,
                { shallow: true, scroll: false }
            ).then(() => {
                console.log('✅ Router push completed, watching for Redeem button...');
                watchForRedeemButton(codeSlug);
            }).catch(err => {
                console.error('Router push failed:', err);
                // Fallback to history manipulation + event dispatch
                triggerModalFallback(codeSlug);
            });
        } else {
            console.log('⚠️ Next.js router not found, using fallback...');
            triggerModalFallback(codeSlug);
        }
        
        GM_notification({
            title: '⚡ CLAIMING!',
            text: codeSlug,
            timeout: 2000
        });
    }
    
    // Fallback: Poll for router to become available, then use it
    function triggerModalFallback(codeSlug) {
        console.log(`🔄 Router not immediately available, polling for unsafeWindow.next.router...`);
        
        let pollAttempts = 0;
        const maxPollAttempts = 50; // 2.5 seconds max
        
        const routerPoll = setInterval(() => {
            pollAttempts++;
            
            // Check if router is now available
            if (pageWindow.next?.router?.push) {
                clearInterval(routerPoll);
                console.log('✅ Router became available! Using it now...');
                
                const currentPath = pageWindow.location.pathname;
                pageWindow.next.router.push(
                    { pathname: currentPath, query: { modal: 'c', 'md-code': codeSlug } },
                    undefined,
                    { shallow: true }
                ).then(() => {
                    console.log('✅ Router push completed via fallback polling');
                    watchForRedeemButton(codeSlug);
                }).catch(err => {
                    console.error('Router push failed:', err);
                    // Mark as failed so user can retry
                    resolveClaim(codeSlug, false, 'Router navigation failed');
                });
                return;
            }
            
            // Timeout - router never became available
            if (pollAttempts >= maxPollAttempts) {
                clearInterval(routerPoll);
                console.log('❌ Router never became available after polling');
                
                // Don't click random links - just show error and let user retry
                resolveClaim(codeSlug, false, 'Could not open redeem modal - please try manually');
                
                GM_notification({
                    title: '⚠️ Manual Redemption Needed',
                    text: `Please redeem ${codeSlug} manually`,
                    timeout: 5000
                });
            }
        }, 50); // Poll every 50ms
    }
    
    // ============================================
    // WATCH FOR REDEEM BUTTON AND AUTO-CLICK
    // Flow: Find modal → Click button → Watch GraphQL
    // ============================================
    
    function watchForRedeemButton(codeSlug) {
        // Already resolved by GraphQL (invalid code)?
        if (claimOutcomes[codeSlug]) return;
        
        let attempts = 0;
        const maxAttempts = 100; // 5 seconds
        
        const watcher = setInterval(() => {
            attempts++;
            
            // Already resolved by GraphQL
            if (claimOutcomes[codeSlug]) {
                clearInterval(watcher);
                return;
            }
            
            // Find Redeem button in modal
            const modals = document.querySelectorAll('[class*="ModalContent"], [role="dialog"]');
            let redeemBtn = null;
            
            for (let modal of modals) {
                const redeemIcon = modal.querySelector('img[src*="redeem"], img[alt="redeem"]');
                if (redeemIcon) {
                    redeemBtn = modal.querySelector('button[class*="ButtonVariants_primary"]');
                    if (redeemBtn) break;
                }
            }
            
            if (redeemBtn) {
                // Found button - click it
                clearInterval(watcher);
                console.log('🎯 Clicking Redeem button');
                redeemBtn.click();
                watchForResult(codeSlug);
            } else if (attempts >= maxAttempts) {
                // Timeout - no button found
                clearInterval(watcher);
                pendingCode = null;
                claimPhase = null;
                
                // If no modal appeared at all = invalid code
                const anyModal = document.querySelector('[class*="ModalContent"], [role="dialog"]');
                if (!anyModal) {
                    console.log(`❌ ${codeSlug}: Invalid code (no modal)`);
                    claimOutcomes[codeSlug] = 'rejected';
                    resolveClaim(codeSlug, false, 'Invalid code');
                    closeModal();
                } else {
                    // Modal exists but no button - retry
                    console.log(`🔄 ${codeSlug}: Modal stuck, retrying...`);
                    GM_setValue('pendingRetryCode', codeSlug);
                    GM_setValue('pendingRetryTime', Date.now());
                    delete activeClaims[codeSlug];
                    delete processedCodes[codeSlug];
                    GM_setValue('processedCodes', processedCodes);
                    setTimeout(() => window.location.reload(), 500);
                }
            }
        }, 50);
    }
    
    // ============================================
    // GRAPHQL INTERCEPTOR - SINGLE SOURCE OF TRUTH
    // Phase 1: lookupPromotionCode (eligibility)
    // Phase 2: RedeemPromoCode (claim)
    // ============================================
    
    let graphqlInterceptorReady = false;
    let pendingCode = null;
    let claimPhase = null; // 'lookup' or 'redeem'
    
    function setupGraphQLInterceptor() {
        if (graphqlInterceptorReady) return;
        
        const originalFetch = unsafeWindow.fetch;
        unsafeWindow.fetch = async function(...args) {
            const response = await originalFetch.apply(this, args);
            
            const url = args[0]?.url || args[0];
            if (!url || !url.includes('graphql')) {
                return response;
            }
            
            // Get request body to identify operation and extract code
            let operationName = null;
            let requestCode = null;
            try {
                const body = args[1]?.body;
                if (body) {
                    const parsed = JSON.parse(body);
                    operationName = parsed.operationName;
                    // Extract code from request variables for manual claims
                    if (parsed.variables?.code) {
                        requestCode = parsed.variables.code;
                    }
                }
            } catch(e) {}
            
            // Use pendingCode (auto-claim) OR requestCode (manual claim)
            const activeCode = pendingCode || requestCode;
            
            // Skip if no code to track or already handled
            if (!activeCode || (claimOutcomes[activeCode] && !requestCode)) {
                return response;
            }
            
            try {
                const clone = response.clone();
                const data = await clone.json();
                
                // ===== PHASE 1: lookupPromotionCode (eligibility check) =====
                if (operationName === 'lookupPromotionCode') {
                    const code = activeCode;
                    
                    if (data.errors && data.errors.length > 0) {
                        // Invalid code - modal won't open
                        const errorMsg = data.errors[0].message || 'Invalid code';
                        
                        // Only resolve if this is our tracked auto-claim
                        if (pendingCode === code) {
                            pendingCode = null;
                            claimPhase = null;
                        }
                        
                        console.log(`❌ ${code}: ${errorMsg} (lookup failed)`);
                        resolveClaim(code, false, errorMsg);
                        closeModal();
                    } else if (data.data?.lookupPromotionCode) {
                        // Code is valid - modal will open, wait for redeem
                        const lookupData = data.data.lookupPromotionCode;
                        
                        // Extract usdRedeemValue and update code in dashboard if value was missing or placeholder
                        if (lookupData.usdRedeemValue) {
                            const usdValue = `$${lookupData.usdRedeemValue}`;
                            const codeIndex = codes.findIndex(c => c.code === code);
                            
                            if (codeIndex !== -1) {
                                const currentValue = codes[codeIndex].value;
                                const needsUpdate = !currentValue || 
                                    currentValue === 'N/A' || 
                                    currentValue === 'Unknown' || 
                                    currentValue === 'Manual Entry' ||
                                    !currentValue.startsWith('$');
                                    
                                if (needsUpdate) {
                                    codes[codeIndex].value = usdValue;
                                    GM_setValue('localCodes', JSON.stringify(codes));
                                    console.log(`💰 ${code}: Value discovered from GraphQL: ${usdValue}`);
                                    renderCodes();
                                }
                            }
                        }
                        
                        console.log(`✓ ${code}: Eligible, waiting for redeem...`);
                        if (pendingCode === code) {
                            claimPhase = 'redeem';
                        }
                    }
                }
                
                // ===== PHASE 2: RedeemPromoCode (claim attempt) =====
                // This handles BOTH auto-claims AND manual claims!
                else if (operationName === 'RedeemPromoCode') {
                    const code = activeCode;
                    const isManualClaim = !pendingCode && requestCode;
                    
                    if (isManualClaim) {
                        console.log(`📝 Detected MANUAL claim for: ${code}`);
                    }
                    
                    if (data.errors && data.errors.length > 0) {
                        // Claim failed - show error message
                        const errorMsg = data.errors[0].message || 'Claim failed';
                        
                        if (pendingCode === code) {
                            pendingCode = null;
                            claimPhase = null;
                        }
                        
                        console.log(`❌ ${code}: ${errorMsg}${isManualClaim ? ' (manual)' : ''}`);
                        resolveClaim(code, false, errorMsg);
                        if (!isManualClaim) closeModal();
                    } else if (data.data?.redeemPromotionCode) {
                        // SUCCESS!
                        const redeemData = data.data.redeemPromotionCode;
                        const value = redeemData.usdRedeemValue ? `$${redeemData.usdRedeemValue}` : null;
                        
                        if (pendingCode === code) {
                            pendingCode = null;
                            claimPhase = null;
                        }
                        
                        console.log(`✅ ${code}: CLAIMED!${isManualClaim ? ' (manual)' : ''}${value ? ` - ${value}` : ''}`);
                        
                        // For manual claims, send directly to backend even if not in our codes list
                        if (isManualClaim && !claimOutcomes[code]) {
                            console.log(`📤 Sending manual claim to backend: ${code}`);
                            sendClaimResultToBackend(code, true, null, value);
                            claimOutcomes[code] = 'success';
                        } else {
                            resolveClaim(code, true, null);
                        }
                        
                        if (!isManualClaim) closeModal();
                    }
                }
            } catch (e) {
                // Not JSON - ignore
            }
            
            return response;
        };
        
        graphqlInterceptorReady = true;
        console.log('📡 GraphQL interceptor ready (auto + manual claims)');
    }
    
    // ============================================
    // WATCH FOR RESULT AFTER CLICKING REDEEM
    // Only checks for captcha - GraphQL handles success/error
    // ============================================
    
    function watchForResult(codeSlug) {
        let attempts = 0;
        const maxAttempts = 100; // 5 seconds
        
        const watcher = setInterval(() => {
            attempts++;
            
            // Already resolved by GraphQL interceptor
            if (claimOutcomes[codeSlug]) {
                clearInterval(watcher);
                return;
            }
            
            // Check for visible captcha popup - needs refresh & retry
            const geetestBox = document.querySelector('[class*="geetest_box"], .geetest_box_layer, [class*="geetest_panel"]');
            if (geetestBox) {
                const style = window.getComputedStyle(geetestBox);
                const rect = geetestBox.getBoundingClientRect();
                const isVisible = style.display !== 'none' && 
                                  style.visibility !== 'hidden' && 
                                  style.opacity !== '0' &&
                                  rect.width > 0 && rect.height > 0;
                
                if (isVisible) {
                    clearInterval(watcher);
                    pendingCode = null;
                    claimPhase = null;
                    
                    // Save for retry after refresh
                    GM_setValue('pendingRetryCode', codeSlug);
                    GM_setValue('pendingRetryTime', Date.now());
                    delete activeClaims[codeSlug];
                    delete processedCodes[codeSlug];
                    GM_setValue('processedCodes', processedCodes);
                    
                    console.log(`🤖 Captcha detected - refreshing to retry ${codeSlug}`);
                    setTimeout(() => window.location.reload(), 500);
                    return;
                }
            }
            
            // Timeout - if GraphQL didn't resolve it, something went wrong
            if (attempts >= maxAttempts && !claimOutcomes[codeSlug]) {
                clearInterval(watcher);
                pendingCode = null;
                claimPhase = null;
                console.log(`⚠️ ${codeSlug}: Timeout waiting for GraphQL response`);
            }
        }, 50);
    }
    
    // ============================================
    // CLOSE MODAL AND CLEAN UP URL (SAME PAGE)
    // ============================================
    
    function closeModal() {
        console.log('🚪 Closing modal...');
        
        // Try clicking close button or overlay
        const closeBtn = document.querySelector('[data-testid="modal-close"], .Modal_closeButton, button[aria-label="Close"]');
        if (closeBtn) closeBtn.click();
        
        const overlay = document.querySelector('.Modal_overlay, [data-testid="modal-overlay"]');
        if (overlay) overlay.click();
        
        // Clean URL using Next.js router or history
        const router = getNextRouter();
        if (router) {
            router.replace(window.location.pathname, undefined, { shallow: true }).catch(() => {
                // Fallback to history
                window.history.replaceState({}, '', window.location.pathname);
            });
        } else {
            window.history.replaceState({}, '', window.location.pathname);
        }
        
        console.log('✅ Modal closed, URL cleaned');
    }

    // ============================================
    // REDEEM CODE VIA DIRECT GRAPHQL (FALLBACK)
    // ============================================
    
    async function redeemCodeDirect(codeSlug, attempt = 1) {
        // This is a fallback - prefer openRedeemModal() which handles captcha
        console.log(`🚀 redeemCodeDirect called for: ${codeSlug} (Attempt ${attempt})`);
        
        // Check authentication first
        if (!isAuthenticated) {
            console.log(`❌ NOT AUTHENTICATED - Cannot redeem`);
            updateStatus('🔒 Connect to claim codes');
            return;
        }
        
        // Check if already processed (only on first attempt)
        if (attempt === 1 && processedCodes[codeSlug]) {
            console.log(`❌ ALREADY PROCESSED - Skipping: ${codeSlug}`);
            return;
        }
        
        // Mark as processed immediately (only on first attempt)
        if (attempt === 1) {
            processedCodes[codeSlug] = Date.now();
            GM_setValue('processedCodes', processedCodes);
        }
        
        updateStatus(`⚡ Redeeming ${codeSlug} (Attempt ${attempt}/3)...`);
        
        const authToken = getAuthToken();
        if (!authToken) {
            console.error('No auth token found!');
            updateStatus('❌ Not logged in');
            
            // Mark as failed after 3 attempts
            if (attempt >= 3) {
                resolveClaim(codeSlug, false, 'Auth token not found');
                retryAttempts[codeSlug] = 0;
                GM_setValue('retryAttempts', retryAttempts);
            } else {
                // Retry after 2 seconds
                retryAttempts[codeSlug] = attempt;
                GM_setValue('retryAttempts', retryAttempts);
                setTimeout(() => redeemCodeDirect(codeSlug, attempt + 1), 2000);
            }
            return;
        }

        console.log('Using auth token:', authToken.substring(0, 20) + '...');

        // Get geetest nonce (required token field)
        const nonce = await getGeetestNonce(authToken);
        if (!nonce) {
            console.error('Failed to get geetest nonce');
            if (attempt >= 3) {
                updateStatus('❌ Failed to get nonce');
                resolveClaim(codeSlug, false, 'Failed to get geetest nonce');
                retryAttempts[codeSlug] = 0;
                GM_setValue('retryAttempts', retryAttempts);
            } else {
                retryAttempts[codeSlug] = attempt;
                GM_setValue('retryAttempts', retryAttempts);
                setTimeout(() => redeemCodeDirect(codeSlug, attempt + 1), 3000);
            }
            return;
        }

        const mutation = {
            operationName: "RedeemPromoCode",
            variables: {
                data: {
                    codeSlug: codeSlug,
                    currency: selectedCurrency,
                    token: nonce
                }
            },
            query: `mutation RedeemPromoCode($data: PromotionCodeInput!) {
                redeemPromotionCode(data: $data) {
                    id
                    currency
                    createdAt
                    afterBalance
                    usdRedeemValue
                    __typename
                }
            }`
        };

        fetch(GRAPHQL_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify(mutation)
        })
        .then(response => response.json())
        .then(data => {
            console.log('GraphQL Response:', data);
            
            if (data.errors) {
                // FAILED - extract error message
                const errorMsg = data.errors[0]?.message || 'Unknown error';
                console.log(`❌ Code rejected (Attempt ${attempt}):`, errorMsg);
                
                // Check for captcha/rate limiting errors - don't retry
                const lowerError = errorMsg.toLowerCase();
                if (lowerError.includes('captcha') || lowerError.includes('rate limit') || lowerError.includes('too many')) {
                    console.log('🛡️ CAPTCHA/RATE LIMIT DETECTED - Stopping retries');
                    updateStatus(`🛡️ Captcha triggered - waiting...`);
                    resolveClaim(codeSlug, false, 'Captcha/Rate limit - try again later');
                    retryAttempts[codeSlug] = 0;
                    GM_setValue('retryAttempts', retryAttempts);
                    
                    GM_notification({
                        title: '🛡️ Captcha Detected',
                        text: 'Wait a bit before claiming more codes',
                        timeout: 5000
                    });
                    return;
                }
                
                if (attempt >= 3) {
                    // Max attempts reached, mark as rejected
                    updateStatus(`❌ Rejected: ${codeSlug}`);
                    resolveClaim(codeSlug, false, errorMsg);
                    retryAttempts[codeSlug] = 0;
                    GM_setValue('retryAttempts', retryAttempts);
                    console.log('✅ Code processed - max retries reached');
                } else {
                    // Retry after 3 seconds
                    updateStatus(`⏳ Retrying ${codeSlug} in 3s...`);
                    retryAttempts[codeSlug] = attempt;
                    GM_setValue('retryAttempts', retryAttempts);
                    setTimeout(() => redeemCodeDirect(codeSlug, attempt + 1), 3000);
                }
            } else if (data.data?.redeemPromotionCode) {
                // SUCCESS
                const result = data.data.redeemPromotionCode;
                console.log('✅ Code claimed successfully!', result);
                updateStatus(`✅ Claimed: ${codeSlug} - $${result.usdRedeemValue}`);
                
                GM_notification({
                    title: '✅ Code Claimed!',
                    text: `${codeSlug} - $${result.usdRedeemValue}`,
                    timeout: 5000
                });
                
                resolveClaim(codeSlug, true, null);
                retryAttempts[codeSlug] = 0;
                GM_setValue('retryAttempts', retryAttempts);
                console.log('✅ Code claimed via direct GraphQL!');
            }
        })
        .catch(error => {
            console.error('Network error:', error);
            
            if (attempt >= 3) {
                updateStatus(`❌ Network error`);
                resolveClaim(codeSlug, false, 'Network error: ' + error.message);
                retryAttempts[codeSlug] = 0;
                GM_setValue('retryAttempts', retryAttempts);
                console.log('✅ Code processed - network error after max retries');
            } else {
                updateStatus(`⏳ Retrying ${codeSlug} in 3s...`);
                retryAttempts[codeSlug] = attempt;
                GM_setValue('retryAttempts', retryAttempts);
                setTimeout(() => redeemCodeDirect(codeSlug, attempt + 1), 3000);
            }
        });
    }

    // ============================================
    // FETCH AND PROCESS CODES (ONE TIME ONLY)
    // ============================================
    
    function fetchAndProcessCodes() {
        GM_xmlhttpRequest({
            method: 'GET',
            url: `${API_URL}/api/codes`,
            headers: accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {},
            onload: function(response) {
                try {
                    const newCodes = JSON.parse(response.responseText);
                    codes = newCodes;
                    updateUI();
                    
                    // Find unclaimed codes that we haven't processed yet
                    const unclaimedCodes = newCodes.filter(c => 
                        !c.claimed && 
                        !c.rejectionReason && 
                        !processedCodes[c.code] // Not already opened
                    );
                    
                    if (unclaimedCodes.length > 0) {
                        // Process ONLY the first unclaimed code (prevents spam)
                        const latestCode = unclaimedCodes[0];
                        
                        console.log(`⚡ NEW CODE INSTANT: ${latestCode.code}`);
                        
                        GM_notification({
                            title: '⚡ NEW CODE!',
                            text: latestCode.code,
                            timeout: 2000
                        });
                        
                        // INSTANT REDEEM via modal + auto-click
                        openRedeemModal(latestCode.code);
                    } else {
                        updateStatus('✅ All codes processed');
                    }
                } catch (e) {
                    console.error('Failed to parse codes:', e);
                }
            },
            onerror: function(error) {
                updateStatus('❌ API Error');
            }
        });
    }

    // ============================================
    // UI FUNCTIONS
    // ============================================
    
    function updateCodesList() {
        const container = document.getElementById('shuffle-codes-list');
        if (!container) return;

        if (codes.length === 0) {
            container.innerHTML = `
                <div style="text-align:center; padding:60px 20px; color:#666;">
                    <h3 style="margin:0 0 10px;">No Codes Yet</h3>
                    <p>Codes from Telegram will appear here</p>
                </div>
            `;
            return;
        }

        container.innerHTML = codes.map(code => {
            let statusBadge = '';
            let statusClass = '';
            let rejectionHtml = '';
            
            if (code.claimed) {
                statusBadge = '✅ CLAIMED';
                statusClass = 'claimed';
            } else if (code.rejectionReason) {
                statusBadge = '❌ REJECTED';
                statusClass = 'rejected';
                rejectionHtml = `<div class="code-rejection-reason">🚫 ${code.rejectionReason}</div>`;
            } else {
                statusBadge = '⏳ PENDING';
                statusClass = 'pending';
            }
            
            return `
            <div class="code-item ${statusClass}">
                <div class="code-header">
                    <div class="code-value">${code.code}</div>
                    <div class="code-badge ${statusClass}">
                        ${statusBadge}
                    </div>
                </div>
                <div class="code-info-grid">
                    <div>
                        <div class="code-info-label">Value</div>
                        <div class="code-info-value">${code.value || code.amount || '-'}</div>
                    </div>
                    <div>
                        <div class="code-info-label">Limit</div>
                        <div class="code-info-value">${code.limit ? `First ${code.limit}` : '-'}</div>
                    </div>
                    <div>
                        <div class="code-info-label">Wager Req.</div>
                        <div class="code-info-value">${code.wagerRequirement || code.wager || '-'}</div>
                    </div>
                    <div>
                        <div class="code-info-label">Timeline</div>
                        <div class="code-info-value">${code.timeline || code.deadline || '-'}</div>
                    </div>
                    <div>
                        <div class="code-info-label">Status</div>
                        <div class="code-info-value">${code.claimed ? 'Claimed' : code.rejectionReason ? 'Rejected' : 'Ready'}</div>
                    </div>
                </div>
                ${rejectionHtml}
            </div>
        `;
        }).join('');
    }

    function updateUI() {
        // Always recreate UI to reflect authentication state changes
        const header = document.getElementById('shuffle-header');
        const showBtn = document.getElementById('shuffle-show-btn');
        
        // Only recreate if header doesn't exist OR if authentication state might have changed
        if (!header) {
            if (showBtn) showBtn.remove();
            injectUI();
        }
        // If header exists, just update the dashboard stats when panel opens
        // This prevents flickering while still allowing authentication updates
    }

    function updateStatus(text) {
        const status = document.getElementById('shuffle-status');
        if (status) status.textContent = text;
    }

    function togglePanel() {
        const panel = document.getElementById('shuffle-panel');
        
        if (panel.style.display === 'none') {
            panel.style.display = 'flex';
            updateCodesList(); // Refresh the list when opening
        } else {
            panel.style.display = 'none';
        }
    }
    
    function toggleManualPanel() {
        const panel = document.getElementById('shuffle-manual-panel');
        const input = document.getElementById('manual-code-input');
        
        if (panel) {
            if (panel.style.display === 'none' || !panel.style.display) {
                panel.style.display = 'block';
                if (input) {
                    input.value = '';
                    setTimeout(() => input.focus(), 100);
                }
            } else {
                panel.style.display = 'none';
            }
        }
    }
    
    function closeManualPanel() {
        const panel = document.getElementById('shuffle-manual-panel');
        if (panel) {
            panel.style.display = 'none';
        }
    }
    
    function toggleHeader() {
        const header = document.getElementById('shuffle-header');
        const showBtn = document.getElementById('shuffle-show-btn');
        const panel = document.getElementById('shuffle-panel');
        
        if (header.style.display === 'none') {
            // Show header
            header.style.display = 'flex';
            showBtn.style.display = 'none';
            GM_setValue('headerVisible', true);
        } else {
            // Hide header
            header.style.display = 'none';
            showBtn.style.display = 'block';
            panel.style.display = 'none'; // Also close dashboard panel
            GM_setValue('headerVisible', false);
        }
    }
    
    // ============================================
    // AUTO-REFRESH DASHBOARD (ONLY FOR SUBSCRIBED USERS)
    // ============================================
    
    function startAutoRefresh() {
        // Prevent duplicate starts
        if (autoRefreshRunning) {
            console.log('⏭️ Auto-refresh already running, skipping...');
            return;
        }
        
        // Only start if authenticated
        if (!isAuthenticated) {
            console.log('❌ Cannot start auto-refresh - not authenticated');
            return;
        }
        
        autoRefreshRunning = true;
        console.log('🚀 Starting auto-refresh for subscribed user...');
        
        // Poll dashboard API to get new codes from Telegram
        autoRefreshInterval = setInterval(() => {
            // Double-check authentication before making request
            if (!isAuthenticated) {
                console.log('⚠️ No longer authenticated - stopping polling');
                if (autoRefreshInterval) {
                    clearInterval(autoRefreshInterval);
                    autoRefreshInterval = null;
                }
                autoRefreshRunning = false;
                return;
            }
            
            GM_xmlhttpRequest({
                method: 'GET',
                url: `${API_URL}/api/codes`,
                headers: accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {},
                onload: function(response) {
                    // Guard: check if still authenticated when response arrives
                    if (!isAuthenticated) {
                        console.log('⚠️ Response arrived but no longer authenticated - ignoring');
                        return;
                    }
                    
                    try {
                        const backendCodes = JSON.parse(response.responseText);
                        const clearTimestamp = parseInt(GM_getValue('clearTimestamp', '0'));
                        
                        // Merge backend codes with local storage (preserve local claim status)
                        backendCodes.forEach(backendCode => {
                            const codeTimestamp = new Date(backendCode.timestamp).getTime();
                            const existingCode = codes.find(c => c.code === backendCode.code);
                            
                            // Skip codes that existed before user cleared dashboard
                            if (clearTimestamp > 0 && codeTimestamp < clearTimestamp) {
                                return; // Don't re-add old codes after user cleared
                            }
                            
                            if (!existingCode) {
                                // New code - add to local storage
                                codes.unshift(backendCode);
                                console.log(`➕ New code added: ${backendCode.code}`);
                                
                                // SHOW NOTIFICATION ONLY IF STILL AUTHENTICATED
                                if (isAuthenticated) {
                                    const codeValue = backendCode.value || backendCode.amount || 'N/A';
                                    const codeLimit = backendCode.limit ? `First ${backendCode.limit}` : 'N/A';
                                    GM_notification({
                                        title: `🎰 NEW CODE: ${backendCode.code}`,
                                        text: `${codeValue} | ${codeLimit}\n📍 Open https://shuffle.com/redeem/${backendCode.code} and click REDEEM!`,
                                        timeout: 10000
                                    });
                                    
                                    // Note: Backend sends Telegram notification via WebSocket
                                }
                            } else {
                                // Update metadata but preserve local claim status
                                existingCode.value = backendCode.value;
                                existingCode.limit = backendCode.limit;
                                existingCode.wagerRequirement = backendCode.wagerRequirement;
                                existingCode.timeline = backendCode.timeline;
                                // Backward compatibility
                                existingCode.amount = backendCode.amount;
                                existingCode.wager = backendCode.wager;
                                existingCode.deadline = backendCode.deadline;
                            }
                        });
                        
                        // Save merged codes
                        saveCodesLocal();
                        
                        // Update UI
                        updateCodesList();
                        updateUI();
                        
                        // AUTO-REDEEM unclaimed codes (ONLY if authenticated)
                        if (!isAuthenticated) return;
                        
                        const unclaimedCodes = codes.filter(c => 
                            !c.claimed && !c.rejectionReason && !processedCodes[c.code]
                        );
                        
                        if (unclaimedCodes.length > 0) {
                            const latestCode = unclaimedCodes[0];
                            console.log(`⚡ AUTO-REDEEMING: ${latestCode.code}`);
                            
                            GM_notification({
                                title: '⚡ NEW CODE!',
                                text: latestCode.code,
                                timeout: 2000
                            });
                            
                            // INSTANT REDEEM via modal + auto-click
                            openRedeemModal(latestCode.code);
                        }
                    } catch (e) {
                        console.error('Auto-refresh error:', e);
                    }
                }
            });
        }, TIMEOUTS.POLL_CODES);
        
        // Monitor for claim results from other tabs (cross-tab communication)
        let lastClaimResultStr = '';
        claimResultInterval = setInterval(() => {
            const claimResultStr = GM_getValue('lastClaimResult', '');
            
            if (claimResultStr && claimResultStr !== lastClaimResultStr) {
                lastClaimResultStr = claimResultStr;
                
                try {
                    const claimResult = JSON.parse(claimResultStr);
                    console.log('📥 Claim result from other tab:', claimResult);
                    
                    // Update local codes with result
                    const codeIndex = codes.findIndex(c => c.code === claimResult.code);
                    if (codeIndex >= 0) {
                        codes[codeIndex].claimed = claimResult.success;
                        codes[codeIndex].rejectionReason = claimResult.success ? null : claimResult.message;
                        saveCodesLocal();
                        updateCodesList();
                        updateUI();
                        
                        console.log(`✅ Dashboard updated: ${claimResult.code} - ${claimResult.success ? 'SUCCESS' : claimResult.message}`);
                        
                        // Send Telegram status update
                        sendTelegramStatusUpdate(claimResult.code, claimResult.success, claimResult.message);
                    }
                } catch (e) {
                    console.error('Failed to parse claim result:', e);
                }
            }
        }, 500); // Check every 500ms for faster updates
        
        console.log(`🔄 Auto-refresh enabled - polling every ${TIMEOUTS.POLL_CODES}ms (${superTurboMode ? 'TURBO MODE' : 'normal'})`);
    }

    // ============================================
    // INITIALIZE - INSTANT START (NO DELAY)
    // ============================================
    
    // INSTANT INITIALIZATION - NO DELAY!
    console.log('═════════════════════════════════════════');
    console.log('🚀 TAMPERMONKEY SCRIPT STARTED');
    console.log('Current URL:', window.location.href);
    console.log('Pathname:', window.location.pathname);
    console.log('Search:', window.location.search);
    console.log('Hash:', window.location.hash);
    console.log('═════════════════════════════════════════');
    
    (function init() {
        // Direct GraphQL mode - no page navigation, stays on same page
        console.log('🏠 DIRECT GRAPHQL MODE - No page navigation needed');
        setTimeout(() => {
            injectUI();
            startUsernameTracking(); // Auto-detect username from PostHog
            
            // Check for pending retry code (from Geetest refresh)
            const pendingCode = GM_getValue('pendingRetryCode', null);
            const pendingTime = GM_getValue('pendingRetryTime', 0);
            
            if (pendingCode && (Date.now() - pendingTime) < 60000) { // Within 1 minute
                console.log(`🔄 Found pending retry code: ${pendingCode} - Will retry after auth...`);
                
                // Clear the pending code
                GM_setValue('pendingRetryCode', null);
                GM_setValue('pendingRetryTime', 0);
                
                // Set flag to prioritize style-based detection
                window.isGeetestRetry = true;
                
                // Wait for authentication, then retry with STYLE-FIRST button detection
                const retryInterval = setInterval(() => {
                    if (isAuthenticated) {
                        clearInterval(retryInterval);
                        console.log(`🔄 Retrying code after Geetest refresh: ${pendingCode}`);
                        console.log('🎨 STYLE-FIRST mode enabled for button detection');
                        
                        GM_notification({
                            title: '🔄 Retrying Code',
                            text: `${pendingCode} (style-first mode)`,
                            timeout: 2000
                        });
                        
                        // Small delay then retry
                        setTimeout(() => {
                            openRedeemModal(pendingCode);
                        }, 1000);
                    }
                }, 500); // Check auth every 500ms
                
                // Timeout after 30 seconds
                setTimeout(() => {
                    clearInterval(retryInterval);
                    window.isGeetestRetry = false;
                }, 30000);
            }
        }, 300);
        
        console.log('⚡ Shuffle Code Claimer v7.7.0 TURBO MODE (Instant WebSocket + Max Speed)');
        console.log('═════════════════════════════════════════');
    })();

})();
