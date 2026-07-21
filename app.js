(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Used only if geolocation is unavailable/denied, so the demo still has
  // something plausible to show and walk around.
  const FALLBACK_ANCHOR = { lat: 40.493151616644354, lng: -74.4243920343003 };

  // ---------- DOM ----------
  const ctaBtn = document.getElementById('ctaBtn');
  const panelTitle = document.getElementById('panelTitle');
  const panelSubtitle = document.getElementById('panelSubtitle');
  const stepper = document.getElementById('stepper');
  const steps = Array.from(stepper.querySelectorAll('.step'));
  const liveMarkerEl = document.getElementById('liveMarker');
  const coneGroup = document.getElementById('coneGroup');
  const coneEl = document.getElementById('cone');
  const pulseEl = document.getElementById('pulse');
  const locoffEl = document.getElementById('locoff-badge');
  const bannerEl = document.getElementById('permBanner');
  const bannerTextEl = document.getElementById('permBannerText');
  const backBtn = document.getElementById('backBtn');
  const chatBtn = document.getElementById('chatBtn');
  const mapEl = document.getElementById('map');

  // ---------- Cone shape (static) ----------
  function polar(angleDeg, r) {
    const a = (angleDeg * Math.PI) / 180;
    return { x: r * Math.sin(a), y: -r * Math.cos(a) };
  }
  (function drawCone() {
    const r = 58;
    const p1 = polar(-32, r);
    const p2 = polar(32, r);
    coneEl.setAttribute('d', `M0,0 L${p1.x.toFixed(1)},${p1.y.toFixed(1)} A${r},${r} 0 0 1 ${p2.x.toFixed(1)},${p2.y.toFixed(1)} Z`);
  })();

  // ---------- State ----------
  let spotsDone = 0;
  let locating = false;
  let resultsShown = false;
  let spotPositions = []; // recorded {lat,lng} per confirmed spot
  let spotMarkers = [];

  let map = null;
  let mapReady = false;
  let mapCentered = false;
  let currentLatLng = null;
  let liveMarkerOverlay = null;

  let usingLiveLocation = false;
  let usingLiveHeading = false;
  let lastHeading = 0;
  let lastMovementHeading = 0;
  let trackingStarted = false;
  let simTimer = null;
  let bannerTimer = null;
  let bubbleOverlay = null;

  // ---------- Banner ----------
  function showBanner(text, kind) {
    bannerTextEl.textContent = text;
    bannerEl.className = 'info-banner show' + (kind ? ' ' + kind : '');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => bannerEl.classList.remove('show'), 3400);
  }

  // ---------- Geometry helpers ----------
  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function bearingDeg(lat1, lon1, lat2, lon2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const toDeg = (r) => (r * 180) / Math.PI;
    const phi1 = toRad(lat1);
    const phi2 = toRad(lat2);
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  // ---------- Google Maps ----------
  function setupLiveMarkerOverlayClass() {
    LiveMarkerOverlay.prototype = Object.create(google.maps.OverlayView.prototype);
    LiveMarkerOverlay.prototype.onAdd = function () {
      this.getPanes().overlayMouseTarget.appendChild(this.el);
    };
    LiveMarkerOverlay.prototype.draw = function () {
      if (this.pendingLatLng) this.setLatLng(this.pendingLatLng);
    };
    LiveMarkerOverlay.prototype.setLatLng = function (latLng) {
      this.pendingLatLng = latLng;
      const proj = this.getProjection();
      if (!proj) return;
      const point = proj.fromLatLngToDivPixel(new google.maps.LatLng(latLng.lat, latLng.lng));
      if (point) {
        this.el.style.left = point.x + 'px';
        this.el.style.top = point.y + 'px';
      }
    };
    LiveMarkerOverlay.prototype.onRemove = function () {};
  }

  function setupBubbleOverlayClass() {
    BubbleOverlay.prototype = Object.create(google.maps.OverlayView.prototype);
    BubbleOverlay.prototype.onAdd = function () {
      this.div = document.createElement('div');
      this.div.className = 'gm-bubble';
      this.div.textContent = this.text;
      this.getPanes().overlayMouseTarget.appendChild(this.div);
    };
    BubbleOverlay.prototype.draw = function () {
      const proj = this.getProjection();
      if (!proj || !this.div) return;
      const point = proj.fromLatLngToDivPixel(new google.maps.LatLng(this.position.lat, this.position.lng));
      if (point) {
        this.div.style.left = point.x + 'px';
        this.div.style.top = point.y - 20 + 'px';
      }
    };
    BubbleOverlay.prototype.onRemove = function () {
      if (this.div && this.div.parentNode) this.div.parentNode.removeChild(this.div);
      this.div = null;
    };
  }

  function LiveMarkerOverlay(el) {
    google.maps.OverlayView.call(this);
    this.el = el;
    this.pendingLatLng = null;
  }

  window.initMap = function initMap() {
    setupBubbleOverlayClass();
    setupLiveMarkerOverlayClass();

    const initialCenter = currentLatLng || FALLBACK_ANCHOR;
    map = new google.maps.Map(mapEl, {
      center: initialCenter,
      zoom: 21,
      mapTypeId: 'roadmap',
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: 'none',
      clickableIcons: false,
    });
    mapReady = true;
    if (usingLiveLocation) mapCentered = true; // already a real fix, lock it in

    liveMarkerOverlay = new LiveMarkerOverlay(liveMarkerEl);
    liveMarkerOverlay.setMap(map);
    liveMarkerOverlay.setLatLng(initialCenter);

    // The map is static from here on — it is sized/centered once and never
    // panned or re-centered again; only the live marker overlay moves.
    const fixSize = () => google.maps.event.trigger(map, 'resize');
    requestAnimationFrame(fixSize);
    setTimeout(fixSize, 300);
  };

  function updateHeadingDisplay() {
    const heading = usingLiveHeading ? lastHeading : lastMovementHeading;
    coneGroup.setAttribute('transform', `rotate(${heading.toFixed(1)})`);
  }

  function updatePosition(lat, lng, isSim) {
    const prev = currentLatLng;
    currentLatLng = { lat, lng };
    if (!isSim) usingLiveLocation = true;

    if (mapReady) {
      // The map itself never pans/re-centers except once, the first time a
      // *real* GPS fix arrives (it may load after the map already rendered
      // at the fallback location). After that it stays completely static —
      // only the marker overlay below moves.
      if (!isSim && !mapCentered) {
        map.setCenter(currentLatLng);
        mapCentered = true;
      }
      liveMarkerOverlay.setLatLng(currentLatLng);
    }

    if (prev) {
      const dist = haversineMeters(prev.lat, prev.lng, lat, lng);
      if (dist > 0.4) {
        lastMovementHeading = bearingDeg(prev.lat, prev.lng, lat, lng);
        updateHeadingDisplay();
      }
    }
  }

  // ---------- Location / motion tracking ----------
  function onPosition(pos) {
    if (simTimer) { clearInterval(simTimer); simTimer = null; }
    if (!usingLiveLocation) showBanner('Live location tracking active — walk around your home', 'ok');
    updatePosition(pos.coords.latitude, pos.coords.longitude, false);
  }

  function onPositionError() {
    if (!usingLiveLocation) {
      showBanner('Simulated walking — location unavailable', 'warn');
      startSimulatedWalk();
    }
  }

  function startSimulatedWalk() {
    if (simTimer || usingLiveLocation) return;
    const t0 = performance.now();
    simTimer = setInterval(() => {
      if (usingLiveLocation) { clearInterval(simTimer); simTimer = null; return; }
      const t = (performance.now() - t0) / 1000;
      const dxM = Math.sin(t * 0.31) * 3 + Math.sin(t * 0.13) * 1.5;
      const dyM = Math.cos(t * 0.24) * 3 + Math.sin(t * 0.09) * 1.2;
      const lat = FALLBACK_ANCHOR.lat + dyM / 110540;
      const lng = FALLBACK_ANCHOR.lng + dxM / (111320 * Math.cos((FALLBACK_ANCHOR.lat * Math.PI) / 180));
      updatePosition(lat, lng, true);
    }, 900);
  }

  function onOrientation(e) {
    let heading = null;
    if (typeof e.webkitCompassHeading === 'number') {
      heading = e.webkitCompassHeading;
    } else if (e.absolute && e.alpha !== null) {
      heading = 360 - e.alpha;
    }
    if (heading !== null && !Number.isNaN(heading)) {
      usingLiveHeading = true;
      lastHeading = heading;
      updateHeadingDisplay();
    }
  }

  function requestOrientationPermissionIfNeeded() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().catch(() => {});
    }
  }

  function ensureTrackingStarted() {
    if (trackingStarted) return;
    trackingStarted = true;
    requestOrientationPermissionIfNeeded();

    window.addEventListener('deviceorientation', onOrientation);
    window.addEventListener('deviceorientationabsolute', onOrientation);

    if (!('geolocation' in navigator) || !window.isSecureContext) {
      showBanner('Simulated walking — location unavailable', 'warn');
      startSimulatedWalk();
      return;
    }
    navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 8000,
    });
    setTimeout(() => {
      if (!usingLiveLocation) {
        showBanner('Simulated walking — location unavailable', 'warn');
        startSimulatedWalk();
      }
    }, 4000);
  }

  // ---------- Badges (real map markers) ----------
  function clearBadges() {
    spotMarkers.forEach((m) => m.setMap(null));
    spotMarkers = [];
  }

  function svgDataUri(svg) {
    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
  }

  function checkIcon() {
    const svg = `<svg xmlns="${SVG_NS}" width="28" height="28" viewBox="0 0 28 28">
      <circle cx="14" cy="14" r="13" fill="#ffffff" stroke="rgba(0,0,0,0.15)"/>
      <path d="M9,14.3 L12.3,17.6 L19,10.6" stroke="#6f7171" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    return { url: svgDataUri(svg), scaledSize: new google.maps.Size(28, 28), anchor: new google.maps.Point(14, 14) };
  }

  function resultIcon() {
    const svg = `<svg xmlns="${SVG_NS}" width="28" height="28" viewBox="0 0 28 28">
      <circle cx="14" cy="14" r="13" fill="#00b845"/>
      <rect x="8" y="15" width="3" height="6" rx="1" fill="#fff"/>
      <rect x="12.5" y="11" width="3" height="10" rx="1" fill="#fff"/>
      <rect x="17" y="7" width="3" height="14" rx="1" fill="#fff"/>
    </svg>`;
    return { url: svgDataUri(svg), scaledSize: new google.maps.Size(28, 28), anchor: new google.maps.Point(14, 14) };
  }

  function addCheckBadge(pos) {
    spotMarkers.push(new google.maps.Marker({ position: pos, map, icon: checkIcon(), zIndex: 10, clickable: false }));
  }

  function addResultBadge(pos) {
    return new google.maps.Marker({ position: pos, map, icon: resultIcon(), zIndex: 10, clickable: false });
  }

  // ---------- Bubble overlay ("This is the best spot") ----------
  function BubbleOverlay(position, text) {
    google.maps.OverlayView.call(this);
    this.position = position;
    this.text = text;
    this.div = null;
  }
  function showTooltipAt(pos) {
    hideTooltip();
    bubbleOverlay = new BubbleOverlay(pos, 'This is the best spot');
    bubbleOverlay.setMap(map);
  }
  function hideTooltip() {
    if (bubbleOverlay) { bubbleOverlay.setMap(null); bubbleOverlay = null; }
  }

  // ---------- UI state rendering ----------
  const COPY = [
    {
      title: 'We are checking 3 spots, to find the best spot to place your router',
      subtitle: 'Walk to the first potential spot, when you get there, press “Check this spot”',
      button: 'Check this spot',
    },
    {
      title: 'Great, first spot is done!',
      subtitle: 'Now, walk to another room to check the second spot',
      button: 'Check this spot',
    },
    {
      title: 'Great, Second spot is done!',
      subtitle: 'Now, walk to another room to check the third spot',
      button: 'Check this spot',
    },
    {
      title: 'Great, Third spot is done!',
      subtitle: 'Tap on “Get results” to see which spot is the best for your router',
      button: 'Get results',
    },
  ];
  const RESULTS_COPY = {
    title: 'Here are the results, the spot with most bars is the best location',
    subtitle: 'Tap on “Continue to set router” to follow with the next steps',
    button: 'Continue to set router',
  };

  function updateStepper() {
    steps.forEach((step) => {
      const idx = Number(step.dataset.step);
      const done = idx < 3 ? idx < spotsDone : resultsShown;
      step.classList.toggle('completed', done);
    });
  }

  function renderPanel() {
    if (resultsShown) {
      panelTitle.textContent = RESULTS_COPY.title;
      panelSubtitle.textContent = RESULTS_COPY.subtitle;
      ctaBtn.textContent = RESULTS_COPY.button;
      ctaBtn.disabled = false;
      return;
    }
    if (locating) {
      panelTitle.textContent = '';
      panelSubtitle.textContent = '';
      return;
    }
    const c = COPY[spotsDone];
    panelTitle.textContent = c.title;
    panelSubtitle.textContent = c.subtitle;
    ctaBtn.textContent = c.button;
  }

  // ---------- Flow control ----------
  function startLocating() {
    locating = true;
    ctaBtn.disabled = true;
    pulseEl.classList.add('active');
    renderPanel();
    setTimeout(confirmSpot, 1600);
  }

  function confirmSpot() {
    locating = false;
    pulseEl.classList.remove('active');
    const pos = currentLatLng ? { ...currentLatLng } : { ...FALLBACK_ANCHOR };
    spotPositions[spotsDone] = pos;
    addCheckBadge(pos);
    spotsDone += 1;
    ctaBtn.disabled = false;
    updateStepper();
    renderPanel();
  }

  function showResults() {
    resultsShown = true;
    clearBadges();
    const winner = Math.floor(Math.random() * spotPositions.length);
    spotPositions.forEach((p) => addResultBadge(p));
    showTooltipAt(spotPositions[winner]);
    locoffEl.classList.remove('hidden');
    liveMarkerEl.classList.add('hidden');
    updateStepper();
    renderPanel();
  }

  function resetDemo() {
    spotsDone = 0;
    locating = false;
    resultsShown = false;
    spotPositions = [];
    clearBadges();
    hideTooltip();
    locoffEl.classList.add('hidden');
    liveMarkerEl.classList.remove('hidden');
    ctaBtn.disabled = false;
    updateStepper();
    renderPanel();
  }

  ctaBtn.addEventListener('click', () => {
    ensureTrackingStarted();
    if (resultsShown) {
      showBanner('Continuing to router setup — restarting demo…', 'ok');
      setTimeout(resetDemo, 1500);
      return;
    }
    if (locating) return;
    if (spotsDone < 3) startLocating();
    else showResults();
  });

  backBtn.addEventListener('click', () => {
    if (resultsShown || spotsDone > 0) resetDemo();
  });
  chatBtn.addEventListener('click', () => {
    showBanner('Chat support is not part of this demo', 'warn');
  });

  // ---------- init ----------
  updateStepper();
  renderPanel();
  ensureTrackingStarted();
})();
