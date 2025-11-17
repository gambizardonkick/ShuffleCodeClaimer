// ==UserScript==
// @name         Shuffle Code Claimer
// @namespace    http://www.shufflecodeclaimer.com/
// @version      5.7.2
// @description  Shuffle Code Claimer with Manual Claim Feature
// @author       ThaGoofy
// @match        https://shuffle.com/*
// @match        https://shuffle.bet/*
// @grant        GM_openInTab
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        window.close
// @grant        GM_closeTab
// @grant        GM_getTab
// @connect      608696b3-6d88-42a1-839f-299b61f9cd75-00-23qavlu7g9piu.sisko.replit.dev
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

    const API_URL = 'https://608696b3-6d88-42a1-839f-299b61f9cd75-00-23qavlu7g9piu.sisko.replit.dev';
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
    let connectionTimestamp = parseInt(GM_getValue('connectionTimestamp', '0')) || null; // Track when user connected
    let username = GM_getValue('shuffleUsername', null);
    let isAuthenticated = GM_getValue('isAuthenticated', false);
    let accessToken = GM_getValue('accessToken', null);
    let refreshToken = GM_getValue('refreshToken', null);
    let subscriptionExpiry = GM_getValue('subscriptionExpiry', null);
    
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
    
    // Performance - all timeouts in milliseconds
    const TIMEOUTS = {
        POLL_CODES: 200,           // Poll dashboard every 2 seconds (balanced speed + no freezing)
        UI_UPDATE: 100,             // UI updates every 100ms
        AUTO_CLICK: 200,            // Auto-click redeem button after 200ms
        VIP_PAGE_WAIT: 500,         // Wait for VIP page to load
        CONNECT_RETRY: 300          // Retry connection after 300ms
    };

    // ============================================
    // CLAIM RESOLUTION (PREVENTS DUPLICATE MARKING)
    // ============================================
    
    function resolveClaim(codeSlug, success, reason = null) {
        // Only allow ONE resolution per code
        if (claimOutcomes[codeSlug]) {
            console.log(`⏭️ Code ${codeSlug} already resolved as ${claimOutcomes[codeSlug]}`);
            return false;
        }
        
        claimOutcomes[codeSlug] = success ? 'success' : 'rejected';
        
        console.log(`${success ? '✅' : '❌'} Resolving ${codeSlug}: ${success ? 'SUCCESS' : 'REJECTED'}${reason ? ' - ' + reason : ''}`);
        
        // Update local code status (client-side only)
        const codeIndex = codes.findIndex(c => c.code === codeSlug);
        if (codeIndex >= 0) {
            codes[codeIndex].claimed = success;
            codes[codeIndex].rejectionReason = reason;
            saveCodesLocal();
            updateCodesList();
            updateUI();
        }
        
        // Show notification
        GM_notification({
            title: success ? '✅ Code Claimed!' : '❌ Code Rejected',
            text: success ? codeSlug : `${codeSlug}: ${reason}`,
            timeout: 3000
        });
        
        return true;
    }
    
    // ============================================
    // AUTHENTICATION FUNCTIONS
    // ============================================
    
    function startConnect() {
        console.log('🔗 Opening VIP page in new tab to extract username...');
        
        // Open VIP page in NEW TAB (doesn't fuck up current page)
        GM_openInTab('https://shuffle.com/vip-program', { active: true, insert: true });
        
        // Show message on current page
        updateStatus('🔗 Opening VIP page in new tab - check it to connect!');
    }
    
    async function extractUsernameAndConnect() {
        // Wait for page to load
        await new Promise(resolve => setTimeout(resolve, TIMEOUTS.VIP_PAGE_WAIT));
        
        // Extract username from VIP page
        const usernameEl = document.querySelector('.VipPageOverview_heading__dXCZl');
        
        if (usernameEl && usernameEl.textContent) {
            username = usernameEl.textContent.trim().toLowerCase();
            
            console.log(`✅ Found username: ${username} - Authenticating...`);
            
            // Authenticate with backend
            GM_xmlhttpRequest({
                method: 'POST',
                url: `${API_URL}/api/auth/connect`,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ shuffleUsername: username }),
                timeout: 10000, // 10 second timeout
                onload: function(response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        
                        if (response.status === 200 && data.success) {
                            accessToken = data.accessToken;
                            refreshToken = data.refreshToken;
                            isAuthenticated = true;
                            connectionTimestamp = Date.now(); // Mark connection time
                            subscriptionExpiry = data.expiryAt;
                            
                            // PERSIST TOKENS
                            GM_setValue('accessToken', accessToken);
                            GM_setValue('refreshToken', refreshToken);
                            GM_setValue('isAuthenticated', true);
                            GM_setValue('connectionTimestamp', connectionTimestamp.toString());
                            GM_setValue('subscriptionExpiry', subscriptionExpiry);
                            
                            // FORCE UI REFRESH to show manual code button
                            const header = document.getElementById('shuffle-header');
                            if (header) header.remove();
                            const showBtn = document.getElementById('shuffle-show-btn');
                            if (showBtn) showBtn.remove();
                            injectUI();
                            
                            // PERSIST USERNAME
                            localStorage.setItem('shuffle_vip_username', username);
                            
                            GM_notification({
                                title: '✅ Connected!',
                                text: `${username} - Close this tab and refresh shuffle.com`,
                                timeout: 5000
                            });
                            
                            console.log(`✅ Connected! Username: ${username}`);
                            
                            // Auto-close tab after 2 seconds
                            setTimeout(() => window.close(), 2000);
                            
                        } else {
                            const errorMsg = data.error || 'No active subscription';
                            
                            GM_notification({
                                title: '❌ Not Subscribed',
                                text: errorMsg,
                                timeout: 5000
                            });
                            
                            console.error('❌ No subscription:', errorMsg);
                            console.error('Response status:', response.status);
                            console.error('Response:', data);
                            
                            // Auto-close tab
                            setTimeout(() => window.close(), 2000);
                        }
                    } catch (e) {
                        console.error('❌ Auth error:', e);
                        console.error('Raw response:', response.responseText);
                        
                        GM_notification({
                            title: '❌ Connection Error',
                            text: 'Failed to process server response',
                            timeout: 5000
                        });
                        
                        setTimeout(() => window.close(), 2000);
                    }
                },
                onerror: function(error) {
                    console.error('❌ NETWORK ERROR during authentication:');
                    console.error('Error details:', error);
                    console.error('API URL:', `${API_URL}/api/auth/connect`);
                    console.error('Username:', username);
                    
                    GM_notification({
                        title: '❌ Connection Failed',
                        text: 'Cannot reach server. Check if API is running.',
                        timeout: 5000
                    });
                    
                    setTimeout(() => window.close(), 2000);
                },
                ontimeout: function() {
                    console.error('❌ REQUEST TIMEOUT (10s exceeded)');
                    console.error('API URL:', `${API_URL}/api/auth/connect`);
                    
                    GM_notification({
                        title: '⏱️ Connection Timeout',
                        text: 'Server took too long to respond.',
                        timeout: 5000
                    });
                    
                    setTimeout(() => window.close(), 2000);
                }
            });
        } else {
            console.error('❌ Could not find username element');
        }
    }

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
        
        // Show Connect button if not authenticated
        const connectButton = !isAuthenticated ? `
            <button id="shuffle-connect-btn" style="background: #ff4444;
                border: 1px solid rgba(255,255,255,0.3); color: #fff; padding: 6px 14px;
                border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; animation: pulse 2s infinite;">
                🔒 Connect to Claim Codes
            </button>
        ` : '';
        
        const statusIndicator = isAuthenticated ? 
            `<div id="shuffle-status" style="padding: 5px 12px; background: rgba(0,255,136,0.2);
                border: 1px solid #00ff88; border-radius: 5px; font-size: 12px; color: #00ff88;">
                ✅ Active
            </div>` :
            `<div id="shuffle-status" style="padding: 5px 12px; background: rgba(255,68,68,0.2);
                border: 1px solid #ff4444; border-radius: 5px; font-size: 12px; color: #ff4444;">
                🔒 Not Connected
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
                        <div style="font-size:10px; opacity:0.7; margin-top:2px;">v5.7 Professional - Auto + Manual Claim</div>
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
            </div>
            
            <div style="display:flex; align-items:center; gap:20px;">
                ${searchingIndicator}
                ${statusIndicator}
                ${connectButton}
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
        
        // Connect button
        const connectBtn = document.getElementById('shuffle-connect-btn');
        if (connectBtn) {
            connectBtn.onclick = startConnect;
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

        updateCodesList();
    }
    
    // ============================================
    // EXTRACT USERNAME FROM VIP PAGE
    // ============================================
    
    function extractUsername() {
        // Navigate to VIP page if not already there
        if (!window.location.pathname.includes('/vip-program')) {
            console.log('🔄 Navigating to VIP page to extract username...');
            setTimeout(() => {
                window.location.href = 'https://shuffle.com/vip-program';
            }, 1000);
            return;
        }
        
        // Wait for page to load
        const checkForUsername = setInterval(() => {
            const usernameElement = document.querySelector('.VipPageOverview_heading__dXCZl');
            
            if (usernameElement) {
                clearInterval(checkForUsername);
                const extractedUsername = usernameElement.textContent.trim();
                username = extractedUsername;
                GM_setValue('shuffleUsername', extractedUsername);
                console.log('✅ Username extracted:', extractedUsername);
                
                // Update UI with username
                const usernameDisplay = document.getElementById('shuffle-username');
                if (usernameDisplay) {
                    usernameDisplay.textContent = `👤 ${extractedUsername}`;
                }
                
                // Navigate back to main page
                setTimeout(() => {
                    window.location.href = 'https://shuffle.com';
                }, 500);
            }
        }, 500);
        
        // Timeout after 10 seconds
        setTimeout(() => {
            clearInterval(checkForUsername);
        }, 10000);
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
        
        // Trigger auto-redemption
        autoRedeemViaPage(codeSlug);
    }

    // ============================================
    // AUTO-REDEEM VIA TAB NAVIGATION + BUTTON CLICK
    // ============================================
    
    function autoRedeemViaPage(codeSlug) {
        console.log(`🚀 autoRedeemViaPage called for: ${codeSlug}`);
        console.log(`🔐 isAuthenticated: ${isAuthenticated}`);
        console.log(`📝 Already processed: ${!!processedCodes[codeSlug]}`);
        
        // Check authentication first
        if (!isAuthenticated) {
            console.log(`❌ NOT AUTHENTICATED - CANNOT OPEN LINK`);
            updateStatus('🔒 Connect to claim codes');
            return;
        }
        
        // Check if already processed
        if (processedCodes[codeSlug]) {
            console.log(`❌ ALREADY PROCESSED - SKIPPING`);
            return;
        }
        
        console.log(`⚡⚡⚡ OPENING TAB - WILL AUTO-CLOSE IN ~1 SEC! ⚡⚡⚡`);
        updateStatus(`⚡ ${codeSlug}`);
        
        // Mark as processed immediately to prevent duplicates
        processedCodes[codeSlug] = Date.now();
        GM_setValue('processedCodes', processedCodes);
        
        // Open redeem URL INSTANTLY in new ACTIVE tab
        const redeemUrl = `https://shuffle.com/?md-code=${codeSlug}&modal=c`;
        console.log(`🔗 Opening URL: ${redeemUrl}`);
        GM_openInTab(redeemUrl, { active: true, insert: true, setParent: true });
        console.log(`✅ Tab opened - script will auto-close it after claim!`);
        
        GM_notification({
            title: '⚡ CLAIMING NOW!',
            text: codeSlug,
            timeout: 2000
        });
    }
    
    // ============================================
    // AUTO-CLICK REDEEM BUTTON (RUNS ON SHUFFLE.COM)
    // ============================================
    
    function autoClickRedeemButton() {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📞 autoClickRedeemButton() CALLED');
        console.log('Current URL:', window.location.href);
        
        // Only run if we're on shuffle.com with modal=c
        if (!window.location.href.includes('shuffle.com') || !window.location.href.includes('modal=c')) {
            console.log('❌ Not on claim page, URL:', window.location.href);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            return;
        }
        
        // Extract code from URL
        const urlParams = new URLSearchParams(window.location.search);
        const codeSlug = urlParams.get('md-code');
        
        console.log('URL Params:', window.location.search);
        console.log('Extracted code:', codeSlug);
        
        if (!codeSlug) {
            console.log('❌ No md-code found in URL');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            return;
        }
        
        console.log(`🎯 AUTO-REDEEM MODE ACTIVATED FOR: ${codeSlug}`);
        console.log('🔍 Starting button search every 50ms...');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        // User's simple click and copy logic - FIXED SELECTOR
        let searchAttempt = 0;
        const clickRedeemAndCopyReason = () => {
            searchAttempt++;
            
            // Log every 20 attempts
            if (searchAttempt % 20 === 1) {
                console.log(`🔍 Button search attempt #${searchAttempt}...`);
            }
            
            // ===== CHECK FOR ERROR ALERT BEFORE SEARCHING FOR BUTTON =====
            const errorAlert = document.querySelector('.Alert_rightContainer__Sv0qq .Alert_text__i7Zkk');
            if (errorAlert) {
                const errorMessage = errorAlert.textContent.trim();
                const normalizedError = errorMessage.toLowerCase().trim();
                
                // Check if it's the "bonus code not found" error
                if (normalizedError.includes('bonus code is not found')) {
                    console.log('🚫 ERROR ALERT DETECTED INSTEAD OF REDEEM BUTTON!');
                    console.log('💬 Error message:', errorMessage);
                    
                    // Stop searching (guard against undefined)
                    if (typeof mainChecker !== 'undefined') {
                        clearInterval(mainChecker);
                    }
                    
                    // Use resolveClaim to mark as rejected (prevents duplicates, updates UI)
                    resolveClaim(codeSlug, false, 'This bonus code is not found');
                    
                    // Send rejection to main page
                    const claimResult = {
                        code: codeSlug,
                        success: false,
                        message: 'This bonus code is not found',
                        timestamp: Date.now()
                    };
                    GM_setValue('lastClaimResult', JSON.stringify(claimResult));
                    
                    // Mark as rejected in API
                    GM_xmlhttpRequest({
                        method: 'POST',
                        url: `${API_URL}/api/code/claim`,
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': accessToken ? `Bearer ${accessToken}` : ''
                        },
                        data: JSON.stringify({
                            code: codeSlug,
                            success: false,
                            reason: 'This bonus code is not found'
                        })
                    });
                    
                    // CLOSE TAB
                    console.log('🚪 CLOSING TAB - Error detected before redeem button');
                    setTimeout(() => {
                        if (typeof GM_closeTab !== 'undefined') {
                            GM_closeTab();
                            console.log('✅ Tab closed with GM_closeTab()');
                        } else {
                            window.close();
                        }
                    }, 500);
                    return;
                }
            }
            
            // Find the BUTTON element, not the span
            const buttons = document.querySelectorAll('button.ButtonVariants_root__EFlHO.ButtonVariants_buttonHeightLarge___3w0a.ButtonVariants_primary__zlUoe');
            let btn = null;
            
            if (searchAttempt % 20 === 1) {
                console.log(`Found ${buttons.length} primary buttons on page`);
            }
            
            for (let button of buttons) {
                const span = button.querySelector('span.ButtonVariants_buttonContent__mRPrs');
                if (span && span.textContent.trim() === 'Redeem') {
                    btn = button; // Select the BUTTON, not the span
                    break;
                }
            }
            
            if (btn) {
                console.log('🎯🎯🎯 FOUND REDEEM BUTTON! 🎯🎯🎯');
                console.log('Button HTML:', btn.outerHTML.substring(0, 200));
                console.log('Clicking now...');
                btn.click();
                console.log('✅ BUTTON CLICK EXECUTED!');
                
                const popupWatcher = setInterval(() => {
                    const alert = document.querySelector('.Alert_rightContainer__Sv0qq .Alert_text__i7Zkk');
                    if (alert) {
                        const message = alert.textContent.trim();
                        console.log('💬 Popup message:', message);
                        
                        // Copy message to clipboard
                        navigator.clipboard.writeText(message).then(() => {
                            console.log('📋 Message copied to clipboard!');
                        }).catch(err => {
                            console.warn('⚠️ Failed to copy:', err);
                        });
                        
                        // ===== SPECIFIC CHECK: "This bonus code is not found" =====
                        // Normalize message for case-insensitive matching
                        const normalizedMessage = message.toLowerCase().trim();
                        if (normalizedMessage.includes('bonus code is not found')) {
                            console.log('🚫 CODE NOT FOUND - Marking as rejected and closing tab');
                            
                            // Stop watchers
                            clearInterval(popupWatcher);
                            if (typeof mainChecker !== 'undefined') {
                                clearInterval(mainChecker);
                            }
                            
                            // Use resolveClaim to mark as rejected (prevents duplicates, updates UI)
                            resolveClaim(codeSlug, false, 'This bonus code is not found');
                            
                            // Send rejection to main page
                            const claimResult = {
                                code: codeSlug,
                                success: false,
                                message: 'This bonus code is not found',
                                timestamp: Date.now()
                            };
                            GM_setValue('lastClaimResult', JSON.stringify(claimResult));
                            
                            // Mark as rejected in API
                            GM_xmlhttpRequest({
                                method: 'POST',
                                url: `${API_URL}/api/code/claim`,
                                headers: { 
                                    'Content-Type': 'application/json',
                                    'Authorization': accessToken ? `Bearer ${accessToken}` : ''
                                },
                                data: JSON.stringify({
                                    code: codeSlug,
                                    success: false,
                                    reason: 'This bonus code is not found'
                                })
                            });
                            
                            // CLOSE TAB
                            console.log('🚪 CLOSING TAB - Code not found');
                            setTimeout(() => {
                                if (typeof GM_closeTab !== 'undefined') {
                                    GM_closeTab();
                                    console.log('✅ Tab closed with GM_closeTab()');
                                } else {
                                    window.close();
                                }
                            }, 500);
                            return;
                        }
                        
                        // Determine if success or error (generic check)
                        const isError = message.toLowerCase().includes('error') || 
                                      message.toLowerCase().includes('not') ||
                                      message.toLowerCase().includes('requirement') ||
                                      message.toLowerCase().includes('invalid') ||
                                      message.toLowerCase().includes('expired') ||
                                      message.toLowerCase().includes('already');
                        
                        // Send result back to main page via GM_setValue
                        const claimResult = {
                            code: codeSlug,
                            success: !isError,
                            message: message,
                            timestamp: Date.now()
                        };
                        GM_setValue('lastClaimResult', JSON.stringify(claimResult));
                        
                        console.log('📤 Sent result to main page via GM_setValue');
                        
                        // Update local codes array
                        resolveClaim(codeSlug, !isError, isError ? message : null);
                        
                        clearInterval(popupWatcher);
                        clearInterval(mainChecker);
                        
                        // CLOSE TAB using Tampermonkey's privileged API
                        console.log('🚪 CLOSING TAB WITH GM_closeTab()...');
                        setTimeout(() => {
                            console.log('👋 Calling GM_closeTab() (bypasses browser security)...');
                            
                            // Use GM_closeTab - the ONLY reliable way to close Tampermonkey-opened tabs
                            if (typeof GM_closeTab !== 'undefined') {
                                GM_closeTab();
                                console.log('✅ GM_closeTab() called - tab closing!');
                            } else {
                                console.error('❌ GM_closeTab not available, falling back');
                                window.close();
                            }
                        }, 500);
                    }
                }, 50);
            }
        };
        
        const mainChecker = setInterval(clickRedeemAndCopyReason, 50);
    }

    // ============================================
    // MONITOR DOM ALERTS FOR ERROR/SUCCESS MESSAGES
    // ============================================
    
    function monitorDOMAlerts(codeSlug) {
        console.log('👀 Monitoring for popup message...');
        
        const alertChecker = setInterval(() => {
            // Check if already resolved
            if (claimOutcomes[codeSlug]) {
                console.log('⏭️ Already resolved, stopping monitoring');
                clearInterval(alertChecker);
                return;
            }
            
            // Look for alert messages in the DOM (left-side popup)
            const alertContainer = document.querySelector('.Alert_rightContainer__Sv0qq');
            
            if (alertContainer) {
                const alertText = alertContainer.querySelector('.Alert_text__i7Zkk');
                
                if (alertText) {
                    const message = alertText.textContent.trim();
                    clearInterval(alertChecker);
                    
                    console.log('📢 POPUP DETECTED:', message);
                    
                    // ===== SPECIFIC CHECK: "This bonus code is not found" =====
                    // Normalize message for case-insensitive matching
                    const normalizedMessage = message.toLowerCase().trim();
                    if (normalizedMessage.includes('bonus code is not found')) {
                        console.log('🚫 CODE NOT FOUND - Marking as rejected and closing tab');
                        resolveClaim(codeSlug, false, 'This bonus code is not found');
                        return;
                    }
                    
                    // Check if it's an error or success (generic check)
                    const isError = message.toLowerCase().includes('error') || 
                                  message.toLowerCase().includes('not') ||
                                  message.toLowerCase().includes('requirement') ||
                                  message.toLowerCase().includes('invalid') ||
                                  message.toLowerCase().includes('expired') ||
                                  message.toLowerCase().includes('already');
                    
                    // Resolve and close tab
                    resolveClaim(codeSlug, !isError, isError ? message : null);
                }
            }
        }, 100); // Check every 100ms until popup appears
    }

    // ============================================
    // REDEEM CODE VIA GRAPHQL
    // ============================================
    
    async function redeemCodeDirect(codeSlug, attempt = 1) {
        updateStatus(`⚡ Redeeming ${codeSlug} (Attempt ${attempt}/3)...`);
        
        const authToken = getAuthToken();
        if (!authToken) {
            console.error('No auth token found!');
            updateStatus('❌ Not logged in');
            
            // Mark as failed after 3 attempts
            if (attempt >= 3) {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: `${API_URL}/api/code/claim`,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({ 
                        code: codeSlug, 
                        success: false,
                        reason: 'Auth token not found (may need to refresh page after login)'
                    })
                });
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
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: `${API_URL}/api/code/claim`,
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': accessToken ? `Bearer ${accessToken}` : ''
                    },
                    data: JSON.stringify({ 
                        code: codeSlug, 
                        success: false,
                        reason: 'Failed to get geetest nonce'
                    })
                });
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
                    currency: "USDT",
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
                
                if (attempt >= 3) {
                    // Max attempts reached, mark as rejected
                    updateStatus(`❌ Rejected: ${codeSlug}`);
                    GM_xmlhttpRequest({
                        method: 'POST',
                        url: `${API_URL}/api/code/claim`,
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': accessToken ? `Bearer ${accessToken}` : ''
                        },
                        data: JSON.stringify({ 
                            code: codeSlug, 
                            success: false,
                            reason: errorMsg
                        })
                    });
                    retryAttempts[codeSlug] = 0;
                    GM_setValue('retryAttempts', retryAttempts);
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
                
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: `${API_URL}/api/code/claim`,
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': accessToken ? `Bearer ${accessToken}` : ''
                    },
                    data: JSON.stringify({ 
                        code: codeSlug, 
                        success: true
                    })
                });
                
                retryAttempts[codeSlug] = 0;
                GM_setValue('retryAttempts', retryAttempts);
            }
        })
        .catch(error => {
            console.error('Network error:', error);
            
            if (attempt >= 3) {
                updateStatus(`❌ Network error`);
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: `${API_URL}/api/code/claim`,
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': accessToken ? `Bearer ${accessToken}` : ''
                    },
                    data: JSON.stringify({ 
                        code: codeSlug, 
                        success: false,
                        reason: 'Network error: ' + error.message
                    })
                });
                retryAttempts[codeSlug] = 0;
                GM_setValue('retryAttempts', retryAttempts);
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
                        
                        // INSTANT REDEEM - NO DELAY!
                        autoRedeemViaPage(latestCode.code);
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
    // AUTO-REFRESH DASHBOARD (ALWAYS RUNNING)
    // ============================================
    
    function startAutoRefresh() {
        // Poll dashboard API every 2 seconds to get new codes from Telegram (prevent freezing)
        setInterval(() => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `${API_URL}/api/codes`,
                headers: accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {},
                onload: function(response) {
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
                                
                                // SHOW NOTIFICATION WITH INSTRUCTIONS
                                const codeValue = backendCode.value || backendCode.amount || 'N/A';
                                const codeLimit = backendCode.limit ? `First ${backendCode.limit}` : 'N/A';
                                GM_notification({
                                    title: `🎰 NEW CODE: ${backendCode.code}`,
                                    text: `${codeValue} | ${codeLimit}\n📍 Open https://shuffle.com/redeem/${backendCode.code} and click REDEEM!`,
                                    timeout: 10000
                                });
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
                        
                        // AUTO-REDEEM unclaimed codes
                        const unclaimedCodes = codes.filter(c => 
                            !c.claimed && !c.rejectionReason && !processedCodes[c.code]
                        );
                        
                        if (unclaimedCodes.length > 0 && isAuthenticated) {
                            const latestCode = unclaimedCodes[0];
                            console.log(`⚡ AUTO-REDEEMING: ${latestCode.code}`);
                            
                            GM_notification({
                                title: '⚡ NEW CODE!',
                                text: latestCode.code,
                                timeout: 2000
                            });
                            
                            // INSTANT REDEEM!
                            autoRedeemViaPage(latestCode.code);
                        }
                    } catch (e) {
                        console.error('Auto-refresh error:', e);
                    }
                }
            });
        }, TIMEOUTS.POLL_CODES); // Poll every 2 seconds (balanced)
        
        // Monitor for claim results from other tabs (cross-tab communication)
        let lastClaimResultStr = '';
        setInterval(() => {
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
                    }
                } catch (e) {
                    console.error('Failed to parse claim result:', e);
                }
            }
        }, 500); // Check every 500ms for faster updates
        
        console.log(`🔄 Auto-refresh enabled - polling every ${TIMEOUTS.POLL_CODES}ms (balanced speed + performance)`);
    }

    // ============================================
    // INITIALIZE - INSTANT START (NO DELAY)
    // ============================================
    
    // ============================================
    // AUTO-CHECK ON PAGE LOAD
    // ============================================
    
    function autoCheckOnLoad() {
        // PREVENT INFINITE LOOPS: Don't auto-check on claim pages
        const isClaimPage = window.location.href.includes('modal=c');
        if (isClaimPage) {
            console.log('⏭️ Skipping auto-check (on claim page)');
            return;
        }
        
        const storedUsername = localStorage.getItem('shuffle_vip_username');
        
        if (storedUsername && storedUsername !== 'null') {
            username = storedUsername;
            console.log('✅ Username from storage:', username);
            
            // Update username display in header
            const usernameDisplay = document.getElementById('shuffle-username');
            if (usernameDisplay) {
                usernameDisplay.textContent = `👤 ${username}`;
            }
            
            updateStatus(`👤 ${username} - Verifying...`);
            
            GM_xmlhttpRequest({
                method: 'POST',
                url: `${API_URL}/api/auth/connect`,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ shuffleUsername: username }),
                timeout: 10000, // 10 second timeout
                onload: function(response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        
                        if (response.status === 200 && data.accessToken) {
                            accessToken = data.accessToken;
                            refreshToken = data.refreshToken;
                            isAuthenticated = true;
                            connectionTimestamp = Date.now(); // Mark connection time - ONLY claim codes after this
                            
                            // PERSIST TOKENS
                            GM_setValue('accessToken', accessToken);
                            GM_setValue('refreshToken', refreshToken);
                            GM_setValue('isAuthenticated', true);
                            GM_setValue('connectionTimestamp', connectionTimestamp.toString());
                            subscriptionExpiry = data.expiryAt;
                            
                            // FORCE UI REFRESH to show manual code button
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
                                    const minutes = Math.ceil(diffMs / (1000 * 60));
                                    expiryDisplay = `${minutes} min`;
                                } else if (diffMs < 24 * 60 * 60 * 1000) {
                                    const hours = Math.ceil(diffMs / (1000 * 60 * 60));
                                    expiryDisplay = `${hours} hr`;
                                } else if (diffDays <= 7) {
                                    expiryDisplay = `${diffDays}d`;
                                } else {
                                    const dateStr = expiryDate.toISOString().split('T')[0];
                                    expiryDisplay = `${dateStr}`;
                                }
                            }
                            updateStatus(`✅ ${username} - ${expiryDisplay}`);
                            console.log('✅ SUBSCRIPTION ACTIVE');
                            console.log(`📅 Connection timestamp: ${new Date(connectionTimestamp).toISOString()}`);
                            
                            // ONLY start auto-refresh on MAIN page
                            startAutoRefresh();
                        } else {
                            // Handle error responses
                            const errorMsg = data.error || 'Not subscribed';
                            updateStatus(`🔒 ${username} - ${errorMsg}`);
                            console.error('❌ Authentication failed:', errorMsg);
                            console.error('Response status:', response.status);
                            console.error('Response:', data);
                        }
                    } catch (e) {
                        updateStatus(`❌ Connection error`);
                        console.error('❌ Failed to parse response:', e);
                        console.error('Raw response:', response.responseText);
                    }
                },
                onerror: function(error) {
                    updateStatus(`❌ Network error - Check connection`);
                    console.error('❌ NETWORK ERROR during authentication:');
                    console.error('Error details:', error);
                    console.error('API URL:', `${API_URL}/api/auth/connect`);
                    console.error('Username:', username);
                    
                    GM_notification({
                        title: '❌ Connection Failed',
                        text: 'Cannot reach server. Check if API is running.',
                        timeout: 5000
                    });
                },
                ontimeout: function() {
                    updateStatus(`❌ Timeout - Server not responding`);
                    console.error('❌ REQUEST TIMEOUT (10s exceeded)');
                    console.error('API URL:', `${API_URL}/api/auth/connect`);
                    
                    GM_notification({
                        title: '⏱️ Connection Timeout',
                        text: 'Server took too long to respond.',
                        timeout: 5000
                    });
                }
            });
        } else {
            // ONLY open VIP tab ONCE per session
            const hasOpenedVipTab = sessionStorage.getItem('vip_tab_opened');
            
            if (!hasOpenedVipTab) {
                console.log('🚀 AUTO-OPENING VIP TAB (once per session)');
                sessionStorage.setItem('vip_tab_opened', 'true');
                updateStatus('🔍 Checking account...');
                
                GM_openInTab('https://shuffle.com/vip-program', { active: false, insert: true });
                
                let checkCount = 0;
                const checkInterval = setInterval(() => {
                    const extractedUsername = localStorage.getItem('shuffle_vip_username');
                    checkCount++;
                    
                    if (extractedUsername && extractedUsername !== 'null') {
                        clearInterval(checkInterval);
                        console.log('✅ Got username from VIP tab!');
                        autoCheckOnLoad();
                    } else if (checkCount > 20) {
                        clearInterval(checkInterval);
                        updateStatus('❌ Timeout');
                    }
                }, 500);
            } else {
                console.log('⏭️ VIP tab already opened this session');
                updateStatus('🔒 Connect to claim codes');
            }
        }
    }
    
    // INSTANT INITIALIZATION - NO DELAY!
    console.log('═════════════════════════════════════════');
    console.log('🚀 TAMPERMONKEY SCRIPT STARTED');
    console.log('Current URL:', window.location.href);
    console.log('Pathname:', window.location.pathname);
    console.log('Search:', window.location.search);
    console.log('Hash:', window.location.hash);
    console.log('═════════════════════════════════════════');
    
    (function init() {
        const currentUrl = window.location.href;
        const hasModalC = currentUrl.includes('modal=c');
        const hasMdCode = currentUrl.includes('md-code');
        const isVIPPage = window.location.pathname.includes('/vip-program');
        const isClaimPage = hasModalC && hasMdCode;
        
        console.log('🔍 DETECTION RESULTS:');
        console.log('  - Has modal=c:', hasModalC);
        console.log('  - Has md-code:', hasMdCode);
        console.log('  - Is VIP Page:', isVIPPage);
        console.log('  - Is Claim Page:', isClaimPage);
        
        if (isVIPPage) {
            // Extract username and close VIP tab
            console.log('📍 VIP PAGE MODE ACTIVATED');
            setTimeout(() => {
                const usernameEl = document.querySelector('.VipPageOverview_heading__dXCZl') || 
                                  document.querySelector('[class*="Username_username"]');
                
                if (usernameEl) {
                    const extractedUsername = usernameEl.textContent.trim().replace('@', '').toLowerCase();
                    localStorage.setItem('shuffle_vip_username', extractedUsername);
                    console.log('✅ VIP: Saved username:', extractedUsername);
                    setTimeout(() => window.close(), 500);
                }
            }, 1000);
        } else if (isClaimPage) {
            // On claim pages: ONLY auto-click redeem
            console.log('🎯🎯🎯 CLAIM PAGE DETECTED - STARTING AUTO-CLICK 🎯🎯🎯');
            console.log('Calling autoClickRedeemButton() now...');
            autoClickRedeemButton();
            console.log('autoClickRedeemButton() called!');
        } else {
            // Main page: Full functionality
            console.log('🏠 MAIN PAGE MODE - Full dashboard');
            setTimeout(() => {
                injectUI();
                autoCheckOnLoad();
            }, 300);
        }
        
        console.log('⚡ Shuffle Code Claimer v4.0.1 LOADED');
        console.log('═════════════════════════════════════════');
    })();

})();
