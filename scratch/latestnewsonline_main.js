// Interstitial page logic: Step-by-step flow with heartbeat timer
// With Cloudflare Turnstile captcha on the final step
(function () {
  'use strict';

  // ============================================
  // BROWSER FINGERPRINTING MODULE
  // ============================================
  const Fingerprint = {
    // Generate a simple but effective browser fingerprint
    async generate() {
      const components = [];
      
      // 1. Screen info
      components.push(screen.width + 'x' + screen.height + 'x' + screen.colorDepth);
      
      // 2. Timezone
      components.push(Intl.DateTimeFormat().resolvedOptions().timeZone);
      
      // 3. Language
      components.push(navigator.language || navigator.userLanguage);
      
      // 4. Platform
      components.push(navigator.platform);
      
      // 5. Hardware concurrency
      components.push(navigator.hardwareConcurrency || 'unknown');
      
      // 6. Device memory (if available)
      components.push(navigator.deviceMemory || 'unknown');
      
      // 7. Canvas fingerprint
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font = '14px Arial';
        ctx.fillStyle = '#f60';
        ctx.fillRect(125, 1, 62, 20);
        ctx.fillStyle = '#069';
        ctx.fillText('XDMovies,🎬', 2, 15);
        ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
        ctx.fillText('XDMovies,🎬', 4, 17);
        components.push(canvas.toDataURL().slice(-50));
      } catch (e) {
        components.push('canvas_error');
      }
      
      // 8. WebGL renderer
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (gl) {
          const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
          if (debugInfo) {
            components.push(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL));
          }
        }
      } catch (e) {
        components.push('webgl_error');
      }
      
      // 9. Touch support
      components.push('ontouchstart' in window ? 'touch' : 'no_touch');
      
      // 10. Plugin count
      components.push(navigator.plugins ? navigator.plugins.length : 0);
      
      // 11. Cookies enabled
      components.push(navigator.cookieEnabled);
      
      // 12. Do Not Track
      components.push(navigator.doNotTrack || 'unset');
      
      // Create hash
      const str = components.join('|||');
      return await this.hash(str);
    },
    
    // Simple hash function
    async hash(str) {
      if (crypto && crypto.subtle) {
        const msgBuffer = new TextEncoder().encode(str);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
      }
      // Fallback for older browsers
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return Math.abs(hash).toString(16).padStart(32, '0').slice(0, 32);
    }
  };

  // ============================================
  // TURNSTILE CAPTCHA HANDLING
  // ============================================
  let turnstileToken = null;
  
  // Global callback for Turnstile success
  window.onTurnstileSuccess = function(token) {
    turnstileToken = token;
    // Enable the Go to Link button
    const goToLinkBtn = document.getElementById('goToLinkBtn');
    if (goToLinkBtn) {
      goToLinkBtn.disabled = false;
    }
  };
  
  // Global callback for Turnstile error
  window.onTurnstileError = function() {
    console.error('Turnstile challenge failed');
    turnstileToken = null;
    const goToLinkBtn = document.getElementById('goToLinkBtn');
    if (goToLinkBtn) {
      goToLinkBtn.disabled = true;
    }
  };
  
  // Global callback for Turnstile expiration
  window.onTurnstileExpired = function() {
    console.warn('Turnstile token expired');
    turnstileToken = null;
    const goToLinkBtn = document.getElementById('goToLinkBtn');
    if (goToLinkBtn) {
      goToLinkBtn.disabled = true;
    }
    // Reset widget to get a new token
    if (typeof turnstile !== 'undefined') {
      turnstile.reset();
    }
  };

  // ============================================
  // MAIN APPLICATION
  // ============================================
  
  // Extract code from URL path: /r/:code
  const pathParts = location.pathname.split('/');
  const code = pathParts[pathParts.length - 1] || pathParts[pathParts.length - 2];
  
  // Check if we're on step 2 (after reload)
  const urlParams = new URLSearchParams(location.search);
  const step = urlParams.get('step') || '1';
  const savedSessionId = urlParams.get('sid');
  
  // DOM Elements
  const titleEl = document.getElementById('title');
  const subtitleEl = document.getElementById('subtitle');
  const counterEl = document.getElementById('counter');
  const counterWrapper = document.getElementById('counterWrapper');
  const progressBar = document.getElementById('progressBar');
  const progressFill = document.getElementById('progressFill');
  const generateBtn = document.getElementById('generateBtn');
  const continueBtn = document.getElementById('continueBtn');
  const goToLinkBtn = document.getElementById('goToLinkBtn');
  const pausedNotice = document.getElementById('pausedNotice');
  const turnstileContainer = document.getElementById('turnstileContainer');

  // Constants
  const TIMER_SECONDS = 6;

  // Validate code
  if (!code || code === 'r') {
    titleEl.textContent = 'Invalid Link';
    subtitleEl.textContent = 'This link is not valid';
    if (counterWrapper) counterWrapper.classList.add('hidden');
    if (progressBar) progressBar.classList.add('hidden');
    if (generateBtn) generateBtn.classList.add('hidden');
    return;
  }

  // State
  let socket = null;
  let sessionId = savedSessionId || null;
  let token = null;
  let currentStep = step === '2' ? 2 : 0; // 0: initial, 1: page1 timer, 2: page2 timer, 3: ready
  let localCount = TIMER_SECONDS;
  let timerInterval = null;
  let isVisible = document.visibilityState === 'visible' && document.hasFocus();
  let sessionCreated = step === '2'; // Already created if on step 2
  let browserFingerprint = null;

  // Generate fingerprint on load
  Fingerprint.generate().then(fp => {
    browserFingerprint = fp;
  });

  // Initial UI state - show generate button
  function showInitialState() {
    titleEl.textContent = 'Get Your Link';
    subtitleEl.textContent = 'Click the button below to generate your download link';
    counterWrapper.classList.add('hidden');
    progressBar.classList.add('hidden');
    generateBtn.classList.remove('hidden');
    continueBtn.classList.add('hidden');
    goToLinkBtn.classList.add('hidden');
    pausedNotice.classList.add('hidden');
    if (turnstileContainer) turnstileContainer.classList.add('hidden');
  }

  // Show Page 1 timer
  function showPage1() {
    currentStep = 1;
    localCount = TIMER_SECONDS;
    titleEl.textContent = 'Please Wait...';
    subtitleEl.textContent = 'Step 1 of 2';
    counterWrapper.classList.remove('hidden');
    progressBar.classList.remove('hidden');
    generateBtn.classList.add('hidden');
    continueBtn.classList.add('hidden');
    goToLinkBtn.classList.add('hidden');
    if (turnstileContainer) turnstileContainer.classList.add('hidden');
    counterEl.textContent = localCount;
    updateProgress();
    if (isVisible) {
      startTimer();
    }
  }

  // Show Page 2 timer (after reload)
  function showPage2() {
    currentStep = 2;
    localCount = TIMER_SECONDS;
    titleEl.textContent = 'Almost There...';
    subtitleEl.textContent = 'Step 2 of 2';
    counterWrapper.classList.remove('hidden');
    progressBar.classList.remove('hidden');
    generateBtn.classList.add('hidden');
    continueBtn.classList.add('hidden');
    goToLinkBtn.classList.add('hidden');
    if (turnstileContainer) turnstileContainer.classList.add('hidden');
    counterEl.textContent = localCount;
    updateProgress();
    if (isVisible) {
      startTimer();
    }
  }

  // Show step 1 complete - button to continue to step 2
  function showStep1Complete() {
    titleEl.textContent = 'Step 1 Complete!';
    subtitleEl.textContent = 'Click continue to proceed to step 2';
    counterWrapper.classList.add('hidden');
    progressBar.classList.add('hidden');
    generateBtn.classList.add('hidden');
    continueBtn.classList.remove('hidden');
    goToLinkBtn.classList.add('hidden');
    pausedNotice.classList.add('hidden');
    if (turnstileContainer) turnstileContainer.classList.add('hidden');
  }

  // Show final state with captcha and go to link button
  function showReady() {
    currentStep = 3;
    titleEl.textContent = 'Your Link is Ready!';
    subtitleEl.textContent = 'Please complete the captcha to continue';
    counterWrapper.classList.add('hidden');
    progressBar.classList.add('hidden');
    continueBtn.classList.add('hidden');
    pausedNotice.classList.add('hidden');
    
    // Show Turnstile captcha
    if (turnstileContainer) {
      turnstileContainer.classList.remove('hidden');
    }
    
    // Show button (disabled until captcha is solved)
    goToLinkBtn.classList.remove('hidden');
    goToLinkBtn.disabled = !turnstileToken;
  }

  // Progress bar update
  function updateProgress() {
    let totalElapsed = 0;
    
    if (currentStep === 1) {
      totalElapsed = TIMER_SECONDS - localCount;
    } else if (currentStep === 2) {
      totalElapsed = TIMER_SECONDS + (TIMER_SECONDS - localCount);
    }
    
    const totalDuration = TIMER_SECONDS * 2;
    const percent = (totalElapsed / totalDuration) * 100;
    
    if (progressFill) {
      progressFill.style.width = percent + '%';
    }
  }

  // Timer tick
  function tick() {
    if (!isVisible) return;
    
    counterEl.textContent = localCount;
    updateProgress();
    
    if (localCount === 0) {
      stopTimer();
      if (currentStep === 1) {
        // Show continue button instead of auto-redirect
        showStep1Complete();
      } else if (currentStep === 2) {
        showReady();
      }
    } else {
      localCount -= 1;
    }
  }

  function startTimer() {
    if (timerInterval) return;
    pausedNotice.classList.add('hidden');
    timerInterval = setInterval(tick, 1000);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  // Visibility handling
  function handleVisibilityChange() {
    const wasVisible = isVisible;
    isVisible = document.visibilityState === 'visible' && document.hasFocus();
    
    // Notify server
    if (socket && socket.connected) {
      socket.emit('visibility', isVisible ? 'visible' : 'hidden');
    }
    
    // Handle timer pause/resume only during timer steps
    if (currentStep === 1 || currentStep === 2) {
      if (isVisible && !wasVisible) {
        // User came back - resume timer
        pausedNotice.classList.add('hidden');
        startTimer();
      } else if (!isVisible && wasVisible) {
        // User left - pause timer
        stopTimer();
        pausedNotice.classList.remove('hidden');
      }
    }
  }

  // Subscribe to visibility changes
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('focus', handleVisibilityChange);
  window.addEventListener('blur', handleVisibilityChange);

  // Create session and connect socket
  async function initSession() {
    if (sessionCreated && sessionId) return true;
    
    // Wait for fingerprint
    if (!browserFingerprint) {
      browserFingerprint = await Fingerprint.generate();
    }
    
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          code,
          fingerprint: browserFingerprint,
        }),
      });
      
      const json = await res.json();
      
      if (json.error) {
        titleEl.textContent = 'Error';
        subtitleEl.textContent = json.error;
        generateBtn.disabled = false;
        generateBtn.textContent = 'Try Again';
        return false;
      }
      
      sessionId = json.sessionId;
      token = json.token;
      sessionCreated = true;
      
      // Connect socket
      socket = io(undefined, { transports: ['websocket'] });
      
      socket.on('connect', () => {
        socket.emit('bind', token);
        socket.emit('visibility', isVisible ? 'visible' : 'hidden');
      });
      
      socket.on('error', (e) => console.warn('socket err', e));
      
      // Heartbeat every 1s
      setInterval(() => {
        if (socket && socket.connected) {
          socket.emit('heartbeat');
        }
      }, 1000);
      
      return true;
    } catch (e) {
      console.error('Session error:', e);
      titleEl.textContent = 'Error';
      subtitleEl.textContent = 'Failed to create session. Please try again.';
      generateBtn.disabled = false;
      generateBtn.textContent = 'Try Again';
      return false;
    }
  }

  // Connect socket for step 2 (session already exists)
  async function connectSocketForStep2() {
    // Wait for fingerprint
    if (!browserFingerprint) {
      browserFingerprint = await Fingerprint.generate();
    }
    
    try {
      // Get a new bind token using the existing session cookie
      const res = await fetch('/api/session/rebind', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          fingerprint: browserFingerprint,
        }),
      });
      
      const json = await res.json();
      
      if (json.error) {
        console.error('Rebind error:', json.error);
        titleEl.textContent = 'Error';
        subtitleEl.textContent = 'Session expired. Please refresh and start again.';
        return;
      }
      
      sessionId = json.sessionId;
      const bindToken = json.token;
      
      // Connect socket with the new bind token
      socket = io(undefined, { transports: ['websocket'] });
      
      socket.on('connect', () => {
        socket.emit('bind', bindToken);
        socket.emit('visibility', isVisible ? 'visible' : 'hidden');
      });
      
      socket.on('bound', () => {
        console.log('Socket bound successfully for step 2');
      });
      
      socket.on('error', (e) => console.warn('socket err', e));
      
      // Heartbeat every 1s - this is what tracks time on server
      setInterval(() => {
        if (socket && socket.connected) {
          socket.emit('heartbeat');
        }
      }, 1000);
      
    } catch (e) {
      console.error('Failed to rebind socket:', e);
      titleEl.textContent = 'Error';
      subtitleEl.textContent = 'Connection failed. Please refresh and try again.';
    }
  }

  // Handle generate button click
  if (generateBtn) {
    generateBtn.addEventListener('click', async () => {
      generateBtn.disabled = true;
      generateBtn.textContent = 'Loading...';
      
      const success = await initSession();
      
      if (success) {
        showPage1();
      } else {
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate Link';
      }
    });
  }

  // Handle continue button click (after step 1 completes)
  if (continueBtn) {
    continueBtn.addEventListener('click', () => {
      // Reload page for step 2 to load new ads
      location.href = `/r/${code}?step=2&sid=${sessionId}`;
    });
  }

  // Handle go to link button click
  if (goToLinkBtn) {
    goToLinkBtn.addEventListener('click', async () => {
      // Check if Turnstile was completed
      if (!turnstileToken) {
        titleEl.textContent = 'Error';
        subtitleEl.textContent = 'Please complete the captcha first.';
        return;
      }
      
      goToLinkBtn.disabled = true;
      goToLinkBtn.textContent = 'Opening...';
      
      try {
        const res = await fetch('/api/session/complete', { 
          method: 'POST', 
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fingerprint: browserFingerprint,
            turnstileToken: turnstileToken,
          }),
        });
        const body = await res.json();
        
        if (body && body.token) {
          // Navigate in same tab to avoid popup blockers
          window.location.href = `/go/${sessionId}?t=${encodeURIComponent(body.token)}`;
        } else {
          goToLinkBtn.disabled = false;
          goToLinkBtn.textContent = '🔗 Go to Link';
          titleEl.textContent = 'Error';
          subtitleEl.textContent = body.error || 'Session expired. Please refresh and try again.';
          
          // Reset Turnstile if verification failed
          if (typeof turnstile !== 'undefined') {
            turnstile.reset();
            turnstileToken = null;
          }
        }
      } catch (e) {
        console.error('Complete failed:', e);
        goToLinkBtn.disabled = false;
        goToLinkBtn.textContent = '🔗 Go to Link';
      }
    });
  }

  // Initialize based on current step
  if (step === '2' && savedSessionId) {
    // We're on step 2 after reload
    connectSocketForStep2();
    showPage2();
  } else {
    // Initial state
    showInitialState();
  }

})();
