(function() {
  'use strict';

  // ============================================
  // CONFIGURATION
  // ============================================

  const SCRIPT_TAG = document.currentScript;
  const POPUP_ID = SCRIPT_TAG.getAttribute('data-popup');

  const CONFIG = {
    API_BASE: 'https://mysellkit.com/api/1.1/wf',
    CHECKOUT_BASE: 'https://mysellkit.com',
    VERSION: '1.3.2',
    SESSION_DURATION: 86400000, // 24h in ms
    TOAST_DURATION: 5000
  };

  /**
   * NOTE: React hydration warnings (#418, #422) on Framer sites are expected.
   * These are non-blocking warnings from Framer's React detecting custom HTML injection.
   * They do not affect popup functionality.
   */

  let config = null;
  let popupShown = false;
  let sessionId = null;
  let triggerActivated = false;
  let currentScrollPercent = 0;
  let currentTimeElapsed = 0;
  let timeInterval = null;

  const urlParams = new URLSearchParams(window.location.search);
  const isDemoPage = window.location.hostname.includes('mysellkit.com') &&
                     window.location.pathname.includes('/demo/');
  const DEBUG_MODE = urlParams.get('debug') === 'true' ||
                     urlParams.get('mysellkit_test') === 'true' ||
                     SCRIPT_TAG.getAttribute('data-debug') === 'true' ||
                     isDemoPage;

  // ============================================
  // DEBUG HELPER
  // ============================================

  function debugLog(emoji, message, data = null) {
    if (!DEBUG_MODE) return;
    if (data !== null) {
      console.log(`${emoji} ${message}`, data);
    } else {
      console.log(`${emoji} ${message}`);
    }
  }

  if (DEBUG_MODE) {
    debugLog('🔧', `MySellKit Popup DEBUG MODE ENABLED (v${CONFIG.VERSION})`);
    debugLog('📡', 'API Base:', CONFIG.API_BASE);
    debugLog('💳', 'Checkout Base:', CONFIG.CHECKOUT_BASE);
  }

  // ============================================
  // SESSION MANAGEMENT
  // ============================================

  function getSessionId() {
    if (sessionId) return sessionId;

    if (DEBUG_MODE) {
      sessionId = 'msk_debug_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      debugLog('🔄', 'Debug mode: New session per page load:', sessionId);
      return sessionId;
    }

    const stored = localStorage.getItem('mysellkit_session');
    const storedTime = localStorage.getItem('mysellkit_session_time');

    if (stored && storedTime && (Date.now() - parseInt(storedTime) < CONFIG.SESSION_DURATION)) {
      sessionId = stored;
      debugLog('🔄', `Reusing session (${Math.round((Date.now() - parseInt(storedTime)) / 60000)}min old):`, sessionId);
    } else {
      sessionId = 'msk_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('mysellkit_session', sessionId);
      localStorage.setItem('mysellkit_session_time', Date.now().toString());
      debugLog('✨', 'New session created:', sessionId);
    }

    return sessionId;
  }

  function generatePurchaseToken() {
    return 'pt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 12);
  }

  // ============================================
  // DISPLAY RULES (consolidated validation)
  // ============================================

  function checkDisplayRules() {
    if (!config) return { canAutoTrigger: false, shouldShowFloating: false };

    const purchased = hasPurchasedProduct();
    const hasImpression = !!sessionStorage.getItem(`mysellkit_impression_${POPUP_ID}`);
    const lastSeen = localStorage.getItem(`mysellkit_seen_${POPUP_ID}`);
    const withinCooldown = lastSeen && (Date.now() - parseInt(lastSeen) < CONFIG.SESSION_DURATION);

    return {
      purchased,
      hasImpression,
      withinCooldown,
      canAutoTrigger: !purchased && !hasImpression && (!withinCooldown || DEBUG_MODE),
      shouldShowFloating: !purchased && hasImpression && !DEBUG_MODE
    };
  }

  function isPersistentModeEnabled() {
    return config && config.persistent_mode === 'yes';
  }

  function hasPurchasedProduct() {
    if (!config) return false;
    const purchased = localStorage.getItem(`mysellkit_purchased_${config.product_id}`);
    if (purchased) {
      debugLog('✅', 'User has already purchased this product');
      return true;
    }
    return false;
  }

  function markProductAsPurchased() {
    if (!config) return;
    localStorage.setItem(`mysellkit_purchased_${config.product_id}`, 'true');
    debugLog('💾', 'Product marked as purchased');
  }

  function shouldTriggerPopup() {
    if (!config) return false;

    if (config.trigger_type === 'click') {
      if (hasPurchasedProduct()) {
        debugLog('❌', 'Product purchased - no manual trigger allowed');
        return false;
      }
      return true;
    }

    const rules = checkDisplayRules();

    if (rules.purchased) {
      debugLog('❌', 'Product already purchased');
      return false;
    }

    if (DEBUG_MODE) {
      debugLog('✅', 'Debug mode: Will trigger popup (fresh page load)');
      return true;
    }

    if (rules.hasImpression) {
      console.log('❌ Already had impression this session - no auto trigger (click widget to reopen)');
      return false;
    }

    if (rules.withinCooldown) {
      console.log('❌ Widget already seen in last 24h');
      return false;
    }

    return true;
  }

  function shouldShowFloatingWidget() {
    const rules = checkDisplayRules();
    return rules.shouldShowFloating;
  }

  // ============================================
  // SCROLL LOCK (consolidated)
  // ============================================

  function lockBodyScroll() {
    const scrollY = window.scrollY;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    if (window.lenis) {
      window.lenis.stop();
      debugLog('🔒', 'Lenis stopped');
    }
    if (window.locomotive) {
      window.locomotive.stop();
      debugLog('🔒', 'Locomotive stopped');
    }

    Object.assign(document.body.style, {
      overflow: 'hidden',
      height: '100vh',
      position: 'fixed',
      width: '100%',
      top: `-${scrollY}px`,
      paddingRight: `${scrollbarWidth}px`
    });

    document.body.setAttribute('data-mysellkit-popup-open', 'true');
    window.mysellkitScrollY = scrollY;
    window.mysellkitScrollbarWidth = scrollbarWidth;
    debugLog('📍', `Scroll position preserved: ${scrollY}px, scrollbar width: ${scrollbarWidth}px`);
  }

  function unlockBodyScroll() {
    const scrollY = window.mysellkitScrollY || 0;

    if (window.lenis) {
      window.lenis.start();
      debugLog('✅', 'Lenis restored');
    }
    if (window.locomotive) {
      window.locomotive.start();
      debugLog('✅', 'Locomotive restored');
    }

    Object.assign(document.body.style, {
      overflow: '',
      height: '',
      position: '',
      width: '',
      top: '',
      paddingRight: ''
    });

    document.body.removeAttribute('data-mysellkit-popup-open');
    window.scrollTo(0, scrollY);
    delete window.mysellkitScrollY;
    delete window.mysellkitScrollbarWidth;
    debugLog('📍', `Scroll position restored: ${scrollY}px`);
  }

  // ============================================
  // TOAST NOTIFICATION
  // ============================================

  function showToast(message, type = 'error') {
    let toast = document.getElementById('mysellkit-toast');

    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'mysellkit-toast';
      toast.className = 'mysellkit-toast';
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.className = `mysellkit-toast mysellkit-toast-${type} mysellkit-toast-show`;

    setTimeout(() => {
      toast.classList.remove('mysellkit-toast-show');
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, CONFIG.TOAST_DURATION);
  }

  // ============================================
  // FETCH POPUP CONFIG
  // ============================================

  async function fetchPopupConfig() {
    try {
      debugLog('📡', 'Fetching popup config:', POPUP_ID);

      const response = await fetch(`${CONFIG.API_BASE}/get-popup-config?popup_id=${POPUP_ID}`);
      const data = await response.json();

      debugLog('📦', 'Popup config received:', data);

      const isSuccess = (data.status === 'success' && data.response) ||
                        (data.response && data.response.success === 'yes');

      if (isSuccess && data.response) {
        if (data.response.image && data.response.image.startsWith('//')) {
          data.response.image = 'https:' + data.response.image;
        }
        return data.response;
      } else {
        console.error('MySellKit: Invalid popup ID or API error');
        debugLog('📦', 'API Response:', JSON.stringify(data, null, 2));
        return null;
      }
    } catch (error) {
      console.error('MySellKit: Failed to fetch popup config', error);
      return null;
    }
  }

  // ============================================
  // TRACK EVENTS
  // ============================================

  async function trackEvent(eventType, additionalData = {}) {
    try {
      if (!config) return;

      if (DEBUG_MODE) {
        debugLog('🚫', 'DEBUG MODE: Skipping event tracking:', eventType);
        return;
      }

      await fetch(`${CONFIG.API_BASE}/track-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          popup_id: POPUP_ID,
          product_id: config.product_id,
          session_id: getSessionId(),
          event_type: eventType,
          page_url: window.location.href,
          user_agent: navigator.userAgent,
          debug_mode: DEBUG_MODE ? 'yes' : 'no',
          ...additionalData
        })
      });
    } catch (error) {
      console.error('MySellKit: Failed to track event', error);
    }
  }

  function trackImpressionOnce() {
    if (!sessionStorage.getItem(`mysellkit_impression_${POPUP_ID}`)) {
      trackEvent('impression');
      sessionStorage.setItem(`mysellkit_impression_${POPUP_ID}`, 'true');
    }
    if (!DEBUG_MODE) {
      localStorage.setItem(`mysellkit_seen_${POPUP_ID}`, Date.now());
    }
  }

  // ============================================
  // DEBUG BADGE
  // ============================================

  function getTriggerInfo() {
    if (!config) return 'Unknown trigger';
    switch(config.trigger_type) {
      case 'scroll': return `📜 Scroll: ${currentScrollPercent}% / ${config.trigger_value}%`;
      case 'time': return `⏱️ Time: ${currentTimeElapsed}s / ${config.trigger_value}s`;
      case 'exit_intent':
      case 'exit': return '🚪 Exit Intent';
      case 'click': return '🎯 Manual Trigger';
      default: return 'Unknown trigger';
    }
  }

  function updateDebugBadge() {
    if (!DEBUG_MODE || !config) return;

    const badge = document.getElementById('mysellkit-debug-badge');
    if (!badge) return;

    const statusIcon = triggerActivated ? '✅' : '⏳';
    const statusText = triggerActivated ? 'TRIGGERED' : 'WAITING';
    const isDraft = config.is_live !== 'yes';
    const stripeNotConnected = config.stripe_connected !== 'yes';

    badge.innerHTML = `
      <div style="font-size: 10px; margin-bottom: 4px;">🔧 TEST MODE v${CONFIG.VERSION}</div>
      <div style="font-size: 10px;">Popup: ${config.popup_name || POPUP_ID}</div>
      ${isDraft ? '<div style="font-size: 10px; margin-top: 4px; background: #f59e0b; color: white; padding: 2px 6px; border-radius: 3px; font-weight: 600;">🚧 DRAFT MODE</div>' : ''}
      ${stripeNotConnected ? '<div style="font-size: 10px; margin-top: 4px; background: #ef4444; color: white; padding: 2px 6px; border-radius: 3px; font-weight: 600;">🔴 NO STRIPE</div>' : ''}
      <div style="font-size: 11px;">${statusIcon} ${statusText}</div>
      <div style="font-size: 10px; margin-top: 4px; opacity: 0.9;">${getTriggerInfo()}</div>
    `;
  }

  // ============================================
  // RENDER INCLUDED ITEMS
  // ============================================

  function getFileIcon(item) {
    if (item.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i)) return '🖼️';
    if (item.match(/\.(mp4|mov|avi|webm)$/i)) return '🎥';
    if (item.match(/\.(pdf)$/i)) return '📄';
    if (item.match(/\.(zip|rar)$/i)) return '📦';
    if (item.match(/\.(kml|kmz|gpx)$/i)) return '🗺️';
    return '📄';
  }

  function renderIncludedItems(items, includedTitle) {
    if (!items || items.length === 0) return '';

    const title = includedTitle || "📦 What's Included:";
    const itemsHTML = items.map(item => `
      <div class="mysellkit-included-item">
        <div class="mysellkit-file-icon">${getFileIcon(item)}</div>
        <span class="mysellkit-file-name">${item}</span>
      </div>
    `).join('');

    return `
      <div class="mysellkit-included">
        <h3 class="mysellkit-included-title">${title}</h3>
        <div class="mysellkit-included-items">${itemsHTML}</div>
      </div>
    `;
  }

  // ============================================
  // CSS INJECTION
  // ============================================

  function injectCSS(config) {
    if (!document.getElementById('mysellkit-popup-global-styles')) {
      const globalStyle = document.createElement('style');
      globalStyle.id = 'mysellkit-popup-global-styles';
      globalStyle.textContent = getGlobalCSS();
      document.head.appendChild(globalStyle);
    }

    if (DEBUG_MODE && !document.getElementById('mysellkit-debug-badge')) {
      const badge = document.createElement('div');
      badge.className = 'mysellkit-debug-badge';
      badge.id = 'mysellkit-debug-badge';
      badge.innerHTML = `
        <div style="font-size: 10px; margin-bottom: 4px;">🔧 TEST MODE v${CONFIG.VERSION}</div>
        <div style="font-size: 11px;">⏳ WAITING</div>
      `;
      document.body.appendChild(badge);
    }
  }

  function getGlobalCSS() {
    return `
      :root {
        --msk-font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif;
        --msk-shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.1);
        --msk-shadow-md: 0 8px 24px rgba(0, 0, 0, 0.12);
        --msk-shadow-lg: 0 25px 70px rgba(0, 0, 0, 0.35);
        --msk-radius-sm: 10px;
        --msk-radius-md: 12px;
        --msk-radius-lg: 16px;
        --msk-radius-xl: 24px;
      }

      #mysellkit-root {
        position: relative;
        z-index: 999998;
        pointer-events: none;
      }
      #mysellkit-root > * { pointer-events: auto; }

      @font-face {
        font-family: 'DM Sans';
        font-style: normal;
        font-weight: 400;
        font-display: swap;
        src: url('https://mysellkit.github.io/widget/fonts/dm-sans-v17-latin-regular.woff2') format('woff2');
      }
      @font-face {
        font-family: 'DM Sans';
        font-style: normal;
        font-weight: 500;
        font-display: swap;
        src: url('https://mysellkit.github.io/widget/fonts/dm-sans-v17-latin-500.woff2') format('woff2');
      }
      @font-face {
        font-family: 'DM Sans';
        font-style: normal;
        font-weight: 600;
        font-display: swap;
        src: url('https://mysellkit.github.io/widget/fonts/dm-sans-v17-latin-600.woff2') format('woff2');
      }

      /* ========================================== */
      /* TARGETED RESET - Only reset HTML tag defaults, preserve our classes */
      /* ========================================== */

      /* Reset default heading styles */
      .mysellkit-popup h1,
      .mysellkit-popup h2,
      .mysellkit-popup h3,
      .mysellkit-popup h4,
      .mysellkit-popup h5,
      .mysellkit-popup h6 {
        font-weight: inherit !important;
        margin: 0 !important;
        padding: 0 !important;
      }

      /* Reset default paragraph styles */
      .mysellkit-popup p {
        margin: 0 !important;
        padding: 0 !important;
      }

      /* Reset default list styles */
      .mysellkit-popup ul,
      .mysellkit-popup ol {
        margin: 0 !important;
        padding: 0 !important;
        list-style: none !important;
      }

      .mysellkit-popup li {
        margin: 0 !important;
        padding: 0 !important;
      }

      /* Force smooth font rendering (like Bubble) */
      .mysellkit-popup,
      .mysellkit-popup *,
      .mysellkit-floating-widget,
      .mysellkit-floating-widget * {
        -webkit-font-smoothing: antialiased !important;
        -moz-osx-font-smoothing: grayscale !important;
        text-rendering: optimizeLegibility !important;
      }

      .mysellkit-popup *, .mysellkit-floating-widget *, .mysellkit-toast * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      .mysellkit-toast {
        position: fixed;
        top: 20px;
        right: 20px;
        background: white;
        padding: 16px 20px;
        border-radius: var(--msk-radius-md);
        box-shadow: var(--msk-shadow-md), var(--msk-shadow-sm);
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-size: 14px !important;
        font-weight: 500 !important;
        line-height: 1.5 !important;
        color: #1F2937 !important;
        z-index: 10000000;
        opacity: 0;
        transform: translateY(-20px);
        transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        pointer-events: none;
        max-width: 350px;
        border-left: 4px solid #EF4444;
      }
      .mysellkit-toast-show {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }
      .mysellkit-toast-error { border-left-color: #EF4444; }
      .mysellkit-toast-success { border-left-color: #00D66F; }

      .mysellkit-overlay {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(4px);
        z-index: 999999;
        align-items: center;
        justify-content: center;
        animation: mysellkit-fadeIn 0.3s ease;
      }
      .mysellkit-overlay.visible { display: flex; }

      @keyframes mysellkit-slideUp {
        from { opacity: 0; transform: translateY(30px) scale(0.96); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes mysellkit-fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes mysellkit-floatSlideIn {
        from { opacity: 0; transform: translateY(20px) scale(0.9); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      .mysellkit-popup {
        width: 900px;
        max-width: 900px;
        height: 600px;
        background: white;
        border-radius: var(--msk-radius-xl);
        overflow: hidden;
        display: flex;
        box-shadow: var(--msk-shadow-lg);
        position: relative;
        animation: mysellkit-slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      }

      .mysellkit-close {
        position: absolute;
        top: 20px;
        right: 20px;
        width: 32px;
        height: 32px;
        background: rgba(0, 0, 0, 0.06);
        border: none;
        border-radius: 50%;
        cursor: pointer;
        transition: all 0.2s ease;
        z-index: 100;
        padding: 0 !important;
        margin: 0 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        font-size: 20px !important;
        line-height: 32px !important;
        color: #4B5563 !important;
        font-family: system-ui, -apple-system, sans-serif !important;
        font-weight: 300 !important;
        text-align: center !important;
      }
      .mysellkit-close:hover {
        background: rgba(0, 0, 0, 0.12);
        transform: scale(1.1);
        color: #1F2937;
      }

      .mysellkit-left {
        width: 450px;
        height: 600px;
        background: var(--msk-left-bg, #FFFFFF);
        padding: 24px 24px 24px 24px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }

      .mysellkit-top {
        display: flex;
        flex-direction: column;
      }

      .mysellkit-image-wrapper {
        position: relative;
        width: 100%;
        aspect-ratio: 4/3;
        margin-bottom: 16px;
      }
      .mysellkit-image-wrapper.no-image { display: none; }

      .mysellkit-image {
        width: 100%;
        height: 100%;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        border-radius: var(--msk-radius-md);
        object-fit: cover;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.1);
        transition: transform 0.3s ease;
      }
      .mysellkit-image:hover { transform: scale(1.02); }

      .mysellkit-popup .mysellkit-left .mysellkit-title,
      h2.mysellkit-title {
        width: 100% !important;
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-weight: 600 !important;
        font-size: 24px !important;
        line-height: 1.4 !important;
        letter-spacing: -0.5px !important;
        color: var(--msk-text-color, #1F2937) !important;
        display: -webkit-box !important;
        -webkit-line-clamp: 2 !important;
        -webkit-box-orient: vertical !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        max-height: 67px !important;
      }

      .mysellkit-bottom-section {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      .mysellkit-price-container {
        display: flex;
        align-items: baseline;
        gap: 12px;
      }
      .mysellkit-price-container.no-price { display: none; }

      .mysellkit-price-current {
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-weight: 500 !important;
        font-size: 28px !important;
        line-height: 1.3 !important;
        letter-spacing: -1px !important;
        color: var(--msk-text-color, #1F2937) !important;
      }

      .mysellkit-price-old {
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-weight: 400 !important;
        font-size: 22px !important;
        line-height: 1.3 !important;
        letter-spacing: -1px !important;
        color: var(--msk-text-color-light, #9CA3AF) !important;
        text-decoration: line-through !important;
        opacity: 0.8;
      }

      .mysellkit-cta-section {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .mysellkit-cta {
        width: 100%;
        height: 54px;
        background: var(--msk-primary-color, #00D66F);
        border: none;
        border-radius: var(--msk-radius-sm);
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        position: relative;
        overflow: hidden;
      }
      .mysellkit-cta::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: linear-gradient(135deg, rgba(255,255,255,0.1) 0%, transparent 100%);
        pointer-events: none;
      }
      .mysellkit-cta:hover:not(:disabled) {
        filter: brightness(0.95);
        transform: translateY(-2px);
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.2);
      }
      .mysellkit-cta:active:not(:disabled) { transform: translateY(0); }
      .mysellkit-cta:disabled {
        opacity: 0.7;
        cursor: not-allowed;
        transform: none;
      }

      .mysellkit-cta-text {
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-weight: 600 !important;
        font-size: 15px !important;
        line-height: 1.2 !important;
        color: var(--msk-cta-text-color, #000000) !important;
      }

      .mysellkit-cta-arrow {
        font-size: 16px !important;
        color: var(--msk-cta-text-color, #000000) !important;
        transition: transform 0.2s ease;
      }
      .mysellkit-cta:hover:not(:disabled) .mysellkit-cta-arrow { transform: translateX(3px); }

      .mysellkit-spinner {
        display: inline-block;
        width: 16px;
        height: 16px;
        border: 2px solid var(--msk-cta-text-color, #000000)40;
        border-radius: 50%;
        border-top-color: var(--msk-cta-text-color, #000000);
        animation: mysellkit-spin 0.6s linear infinite;
      }
      @keyframes mysellkit-spin { to { transform: rotate(360deg); } }

      .mysellkit-powered {
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-size: 12px !important;
        font-weight: 400 !important;
        color: var(--msk-text-color-light, #9CA3AF) !important;
        text-align: center !important;
      }

      .mysellkit-powered a {
        color: var(--msk-text-color-light, #9CA3AF);
        text-decoration: none;
        font-weight: 600 !important;
        font-size: 12px !important;
        transition: color 0.2s ease;
      }
      .mysellkit-powered a:hover { color: var(--msk-primary-color, #00D66F); }

      .mysellkit-right {
        width: 450px;
        height: 600px;
        background: var(--msk-right-bg, #F9FAFB);
        padding: 24px !important;
        overflow-y: auto !important;
        display: flex;
        flex-direction: column;
        gap: 48px !important;
        -webkit-overflow-scrolling: touch !important;
        overscroll-behavior: contain !important;
        position: relative;
      }

      .mysellkit-description {
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-weight: 500 !important;
        font-size: 15px !important;
        line-height: 1.75 !important;
        letter-spacing: 0.01em !important;
        color: var(--msk-text-color, #1F2937) !important;
      }

      .mysellkit-description p {
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-size: 15px !important;
        line-height: 1.75 !important;
        font-weight: 500 !important;
        margin-bottom: 20px !important;
      }
      .mysellkit-description p:last-child { margin-bottom: 0 !important; }

      .mysellkit-description h3 {
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-size: 16px !important;
        font-weight: 600 !important;
        line-height: 1.3 !important;
        color: var(--msk-text-color, #1F2937) !important;
      }
      .mysellkit-popup .mysellkit-included .mysellkit-included-title,
      h3.mysellkit-included-title {
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-weight: 600 !important;
        font-size: 16px !important;
        line-height: 1.3 !important;
        color: var(--msk-text-color, #1F2937) !important;
        margin-bottom: 4px !important;
      }
      .mysellkit-description h3 {
        margin-bottom: 16px !important;
        margin-top: 8px !important;
      }
      .mysellkit-description h3:first-child {
        margin-top: 0 !important;
      }
      .mysellkit-description strong {
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-weight: 600 !important;
        color: var(--msk-text-color, #1F2937) !important;
      }
      .mysellkit-description em {
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-style: italic !important;
        color: var(--msk-text-color, #1F2937) !important;
      }
      .mysellkit-description ul {
        list-style: none !important;
        padding: 0 !important;
        margin: 0 0 20px 0 !important;
      }
      .mysellkit-description ul li {
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-size: 15px !important;
        line-height: 1.65 !important;
        margin-left: 0 !important;
        margin-bottom: 10px !important;
        padding-left: 1em !important;
        position: relative;
        color: var(--msk-text-color, #1F2937) !important;
      }
      .mysellkit-description ul li::before {
        content: "•" !important;
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        color: var(--msk-text-color, #1F2937) !important;
        font-weight: bold !important;
        position: absolute;
        left: 0 !important;
      }
      .mysellkit-description ul li p { display: inline; margin: 0; }
      .mysellkit-description ol {
        list-style: none !important;
        padding: 0 !important;
        margin: 0 0 20px 0 !important;
        counter-reset: item;
      }
      .mysellkit-description ol li {
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-size: 15px !important;
        line-height: 1.65 !important;
        counter-increment: item;
        margin-left: 0 !important;
        margin-bottom: 10px !important;
        padding-left: 1.5em !important;
        position: relative;
        color: var(--msk-text-color, #1F2937) !important;
      }
      .mysellkit-description ol li::before {
        content: counter(item) "." !important;
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        color: var(--msk-text-color, #1F2937) !important;
        font-weight: 600 !important;
        position: absolute;
        left: 0 !important;
      }
      .mysellkit-description ol li p { display: inline; margin: 0; }

      .mysellkit-divider {
        border: none;
        height: 1px;
        background: rgba(0, 0, 0, 0.06);
        margin: 4px 0;
      }

      .mysellkit-included {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }

      .mysellkit-included-items {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .mysellkit-included-item {
        min-height: 54px;
        background: var(--msk-left-bg, #FFFFFF);
        border-radius: var(--msk-radius-sm);
        padding: 10px;
        display: flex;
        align-items: center;
        gap: 12px;
        transition: all 0.2s ease;
      }
      .mysellkit-included-item:hover {
        transform: translateX(2px);
      }

      .mysellkit-file-icon {
        width: 34px;
        height: 34px;
        background: linear-gradient(135deg, #F3F4F6 0%, #E5E7EB 100%);
        border-radius: 7px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px !important;
        flex-shrink: 0;
      }

      .mysellkit-file-name {
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-weight: 500 !important;
        font-size: 14px !important;
        line-height: 1.5 !important;
        color: var(--msk-text-color, #1F2937) !important;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .mysellkit-right::-webkit-scrollbar { width: 6px; }
      .mysellkit-right::-webkit-scrollbar-track { background: rgba(0, 0, 0, 0.02); }
      .mysellkit-right::-webkit-scrollbar-thumb {
        background: rgba(0, 0, 0, 0.15);
        border-radius: 3px;
        transition: background 0.2s;
      }
      .mysellkit-right::-webkit-scrollbar-thumb:hover { background: rgba(0, 0, 0, 0.25); }

      .mysellkit-mobile-content { display: none; }

      .mysellkit-floating-widget {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 320px;
        background: white;
        border-radius: var(--msk-radius-lg);
        padding: 14px 14px 14px 14px;
        box-shadow: var(--msk-shadow-md), var(--msk-shadow-sm);
        cursor: pointer;
        transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        z-index: 999998;
        display: none;
        animation: mysellkit-floatSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .mysellkit-floating-widget.visible { display: block; }
      .mysellkit-floating-widget:hover {
        transform: translateY(-4px);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16), 0 4px 8px rgba(0, 0, 0, 0.1);
      }

      .mysellkit-float-content {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .mysellkit-float-image {
        width: 64px;
        height: 64px;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        border-radius: var(--msk-radius-sm);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 32px !important;
        flex-shrink: 0;
        box-shadow: var(--msk-shadow-sm);
        object-fit: cover;
      }
      .mysellkit-float-image.no-image {
        background: var(--msk-primary-color, #00D66F);
        color: white !important;
        font-weight: bold !important;
      }

      .mysellkit-float-info {
        flex: 1;
        min-width: 0;
      }

      .mysellkit-float-title {
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-weight: 600 !important;
        font-size: 14px !important;
        line-height: 1.4 !important;
        color: var(--msk-text-color, #1F2937) !important;
        margin-bottom: 6px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        text-overflow: ellipsis;
        max-height: 39px;
      }

      .mysellkit-float-price {
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-weight: 500 !important;
        font-size: 18px !important;
        line-height: 1.3 !important;
        color: var(--msk-text-color, #1F2937) !important;
        display: flex;
        align-items: baseline;
        gap: 8px;
      }

      .mysellkit-float-price-old {
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-size: 14px !important;
        line-height: 1.3 !important;
        color: var(--msk-text-color-light, #9CA3AF) !important;
        text-decoration: line-through !important;
        font-weight: 400 !important;
      }

      .mysellkit-debug-badge {
        position: fixed;
        bottom: 10px;
        left: 10px;
        background: #ff6b6b;
        color: white !important;
        padding: 10px 14px;
        border-radius: 8px;
        font-family: 'DM Sans', 'Apple Color Emoji', 'Segoe UI Emoji', -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-size: 11px !important;
        font-weight: 600 !important;
        line-height: 1.4 !important;
        z-index: 9999999;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      }

      @media (max-width: 768px) {
        .mysellkit-toast {
          left: 16px;
          right: 16px;
          max-width: none;
          top: 16px;
        }

        .mysellkit-overlay { align-items: flex-end; }

        .mysellkit-popup {
          width: 100%;
          max-width: 100%;
          height: 100dvh;
          height: -webkit-fill-available;
          max-height: 100dvh;
          max-height: -webkit-fill-available;
          border-radius: 0;
          flex-direction: column;
          animation: mysellkit-slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .mysellkit-close {
          top: 16px;
          right: 16px;
          background: rgba(0, 0, 0, 0.1);
          backdrop-filter: blur(10px);
        }

        .mysellkit-left {
          width: 100%;
          height: 100%;
          padding: 20px 20px 0 20px;
          display: block;
          overflow-y: auto !important;
          padding-bottom: 184px;
          background: var(--msk-right-bg, #F9FAFB);
          -webkit-overflow-scrolling: touch !important;
          overscroll-behavior: contain !important;
          position: relative;
        }

        .mysellkit-left.no-price-mobile { padding-bottom: 154px; }

        .mysellkit-right { display: none; }

        .mysellkit-top { margin-bottom: 48px; }

        .mysellkit-image-wrapper {
          width: 100%;
          height: auto;
          aspect-ratio: 4/3;
          margin-bottom: 16px;
        }

        .mysellkit-image {
          width: 100%;
          height: 100%;
        }

        .mysellkit-title {
          width: 100%;
          font-size: 24px !important;
          -webkit-line-clamp: unset;
          max-height: none;
        }

        .mysellkit-price-container {
          margin-top: 0;
          margin-bottom: 0;
        }
        .mysellkit-price-container.no-price {
          display: none;
          margin-bottom: 0;
        }

        .mysellkit-mobile-content {
          display: flex;
          flex-direction: column;
          gap: 32px;
          margin-bottom: 0;
          padding-bottom: 8px;
        }

        .mysellkit-bottom-section {
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          background: var(--msk-left-bg, #FFFFFF);
          padding: 16px 20px 20px;
          box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.08);
          border-top: 1px solid rgba(0, 0, 0, 0.06);
          z-index: 999999;
          gap: 16px;
          display: flex;
          flex-direction: column;
        }

        .mysellkit-cta-section { gap: 8px; }
        .mysellkit-cta { height: 52px; }

        .mysellkit-left::-webkit-scrollbar { width: 4px; }
        .mysellkit-left::-webkit-scrollbar-track { background: rgba(0, 0, 0, 0.02); }
        .mysellkit-left::-webkit-scrollbar-thumb {
          background: rgba(0, 0, 0, 0.15);
          border-radius: 2px;
        }

        .mysellkit-floating-widget {
          bottom: 0;
          left: 0;
          right: 0;
          width: 100%;
          border-radius: var(--msk-radius-lg) var(--msk-radius-lg) 0 0;
          padding: 14px 14px 14px 14px;
          box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.12);
        }
        .mysellkit-floating-widget:hover { transform: translateY(-2px); }

        .mysellkit-float-image {
          width: 56px;
          height: 56px;
          font-size: 28px !important;
        }
        .mysellkit-float-title { font-size: 13px !important; }
        .mysellkit-float-price { font-size: 15px !important; }
      }

      @media (min-width: 769px) and (max-width: 900px) {
        .mysellkit-popup { width: 95vw; }
        .mysellkit-left, .mysellkit-right { width: 50%; }
        .mysellkit-image-wrapper, .mysellkit-image, .mysellkit-title { width: 100%; }
        .mysellkit-top { margin-bottom: 16px; }
      }

      body[data-mysellkit-popup-open] {
        overflow: hidden !important;
        height: 100vh !important;
        position: fixed !important;
        width: 100% !important;
      }

      .mysellkit-overlay {
        overflow: hidden !important;
        pointer-events: auto !important;
      }

      .mysellkit-popup {
        overflow: hidden !important;
        pointer-events: auto !important;
      }

      .mysellkit-right, .mysellkit-left {
        overflow-y: scroll !important;
        -webkit-overflow-scrolling: touch !important;
        overscroll-behavior: contain !important;
        touch-action: pan-y !important;
        pointer-events: auto !important;
        will-change: scroll-position;
      }

      .mysellkit-right::-webkit-scrollbar, .mysellkit-left::-webkit-scrollbar {
        width: 8px;
        display: block !important;
      }

      .mysellkit-right::-webkit-scrollbar-thumb, .mysellkit-left::-webkit-scrollbar-thumb {
        background: rgba(0, 0, 0, 0.3);
        border-radius: 4px;
      }

      #mysellkit-trigger { cursor: pointer !important; }
    `;
  }

  // ============================================
  // CREATE POPUP HTML
  // ============================================

  function createPopup(config) {
    debugLog('🎨', 'Creating popup with config:', config);

    const overlay = document.createElement('div');
    overlay.className = 'mysellkit-overlay';
    overlay.id = 'mysellkit-popup-widget';

    overlay.style.setProperty('--msk-primary-color', config.color_primary || '#00D66F');
    overlay.style.setProperty('--msk-left-bg', config.color_left || '#FFFFFF');
    overlay.style.setProperty('--msk-right-bg', config.color_right || '#F9FAFB');
    overlay.style.setProperty('--msk-text-color', config.color_text || '#1F2937');
    overlay.style.setProperty('--msk-text-color-light', config.color_text_light || '#9CA3AF');
    overlay.style.setProperty('--msk-cta-text-color', config.color_cta_text || '#000000');

    const includedHTML = config.included_items && config.included_items.length > 0
      ? renderIncludedItems(config.included_items, config.included_title)
      : '';
    const descriptionHTML = config.description_html || '';
    const hasImage = config.image && config.image.trim() !== '';
    const imageWrapperClass = hasImage ? 'mysellkit-image-wrapper' : 'mysellkit-image-wrapper no-image';
    const imageHTML = hasImage ? `<img src="${config.image}" alt="${config.title}" class="mysellkit-image" />` : '';
    const showPrice = config.show_price !== 'no';
    const priceContainerClass = showPrice ? 'mysellkit-price-container' : 'mysellkit-price-container no-price';
    const leftColumnClass = showPrice ? 'mysellkit-left' : 'mysellkit-left no-price-mobile';

    const priceHTML = showPrice ? `
      <div class="${priceContainerClass}">
        <span class="mysellkit-price-current">${config.currency || '$'}${config.price || '0'}</span>
        ${config.old_price ? `<span class="mysellkit-price-old">${config.currency || '$'}${config.old_price}</span>` : ''}
      </div>
    ` : '';

    const floatPriceHTML = showPrice ? `
      <div class="mysellkit-float-price">
        <span>${config.currency || '$'}${config.price || '0'}</span>
        ${config.old_price ? `<span class="mysellkit-float-price-old">${config.currency || '$'}${config.old_price}</span>` : ''}
      </div>
    ` : '';

    overlay.innerHTML = `
      <div class="mysellkit-popup">
        <button class="mysellkit-close" aria-label="Close">×</button>
        <div class="${leftColumnClass}">
          <div class="mysellkit-top">
            <div class="${imageWrapperClass}">${imageHTML}</div>
            <h2 class="mysellkit-title">${config.title || ''}</h2>
          </div>
          <div class="mysellkit-mobile-content">
            ${descriptionHTML ? `<div class="mysellkit-description">${descriptionHTML}</div>` : ''}
            ${includedHTML}
          </div>
          <div class="mysellkit-bottom-section">
            ${priceHTML}
            <div class="mysellkit-cta-section">
              <button class="mysellkit-cta">
                <span class="mysellkit-cta-text">${config.cta_text || 'Get Instant Access'}</span>
                <span class="mysellkit-cta-arrow">→</span>
              </button>
              <p class="mysellkit-powered">Powered by <a href="https://mysellkit.com" target="_blank">My Sell Kit</a></p>
            </div>
          </div>
        </div>
        <div class="mysellkit-right">
          ${descriptionHTML ? `<div class="mysellkit-description">${descriptionHTML}</div>` : ''}
          ${includedHTML}
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    debugLog('✅', 'Popup HTML injected into DOM');

    if (DEBUG_MODE && window.innerWidth <= 768) {
      setTimeout(() => {
        const bottomSection = overlay.querySelector('.mysellkit-bottom-section');
        debugLog('📱', 'Mobile Layout Debug:', {
          bottomSection: bottomSection ? 'FOUND' : 'MISSING',
          styles: bottomSection ? {
            display: window.getComputedStyle(bottomSection).display,
            position: window.getComputedStyle(bottomSection).position,
            zIndex: window.getComputedStyle(bottomSection).zIndex
          } : null
        });
      }, 500);
    }

    createFloatingWidget(config, floatPriceHTML, hasImage);
    setupEventListeners(overlay, config);
  }

  // ============================================
  // CREATE FLOATING WIDGET
  // ============================================

  function createFloatingWidget(config, priceHTML, hasImage) {
    const floatingWidget = document.createElement('div');
    floatingWidget.className = 'mysellkit-floating-widget';
    floatingWidget.id = 'mysellkit-popup-floating';

    floatingWidget.style.setProperty('--msk-primary-color', config.color_primary || '#00D66F');
    floatingWidget.style.setProperty('--msk-text-color', config.color_text || '#1F2937');
    floatingWidget.style.setProperty('--msk-text-color-light', config.color_text_light || '#9CA3AF');

    const floatingEmoji = config.floating_emoji || '✨';
    const floatImageClass = hasImage ? 'mysellkit-float-image' : 'mysellkit-float-image no-image';
    const floatImageContent = hasImage
      ? `<img src="${config.image}" alt="${config.title}" class="mysellkit-float-image" />`
      : `<div class="${floatImageClass}">${floatingEmoji}</div>`;

    floatingWidget.innerHTML = `
      <div class="mysellkit-float-content">
        ${floatImageContent}
        <div class="mysellkit-float-info">
          <div class="mysellkit-float-title">${config.title || ''}</div>
          ${priceHTML}
        </div>
      </div>
    `;

    document.body.appendChild(floatingWidget);
    debugLog('✅', 'Floating widget injected into DOM');

    floatingWidget.addEventListener('click', () => {
      debugLog('🔄', 'Floating widget clicked - reopening popup');
      hideFloatingWidget();
      showPopup();
    });
  }

  // ============================================
  // EVENT LISTENERS (consolidated with delegation)
  // ============================================

  function setupEventListeners(overlay, config) {
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('.mysellkit-close')) {
        debugLog('❌', 'Close button clicked');
        trackEvent('close');
        hidePopup();
        if (isPersistentModeEnabled()) showFloatingWidget();
        return;
      }

      if (e.target.closest('.mysellkit-cta')) {
        debugLog('🛒', 'CTA button clicked');
        performCheckout(e.target.closest('.mysellkit-cta'), config);
        return;
      }

      if (e.target === overlay) {
        debugLog('❌', 'Overlay clicked (close)');
        trackEvent('close');
        hidePopup();
        if (isPersistentModeEnabled()) showFloatingWidget();
      }
    });
  }

  // ============================================
  // PERFORM CHECKOUT
  // ============================================

  async function performCheckout(buttonElement, config) {
    debugLog('🛒', 'Starting checkout process');

    if (config && config.stripe_connected !== 'yes') {
      debugLog('🔴', 'Cannot checkout: Stripe not connected');
      showToast('Payment processing not configured. Please contact the seller.', 'error');
      return;
    }

    if (config && config.is_live !== 'yes') {
      debugLog('🚧', 'Cannot checkout: Product is in DRAFT mode');
      showToast('This product is in draft mode. Checkout is disabled.', 'error');
      return;
    }

    const purchaseToken = generatePurchaseToken();
    debugLog('🎫', 'Purchase token generated:', purchaseToken);

    trackEvent('click', { purchase_token: purchaseToken });

    const textElement = buttonElement.querySelector('.mysellkit-cta-text');
    const arrowElement = buttonElement.querySelector('.mysellkit-cta-arrow');
    const originalText = textElement.textContent;

    textElement.textContent = 'Loading...';
    arrowElement.style.display = 'none';
    buttonElement.disabled = true;

    const spinner = document.createElement('span');
    spinner.className = 'mysellkit-spinner';
    buttonElement.appendChild(spinner);

    const resetButton = () => {
      textElement.textContent = originalText;
      arrowElement.style.display = 'inline';
      spinner.remove();
      buttonElement.disabled = false;
    };

    try {
      debugLog('💳', 'Creating checkout session');

      const response = await fetch(`${CONFIG.API_BASE}/create-checkout-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          popup_id: POPUP_ID,
          product_id: config.product_id,
          session_id: getSessionId(),
          purchase_token: purchaseToken,
          debug_mode: DEBUG_MODE ? 'yes' : 'no',
          success_url: `${CONFIG.CHECKOUT_BASE}/payment-processing?token=${purchaseToken}`,
          cancel_url: window.location.href + (window.location.href.includes('?') ? '&' : '?') + 'mysellkit_cancelled=true'
        })
      });

      const data = await response.json();
      debugLog('💳', 'Checkout API response:', data);

      if (data.response && data.response.success === 'yes' && data.response.checkout_url) {
        sessionStorage.setItem('mysellkit_purchase_token', purchaseToken);
        debugLog('✅', 'Checkout URL received, redirecting...');

        hidePopup();
        setTimeout(() => {
          window.location.replace(data.response.checkout_url);
        }, 150);
      } else {
        console.error('❌ Invalid checkout response structure:', data);
        let errorMessage = 'Unable to start checkout. ';
        if (data.response?.error) errorMessage += data.response.error;
        else if (data.error) errorMessage += data.error;
        else if (data.response?.success === 'no') errorMessage += 'The checkout session could not be created.';
        else errorMessage += 'Please try again or contact support.';

        showToast(errorMessage, 'error');
        resetButton();
      }
    } catch (error) {
      console.error('❌ Checkout request failed:', error);
      showToast('Connection error. Please check your internet and try again.', 'error');
      resetButton();
    }
  }

  // ============================================
  // SHOW/HIDE POPUP & FLOATING WIDGET
  // ============================================

  function enableColumnScroll(overlay) {
    const rightCol = overlay.querySelector('.mysellkit-right');
    const leftCol = overlay.querySelector('.mysellkit-left');

    [rightCol, leftCol].forEach(col => {
      if (!col) return;
      col.scrollTop = 0;
      col.style.setProperty('overflow-y', 'scroll', 'important');
      col.style.setProperty('-webkit-overflow-scrolling', 'touch', 'important');
      col.style.setProperty('overscroll-behavior', 'contain', 'important');

      ['wheel', 'touchmove'].forEach(eventType => {
        col.addEventListener(eventType, (e) => e.stopPropagation(), { passive: false });
      });
    });

    debugLog('✅', 'Column scroll enabled');
  }

  function showPopup() {
    const overlay = document.getElementById('mysellkit-popup-widget');
    if (!overlay) {
      console.error('❌ CRITICAL: Popup overlay not found in DOM!');
      return;
    }

    debugLog('🎉', 'showPopup() called');

    lockBodyScroll();
    setTimeout(() => enableColumnScroll(overlay), 100);

    overlay.classList.add('visible');
    popupShown = true;

    trackImpressionOnce();
  }

  function hidePopup() {
    const overlay = document.getElementById('mysellkit-popup-widget');
    if (!overlay) return;

    overlay.classList.remove('visible');
    unlockBodyScroll();
  }

  function showFloatingWidget() {
    const floating = document.getElementById('mysellkit-popup-floating');
    if (!floating) return;

    debugLog('💬', 'Showing floating widget');
    setTimeout(() => floating.classList.add('visible'), 300);
  }

  function hideFloatingWidget() {
    const floating = document.getElementById('mysellkit-popup-floating');
    if (floating) floating.classList.remove('visible');
  }

  function hideAllWidgets() {
    debugLog('🚫', 'Hiding all widgets (purchase completed)');
    hidePopup();
    hideFloatingWidget();
  }

  // ============================================
  // PAYMENT STATUS CHECKS
  // ============================================

  function checkForCancelledPayment() {
    const urlParams = new URLSearchParams(window.location.search);

    if (urlParams.get('mysellkit_cancelled') === 'true') {
      debugLog('💳', 'Payment was cancelled');
      showToast('Payment was not completed. You can try again anytime!', 'error');

      if (config && isPersistentModeEnabled()) {
        setTimeout(() => showFloatingWidget(), 500);
      }

      const cleanUrl = window.location.pathname + window.location.search.replace(/[?&]mysellkit_cancelled=true/, '').replace(/^&/, '?');
      window.history.replaceState({}, '', cleanUrl || window.location.pathname);
    }
  }

  function checkForSuccessfulPurchase() {
    const urlParams = new URLSearchParams(window.location.search);

    if (urlParams.get('mysellkit_success') === 'true') {
      debugLog('✅', 'Successful purchase detected');
      markProductAsPurchased();
      hideAllWidgets();

      const cleanUrl = window.location.pathname + window.location.search.replace(/[?&]mysellkit_success=true/, '').replace(/^&/, '?');
      window.history.replaceState({}, '', cleanUrl || window.location.pathname);
    }
  }

  // ============================================
  // MANUAL TRIGGER
  // ============================================

  function attachManualTrigger() {
    if (!config || config.trigger_type !== 'click') return;

    debugLog('🎯', 'Manual trigger mode enabled');

    const attachToButton = () => {
      const button = document.getElementById('mysellkit-trigger');

      if (!button) {
        console.warn('MySellKit: Manual trigger enabled but no element with id="mysellkit-trigger" found');
        debugLog('💡', 'Add id="mysellkit-trigger" to your button/link');
        return;
      }

      button.addEventListener('click', (e) => {
        e.preventDefault();
        debugLog('🎯', 'Manual trigger clicked');

        if (hasPurchasedProduct()) {
          showToast('You already own this product!', 'error');
          return;
        }

        hideFloatingWidget();
        showPopup();
      });

      debugLog('✅', 'Manual trigger attached');
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', attachToButton);
    } else {
      attachToButton();
    }
  }

  // ============================================
  // GLOBAL API
  // ============================================

  function exposeGlobalAPI() {
    if (!window.MySellKit) window.MySellKit = {};

    window.MySellKit.open = function(popupId) {
      if (!config) {
        console.error('MySellKit: Popup not initialized yet');
        return;
      }

      if (popupId && popupId !== POPUP_ID) {
        console.warn(`MySellKit: Popup ID mismatch. Expected ${POPUP_ID}, got ${popupId}`);
        return;
      }

      if (hasPurchasedProduct()) {
        showToast('You already own this product!', 'error');
        return;
      }

      debugLog('🎯', 'MySellKit.open() called');
      hideFloatingWidget();
      showPopup();
    };

    debugLog('✅', 'MySellKit.open() API available');
  }

  // ============================================
  // TRIGGERS
  // ============================================

  function triggerPopupOrFloating(showFloatingInstead) {
    triggerActivated = true;
    updateDebugBadge();

    if (showFloatingInstead) {
      sessionStorage.setItem(`mysellkit_impression_${POPUP_ID}`, 'true');
      showFloatingWidget();
    } else {
      showPopup();
    }
  }

  function setupTriggers() {
    if (!config) return;

    debugLog('⚡', 'Setting up trigger:', config.trigger_type);

    if (!shouldTriggerPopup()) {
      debugLog('⚠️', 'Skipping automatic trigger setup');
      return;
    }

    const isMobile = window.innerWidth <= 768;
    const showFloatingInstead = isMobile && config.mobile_floating === 'yes';

    if (DEBUG_MODE && showFloatingInstead) {
      debugLog('📱', 'Mobile + floating trigger enabled');
    }

    switch(config.trigger_type) {
      case 'scroll':
        setupScrollTrigger(config.trigger_value, showFloatingInstead);
        break;
      case 'time':
        setupTimeTrigger(config.trigger_value, showFloatingInstead);
        break;
      case 'exit_intent':
      case 'exit':
        setupExitTrigger(showFloatingInstead);
        break;
      case 'click':
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', attachManualTrigger);
        } else {
          attachManualTrigger();
        }
        break;
      default:
        debugLog('⚠️', 'Unknown trigger type, defaulting to 5s');
        setupTimeTrigger(5, showFloatingInstead);
    }
  }

  function setupScrollTrigger(percentage, showFloatingInstead) {
    const scrollPercentage = percentage != null ? percentage : 50;
    debugLog('📜', `Scroll trigger set at ${scrollPercentage}%`);

    let triggered = false;
    window.addEventListener('scroll', () => {
      if (triggered) return;

      const scrollPercent = (window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100;
      currentScrollPercent = Math.round(scrollPercent);
      updateDebugBadge();

      if (scrollPercent >= scrollPercentage) {
        debugLog('✅', `Scroll trigger activated at ${scrollPercent.toFixed(0)}%`);
        triggerPopupOrFloating(showFloatingInstead);
        triggered = true;
      }
    });
  }

  function setupTimeTrigger(seconds, showFloatingInstead) {
    const triggerSeconds = seconds != null ? seconds : 5;
    debugLog('⏱️', `Time trigger set for ${triggerSeconds}s`);

    if (DEBUG_MODE) {
      timeInterval = setInterval(() => {
        currentTimeElapsed++;
        updateDebugBadge();
        if (currentTimeElapsed >= triggerSeconds) clearInterval(timeInterval);
      }, 1000);
    }

    setTimeout(() => {
      debugLog('✅', `Time trigger activated after ${triggerSeconds}s`);
      triggerPopupOrFloating(showFloatingInstead);
    }, triggerSeconds * 1000);
  }

  function setupExitTrigger(showFloatingInstead) {
    debugLog('🚪', 'Exit intent trigger set');

    let triggered = false;
    document.addEventListener('mouseleave', (e) => {
      if (triggered || e.clientY > 10) return;

      debugLog('✅', 'Exit intent trigger activated');
      triggerPopupOrFloating(showFloatingInstead);
      triggered = true;
    });
  }

  // ============================================
  // INIT
  // ============================================

  async function init() {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer-when-downgrade';
    if (!document.querySelector('meta[name="referrer"]')) {
      document.head.appendChild(meta);
    }

    debugLog('🚀', `MySellKit Popup v${CONFIG.VERSION} initializing...`);

    if (!POPUP_ID) {
      console.error('MySellKit: Missing data-popup attribute');
      return;
    }

    debugLog('📦', 'Popup ID:', POPUP_ID);

    config = await fetchPopupConfig();
    if (!config) {
      console.error('MySellKit: Failed to load popup config');
      return;
    }

    if (config.is_live !== 'yes' && !DEBUG_MODE) {
      console.log('🚧 Popup is in DRAFT mode - popup will not load');
      return;
    }

    if (config.stripe_connected !== 'yes' && !DEBUG_MODE) {
      console.log('🔴 Stripe not connected - popup will not load');
      return;
    }

    if (config.is_live !== 'yes' && DEBUG_MODE) {
      console.log('🚧 DRAFT MODE: Product is not live. Checkout disabled.');
    }

    if (config.stripe_connected !== 'yes' && DEBUG_MODE) {
      console.log('🔴 STRIPE NOT CONNECTED: Checkout disabled.');
    }

    checkForCancelledPayment();
    checkForSuccessfulPurchase();

    if (hasPurchasedProduct()) {
      debugLog('🛑', 'Product already purchased, stopping');
      return;
    }

    injectCSS(config);
    createPopup(config);
    exposeGlobalAPI();

    if (shouldShowFloatingWidget() && isPersistentModeEnabled()) {
      debugLog('💬', 'Showing floating widget immediately');
      setTimeout(() => showFloatingWidget(), 100);
    } else {
      setupTriggers();
    }

    debugLog('✅', 'MySellKit Popup initialized successfully');
    updateDebugBadge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
