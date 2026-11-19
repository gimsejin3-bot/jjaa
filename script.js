(() => {
  "use strict";

  const data = window.JOURNEY_ARCHIVE_DATA;
  if (!data) return;

  const $ = (selector, root = document) => root.querySelector(selector);
  const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const safeURL = (value) => /^https:\/\//i.test(value || "") ? escapeHTML(value) : "#";
  const mapSearchURL = (query) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

  const countryList = $("#country-list");
  const countryDetails = $("#country-details");
  const accordionHost = $("#country-accordions");
  const mapElement = $("#travel-map");
  const mapViewport = $(".map-viewport");
  const mapFallbackMessage = $("#map-fallback-message");
  const mapOpenLink = $("#open-google-map");
  const mapStatus = $("#map-status");
  const mapCaption = $("#map-caption");
  const safetyCountryList = $("#safety-country-list");
  const searchForm = $("#destination-search");
  const searchInput = $("#destination-query");
  const searchResults = $("#destination-results");
  const searchFeedback = $("#search-feedback");
  const searchRouteGeneration = $("#route-generation-action");
  let selectedCountryId = null;
  let searchIndex = [];
  let currentSearchMatches = [];
  let lastActivatedSearch = "";
  let mapInstance = null;
  let mapProvider = "none";
  let countryMarkers = [];
  let routeMarkers = [];
  let routePolyline = null;
  let activeInfoWindow = null;
  let hoverInfoWindow = null;
  let pinnedInfoSpot = null;
  let selectedRouteId = null;
  let pendingRouteId = null;
  let pendingSpotOrder = null;

  const countries = data.countries || [];
  const routes = data.routes || [];
  const countryById = new Map(countries.map((country) => [country.id, country]));
  const externalSafetyNewsByCountryCode = new Map();
  let safetyNewsReady = Promise.resolve();

  function googleDirectionsURL(route) {
    const country = countryById.get(route.countryId);
    const spots = route.routeSpots || [];
    if (!spots.length) return mapSearchURL(`${route.title} ${country?.name || ""}`);
    const placeName = (spot) => `${spot.name} ${country?.name || ""}`.trim();
    const params = new URLSearchParams({
      api: "1",
      origin: placeName(spots[0]),
      destination: placeName(spots[spots.length - 1]),
      travelmode: "walking"
    });
    if (spots.length > 2) params.set("waypoints", spots.slice(1, -1).map(placeName).join("|"));
    return `https://www.google.com/maps/dir/?${params.toString()}`;
  }

  const photoCache = new Map();
  const photoRequests = new Map();
  const placesPhotoCache = new Map();
  const placesPhotoRequests = new Map();
  let hoverSpot = null;
  let lastHoverSpot = null;
  let lastHoverMarker = null;
  let routeCoverObserver = null;

  function photoCacheKey(spot, country) {
    return `${country?.id || "unknown"}:${spot.order}:${spot.name}:${spot.lat},${spot.lng}`.toLocaleLowerCase();
  }

  function commonsSearchQuery(spot, country) {
    return String(spot.photoQuery || `${spot.name || ""} ${spot.city || ""} ${country?.name || ""}`).trim();
  }

  function placesSearchQuery(spot, country) {
    const name = String(spot.name || "");
    const typeHints = [
      [/카날|운하/i, "canal"], [/광장/i, "square"], [/지구/i, "neighborhood"],
      [/미술관/i, "art museum"], [/박물관/i, "museum"], [/대성당|성당/i, "cathedral"],
      [/궁전/i, "palace"], [/사원|절/i, "temple"], [/성|성채/i, "castle"],
      [/다리/i, "bridge"], [/공원/i, "park"], [/정원/i, "garden"],
      [/시장/i, "market"], [/폭포/i, "waterfall"], [/기념관/i, "memorial"]
    ];
    const hint = typeHints.find(([pattern]) => pattern.test(name))?.[1] || "";
    return [name, hint, spot.photoQuery, spot.city, country?.name].filter(Boolean).join(", ");
  }

  function fetchCommonsPhoto(spot, country) {
    const query = commonsSearchQuery(spot, country);
    if (!query) return Promise.resolve(null);
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=1&prop=imageinfo&iiprop=url&iiurlwidth=400&format=json&origin=*`;
    return fetch(url).then((response) => response.json()).then((payload) => {
      const pages = payload?.query?.pages ? Object.values(payload.query.pages) : [];
      const page = pages[0];
      const image = page?.imageinfo?.[0]?.thumburl;
      return image ? { url: image, attribution: "Wikimedia Commons", attributionUrl: page.fullurl || "https://commons.wikimedia.org/" } : null;
    }).catch(() => null);
  }

  async function fetchGooglePhotoMedia(photo, key = data.mapConfig?.placesApiKey) {
    const photoName = typeof photo === "string" ? photo : photo?.name;
    if (!key || !photoName) return null;
    try {
      const response = await fetch(`https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=400&skipHttpRedirect=true&key=${encodeURIComponent(key)}`);
      if (!response.ok) return null;
      const media = await response.json();
      const authors = (photo?.authorAttributions || []).map((author) => ({
        name: author.displayName || "",
        url: author.uri || "https://maps.google.com/"
      }));
      return media.photoUri ? {
        url: media.photoUri,
        provider: "places",
        googlePhotoName: photoName,
        attributions: authors.length ? authors : [{ name: "Google Maps", url: "https://maps.google.com/" }]
      } : null;
    } catch (error) {
      return null;
    }
  }

  async function fetchGooglePlacePhoto(spot, country) {
    const key = data.mapConfig?.placesApiKey;
    if (!key) return null;
    try {
      const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "places.displayName,places.primaryType,places.photos.name,places.photos.authorAttributions.displayName,places.photos.authorAttributions.uri,places.location"
        },
        body: JSON.stringify({
          textQuery: placesSearchQuery(spot, country),
          maxResultCount: 10,
          rankPreference: "DISTANCE",
          locationBias: { circle: { center: { latitude: spot.lat, longitude: spot.lng }, radius: 1200 } }
        })
      });
      if (!response.ok) return null;
      const result = await response.json();
      const distanceFromSpot = (place) => {
        if (!place.location) return Infinity;
        const radians = (degrees) => degrees * Math.PI / 180;
        const dLat = radians(place.location.latitude - spot.lat);
        const dLng = radians(place.location.longitude - spot.lng);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(spot.lat)) * Math.cos(radians(place.location.latitude)) * Math.sin(dLng / 2) ** 2;
        return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };
      const nonLandmarkTypes = new Set(["hotel", "lodging", "hostel", "motel", "bed_and_breakfast", "resort_hotel"]);
      const place = (result.places || [])
        .filter((candidate) => candidate.photos?.length && !nonLandmarkTypes.has(candidate.primaryType) && distanceFromSpot(candidate) <= 1500)
        .sort((a, b) => distanceFromSpot(a) - distanceFromSpot(b))[0];
      const photo = place?.photos?.[0];
      if (!photo?.name) return null;
      return fetchGooglePhotoMedia(photo, key);
    } catch (error) {
      return null;
    }
  }

  function getGooglePlacePhotoCached(spot, country) {
    const key = photoCacheKey(spot, country);
    if (placesPhotoCache.has(key)) return Promise.resolve(placesPhotoCache.get(key));
    if (placesPhotoRequests.has(key)) return placesPhotoRequests.get(key);
    const storedPhoto = spot.googlePhotoName
      ? { name: spot.googlePhotoName, authorAttributions: (spot.photoAttributions || []).map((item) => ({ displayName: item.name, uri: item.url })) }
      : null;
    const request = (storedPhoto ? fetchGooglePhotoMedia(storedPhoto) : Promise.resolve(null))
      .then((photo) => photo || fetchGooglePlacePhoto(spot, country)).then((photo) => {
      placesPhotoCache.set(key, photo || null);
      placesPhotoRequests.delete(key);
      return photo || null;
    }).catch(() => {
      placesPhotoCache.set(key, null);
      placesPhotoRequests.delete(key);
      return null;
    });
    placesPhotoRequests.set(key, request);
    return request;
  }

  function getSpotPhoto(spot, country) {
    const key = photoCacheKey(spot, country);
    if (photoCache.has(key)) return Promise.resolve(photoCache.get(key));
    if (photoRequests.has(key)) return photoRequests.get(key);
    const request = getGooglePlacePhotoCached(spot, country)
      .then((photo) => photo || fetchCommonsPhoto(spot, country))
      .then((photo) => {
        photoCache.set(key, photo || null);
        photoRequests.delete(key);
        return photo || null;
      })
      .catch(() => {
        photoCache.set(key, null);
        photoRequests.delete(key);
        return null;
      });
    photoRequests.set(key, request);
    return request;
  }

  function loadRouteCover(frame, country) {
    const route = routes.find((item) => item.id === frame.dataset.routeCoverFrame);
    const spot = route?.routeSpots?.[0];
    const image = frame.querySelector("[data-route-cover-image]");
    if (!spot || !image || frame.dataset.photoRequested === "true") return;
    frame.dataset.photoRequested = "true";
    getGooglePlacePhotoCached(spot, country).then((photo) => {
      if (!image.isConnected) return;
      if (!photo) {
        const message = frame.querySelector("[data-route-cover-fallback] small");
        if (message) message.textContent = "정확한 장소 사진을 찾지 못했어요";
        return;
      }
      image.src = photo.url;
      image.hidden = false;
      frame.querySelector("[data-route-cover-fallback]")?.setAttribute("hidden", "");
      const credit = frame.querySelector("[data-route-cover-credit]");
      if (credit) {
        credit.innerHTML = photo.attributions.map((item) =>
          `<a href="${safeURL(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(item.name || "Photo credit")}</a>`
        ).join(" · ");
        credit.hidden = !photo.attributions.length;
      }
    });
  }

  function loadRouteCardPhotos(country) {
    routeCoverObserver?.disconnect();
    const frames = accordionHost.querySelectorAll("[data-route-cover-frame]");
    if (typeof IntersectionObserver === "undefined") {
      frames.forEach((frame) => loadRouteCover(frame, country));
      return;
    }
    routeCoverObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        loadRouteCover(entry.target, country);
      });
    }, { rootMargin: "120px 0px" });
    frames.forEach((frame) => routeCoverObserver.observe(frame));
  }

  function updateSpotCard(spot, country) {
    const key = photoCacheKey(spot, country);
    if (!photoCache.has(key)) return;
    const markup = mapInfoMarkup(spot, photoCache.get(key));
    if ((hoverSpot === spot || lastHoverSpot === spot) && mapProvider === "google" && hoverInfoWindow?.getMap()) hoverInfoWindow.setContent(markup);
    if (pinnedInfoSpot === spot && mapProvider === "google" && activeInfoWindow) activeInfoWindow.setContent(markup);
    const entry = routeMarkers.find((item) => item.spot === spot);
    if (!entry) return;
    if (mapProvider === "leaflet" && entry.marker.getTooltip()) entry.marker.setTooltipContent(markup);
    if (mapProvider === "leaflet" && entry.marker.isPopupOpen()) entry.marker.setPopupContent(markup);
  }

  function refreshSpotPhoto(spot, country) {
    getSpotPhoto(spot, country).then((url) => {
      if (url) updateSpotCard(spot, country);
    });
  }

  function mapInfoMarkup(spot, placePhotoUrl = null) {
    const cached = placePhotoUrl || photoCache.get(photoCacheKey(spot, countryById.get(spot.countryId)));
    // Generic route photos are not presented as a specific landmark photo. Wait for Places/Commons,
    // unless the spot carries an explicitly user-verified image.
    const fallbackImage = spot.imageVerified ? spot.image : "";
    const image = safeURL(cached?.url || fallbackImage);
    const hasImage = image !== "#";
    const credits = cached?.attributions || spot.photoAttributions || (cached?.attribution ? [{ name: cached.attribution, url: cached.attributionUrl }] : []);
    const credit = credits.length
      ? `<div class="map-info-attribution">${credits.map((item) => `<a href="${safeURL(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(item.name || "Photo credit")}</a>`).join(" · ")}</div>`
      : "";
    const photo = `<div class="map-info-photo-frame">
      ${hasImage ? `<img class="map-info-photo" src="${image}" alt="${escapeHTML(spot.name)}" onerror="this.style.display='none';this.parentElement.querySelector('.map-info-photo-fallback').style.display='flex';this.parentElement.querySelector('.map-info-attribution')?.remove();">` : ""}
      <div class="map-info-photo-fallback" style="display:${hasImage ? "none" : "flex"}"><span aria-hidden="true">⌖</span><strong>${escapeHTML(spot.name)}</strong></div>
      ${credit}
    </div>`;
    return `<div class="map-info-window">
      ${photo}
      <div class="map-info-body">
        <span class="map-info-badge">SPOT ${String(spot.order).padStart(2, "0")}</span>
        <strong>${escapeHTML(spot.name)}</strong>
        <p>${escapeHTML(spot.desc || "여행 루트 스팟")}</p>
      </div>
    </div>`;
  }

  function openSpotHoverCard(spot, marker, country) {
    hoverSpot = spot;
    lastHoverSpot = spot;
    lastHoverMarker = marker;
    const photoUrl = photoCache.get(photoCacheKey(spot, country)) || null;
    if (mapProvider === "google") {
      if (!hoverInfoWindow) hoverInfoWindow = new google.maps.InfoWindow({ disableAutoPan: true });
      hoverInfoWindow.setContent(mapInfoMarkup(spot, photoUrl));
      hoverInfoWindow.open({ map: mapInstance, anchor: marker });
    } else if (mapProvider === "leaflet") {
      marker.bindTooltip(mapInfoMarkup(spot, photoUrl), {
        direction: "top",
        offset: [0, -18],
        opacity: 1,
        className: "spot-hover-tooltip",
        interactive: false
      });
      marker.openTooltip();
    }
    refreshSpotPhoto(spot, country);
  }

  function closeSpotHoverCard(marker) {
    hoverSpot = null;
    if (mapProvider === "google") {
      if (hoverInfoWindow) hoverInfoWindow.close();
    } else if (mapProvider === "leaflet") {
      marker.closeTooltip();
    }
    if (pinnedInfoSpot) {
      const pinned = routeMarkers.find((entry) => entry.spot === pinnedInfoSpot);
      if (!pinned) return;
      if (mapProvider === "google") {
        activeInfoWindow.setContent(mapInfoMarkup(pinnedInfoSpot, photoCache.get(photoCacheKey(pinnedInfoSpot, pinned.country)) || null));
        activeInfoWindow.open({ map: mapInstance, anchor: pinned.marker });
      } else if (mapProvider === "leaflet" && !pinned.marker.isPopupOpen()) {
        pinned.marker.openPopup();
      }
      refreshSpotPhoto(pinnedInfoSpot, pinned.country);
    }
  }

  function clearRouteLayers() {
    if (activeInfoWindow && mapProvider === "google") activeInfoWindow.close();
    if (mapProvider === "google") {
      routeMarkers.forEach(({ marker }) => marker.setMap(null));
      if (routePolyline) routePolyline.setMap(null);
    } else if (mapProvider === "leaflet" && mapInstance) {
      routeMarkers.forEach(({ marker }) => mapInstance.removeLayer(marker));
      if (routePolyline) mapInstance.removeLayer(routePolyline);
    }
    routeMarkers = [];
    routePolyline = null;
    activeInfoWindow = null;
    pinnedInfoSpot = null;
    if (hoverInfoWindow) hoverInfoWindow.close();
    selectedRouteId = null;
    updateOverviewVisibility(mapInstance ? mapInstance.getZoom() : 2);
    countryDetails.querySelectorAll(".route-step.is-active").forEach((step) => step.classList.remove("is-active"));
    countryDetails.querySelectorAll(".mini-route-card.is-active").forEach((card) => card.classList.remove("is-active"));
  }

  function setRouteSelection(routeId, spotOrder = null) {
    selectedRouteId = routeId;
    countryDetails.querySelectorAll("[data-route-card]").forEach((card) => {
      card.classList.toggle("is-active", card.dataset.routeCard === routeId);
    });
    countryDetails.querySelectorAll("[data-route-step]").forEach((step) => {
      const active = step.dataset.routeStep === routeId && Number(step.dataset.spotOrder) === Number(spotOrder);
      step.classList.toggle("is-active", active);
      if (active) step.setAttribute("aria-current", "step");
      else step.removeAttribute("aria-current");
    });
    routeMarkers.forEach(({ marker, spot }) => {
      const active = routeId === selectedRouteId && Number(spot.order) === Number(spotOrder);
      if (mapProvider === "google") {
        marker.setIcon(googleRouteIcon(spot.order, active));
        marker.setZIndex(active ? 1000 : undefined);
      } else if (mapProvider === "leaflet") {
        marker.getElement()?.querySelector(".map-route-pin")?.classList.toggle("is-active", active);
      }
    });
  }

  function googleRouteIcon(order, active = false) {
    return {
      path: google.maps.SymbolPath.CIRCLE,
      scale: active ? 17 : 14,
      fillColor: active ? "#0075de" : "#ff385c",
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeWeight: 3,
      labelOrigin: new google.maps.Point(0, 0)
    };
  }

  function focusRouteSpot(routeId, order) {
    const markerEntry = routeMarkers.find(({ spot }) => Number(spot.order) === Number(order));
    if (!markerEntry || selectedRouteId !== routeId) return;
    setRouteSelection(routeId, order);
    const { marker, spot } = markerEntry;
    if (mapProvider === "google") {
      mapInstance.panTo({ lat: spot.lat, lng: spot.lng });
      if (mapInstance.getZoom() < 15) mapInstance.setZoom(15);
      marker.setAnimation(google.maps.Animation.BOUNCE);
      window.setTimeout(() => marker.setAnimation(null), 700);
    } else if (mapProvider === "leaflet") {
      mapInstance.flyTo([spot.lat, spot.lng], Math.max(mapInstance.getZoom(), 15), { duration: .7 });
      marker.openPopup();
    }
  }

  function drawRouteOnMap(routeId, { focusOrder = null } = {}) {
    const route = routes.find((item) => item.id === routeId);
    if (!route) return;
    const country = countryById.get(route.countryId);
    pendingRouteId = routeId;
    pendingSpotOrder = focusOrder;
    if (!mapInstance) return;
    const spots = route.routeSpots || [];
    if (!spots.length) return;
    const routePath = route.coordinates?.length
      ? route.coordinates.map(([lat, lng]) => ({ lat, lng }))
      : spots.map((spot) => ({ lat: spot.lat, lng: spot.lng }));
    clearRouteLayers();
    selectedRouteId = routeId;

    if (mapProvider === "google") {
      routePolyline = new google.maps.Polyline({
        path: routePath,
        geodesic: true,
        strokeColor: "#ff385c",
        strokeOpacity: .94,
        strokeWeight: 4,
        map: mapInstance
      });
      activeInfoWindow = new google.maps.InfoWindow();
      routeMarkers = spots.map((spot) => {
        const marker = new google.maps.Marker({
          position: { lat: spot.lat, lng: spot.lng },
          map: mapInstance,
          title: `${spot.order}. ${spot.name}`,
          icon: googleRouteIcon(spot.order),
          label: { text: String(spot.order), color: "#ffffff", fontSize: "11px", fontWeight: "700" },
          optimized: true
        });
        marker.addListener("mouseover", () => openSpotHoverCard(spot, marker, country));
        marker.addListener("mouseout", () => closeSpotHoverCard(marker));
        marker.addListener("click", () => {
          if (pinnedInfoSpot === spot) {
            activeInfoWindow.close();
            pinnedInfoSpot = null;
          } else {
            pinnedInfoSpot = spot;
            activeInfoWindow.setContent(mapInfoMarkup(spot, photoCache.get(photoCacheKey(spot, country)) || null));
            activeInfoWindow.open({ map: mapInstance, anchor: marker });
            refreshSpotPhoto(spot, country);
          }
          setRouteSelection(routeId, spot.order);
        });
        return { marker, spot, country };
      });
      if (focusOrder) {
        const focused = spots.find((spot) => Number(spot.order) === Number(focusOrder));
        if (focused) {
          mapInstance.panTo({ lat: focused.lat, lng: focused.lng });
          mapInstance.setZoom(15);
        }
      } else if (spots.length === 1) {
        mapInstance.setCenter(routePath[0]);
        mapInstance.setZoom(15);
      } else {
        const bounds = new google.maps.LatLngBounds();
        routePath.forEach((point) => bounds.extend(point));
        mapInstance.fitBounds(bounds, { top: 76, right: 76, bottom: 76, left: 76 });
        google.maps.event.addListenerOnce(mapInstance, "idle", () => {
          if (mapInstance.getZoom() > 16) mapInstance.setZoom(16);
        });
      }
    } else if (mapProvider === "leaflet") {
      const path = routePath.map((point) => [point.lat, point.lng]);
      routePolyline = L.polyline(path, {
        color: "#ff385c",
        weight: 4,
        opacity: .94,
        lineCap: "round",
        lineJoin: "round"
      }).addTo(mapInstance);
      routeMarkers = spots.map((spot) => {
        const icon = L.divIcon({
          className: "map-route-marker-wrap",
          html: `<span class="map-route-pin" data-map-route-pin="${escapeHTML(routeId)}" data-map-spot-order="${escapeHTML(spot.order)}"><span>${escapeHTML(spot.order)}</span></span>`,
          iconSize: [38, 38],
          iconAnchor: [19, 19]
        });
        const marker = L.marker([spot.lat, spot.lng], { icon, title: `${spot.order}. ${spot.name}`, keyboard: true }).addTo(mapInstance);
        marker.bindPopup(mapInfoMarkup(spot, photoCache.get(photoCacheKey(spot, country)) || null), { closeButton: true, maxWidth: 220, className: "spot-pinned-popup" });
        marker.on("mouseover", () => openSpotHoverCard(spot, marker, country));
        marker.on("mouseout", () => closeSpotHoverCard(marker));
        marker.on("click", () => {
          pinnedInfoSpot = pinnedInfoSpot === spot ? null : spot;
          setRouteSelection(routeId, spot.order);
          refreshSpotPhoto(spot, country);
        });
        return { marker, spot, country };
      });
      if (focusOrder) {
        focusRouteSpot(routeId, focusOrder);
      } else if (spots.length === 1) {
        mapInstance.flyTo(path[0], 15, { duration: .7 });
      } else {
        mapInstance.flyToBounds(routePolyline.getBounds(), { padding: [72, 72], maxZoom: 15, duration: 1, animate: true });
      }
    }
    setRouteSelection(routeId, focusOrder);
    pendingSpotOrder = null;
  }

  function selectRouteOnMap(routeId, spotOrder = null) {
    const route = routes.find((item) => item.id === routeId);
    if (!route) return;
    if (selectedCountryId !== route.countryId) {
      selectCountry(route.countryId, { toggle: false, openBoth: true, routeId, focusSpotOrder: spotOrder, scroll: false });
    } else if (selectedRouteId === routeId && spotOrder) {
      focusRouteSpot(routeId, spotOrder);
    } else {
      drawRouteOnMap(routeId, { focusOrder: spotOrder });
    }
    mapViewport.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  let overviewDots = [];
  let overviewLines = [];

  function addCountryMarkers() {
    // No country pins: show curated city waypoints as a subtle world-wide network instead.
    countryMarkers = [];
    clearOverviewNetwork();
    const seen = new Map();
    routes.forEach((route) => {
      (route.routeSpots || []).forEach((spot) => {
        const key = `${spot.lat.toFixed(2)},${spot.lng.toFixed(2)}`;
        if (!seen.has(key)) seen.set(key, { spot, countryId: route.countryId, routeId: route.id });
      });
    });
    const spots = [...seen.values()];

    if (mapProvider === "google") {
      spots.forEach(({ spot, countryId, routeId }) => {
        const dot = new google.maps.Marker({
          position: { lat: spot.lat, lng: spot.lng },
          map: mapInstance,
          title: `${spot.name} · 여행 루트 보기`,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 5,
            fillColor: "#ff385c",
            fillOpacity: .85,
            strokeColor: "#ffffff",
            strokeWeight: 1.5
          },
          optimized: true
        });
        dot.addListener("click", () => selectCountry(countryId, { toggle: false, routeId }));
        overviewDots.push(dot);
      });
      routes.forEach((route) => {
        const path = (route.routeSpots || []).map((spot) => ({ lat: spot.lat, lng: spot.lng }));
        if (path.length < 2) return;
        overviewLines.push(new google.maps.Polyline({
          path,
          map: mapInstance,
          strokeColor: "#0075de",
          strokeOpacity: .28,
          strokeWeight: 2,
          icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, scale: 2 }, offset: "0", repeat: "12px" }],
          clickable: false
        }));
      });
      updateOverviewVisibility(mapInstance.getZoom());
      mapInstance.addListener("zoom_changed", () => updateOverviewVisibility(mapInstance.getZoom()));
    } else if (mapProvider === "leaflet") {
      spots.forEach(({ spot, countryId, routeId }) => {
        const icon = L.divIcon({
          className: "map-overview-dot-wrap",
          html: '<span class="map-overview-dot"></span>',
          iconSize: [12, 12],
          iconAnchor: [6, 6]
        });
        const marker = L.marker([spot.lat, spot.lng], { icon, title: `${spot.name} · 여행 루트 보기`, keyboard: true }).addTo(mapInstance);
        marker.on("click", () => selectCountry(countryId, { toggle: false, routeId }));
        overviewDots.push(marker);
      });
      routes.forEach((route) => {
        const path = (route.routeSpots || []).map((spot) => [spot.lat, spot.lng]);
        if (path.length < 2) return;
        overviewLines.push(L.polyline(path, {
          color: "#0075de",
          weight: 2,
          opacity: .3,
          dashArray: "4 8",
          interactive: false
        }).addTo(mapInstance));
      });
      const update = () => updateOverviewVisibility(mapInstance.getZoom());
      mapInstance.on("zoomend", update);
      update();
    }
  }

  function clearOverviewNetwork() {
    overviewDots.forEach((dot) => {
      if (mapProvider === "google") dot.setMap(null);
      else if (mapInstance) mapInstance.removeLayer(dot);
    });
    overviewLines.forEach((line) => {
      if (mapProvider === "google") line.setMap(null);
      else if (mapInstance) mapInstance.removeLayer(line);
    });
    overviewDots = [];
    overviewLines = [];
  }

  function updateOverviewVisibility(zoom) {
    const showDots = zoom >= 2 && !selectedCountryId;
    const showLines = zoom >= 5 && !selectedCountryId;
    if (mapProvider === "google") {
      overviewDots.forEach((dot) => dot.setVisible(showDots));
      overviewLines.forEach((line) => line.setVisible(showLines));
    } else if (mapProvider === "leaflet") {
      overviewDots.forEach((dot) => {
        if (showDots) { if (!mapInstance.hasLayer(dot)) dot.addTo(mapInstance); }
        else if (mapInstance.hasLayer(dot)) mapInstance.removeLayer(dot);
      });
      overviewLines.forEach((line) => {
        if (showLines) { if (!mapInstance.hasLayer(line)) line.addTo(mapInstance); }
        else if (mapInstance.hasLayer(line)) mapInstance.removeLayer(line);
      });
    }
  }

  function initGoogleMap() {
    if (mapInstance || !window.google?.maps) return;
    try {
      mapProvider = "google";
      mapInstance = new google.maps.Map(mapElement, {
        center: { lat: 18, lng: 10 },
        zoom: 2,
        minZoom: 2,
        maxZoom: 18,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        clickableIcons: false
      });
      activeInfoWindow = new google.maps.InfoWindow();
      mapViewport.classList.add("has-map");
      mapFallbackMessage.hidden = true;
      mapStatus.textContent = "WORLD MAP · GOOGLE MAPS";
      mapCaption.textContent = "Google Maps";
      addCountryMarkers();
      if (pendingRouteId) drawRouteOnMap(pendingRouteId, { focusOrder: pendingSpotOrder });
    } catch (error) {
      mapInstance = null;
      initLeafletMap();
    }
  }

  function initLeafletMap() {
    if (mapInstance || !window.L || !mapElement) {
      if (!mapInstance) mapFallbackMessage.hidden = false;
      return;
    }
    mapProvider = "leaflet";
    mapInstance = L.map(mapElement, { zoomControl: false, scrollWheelZoom: false, worldCopyJump: true, minZoom: 2, maxZoom: 18 }).setView([18, 10], 2);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>'
    }).addTo(mapInstance);
    L.control.zoom({ position: "bottomright" }).addTo(mapInstance);
    mapViewport.classList.add("has-map");
    mapFallbackMessage.hidden = true;
    mapStatus.textContent = "WORLD MAP · LEAFLET";
    mapCaption.textContent = "OpenStreetMap fallback";
    addCountryMarkers();
    if (pendingRouteId) drawRouteOnMap(pendingRouteId, { focusOrder: pendingSpotOrder });
  }

  function initializeMap() {
    const key = data.mapConfig?.googleMapsApiKey || window.JOURNEY_ARCHIVE_CONFIG?.googleMapsApiKey || "";
    if (!key) {
      initLeafletMap();
      return;
    }
    window.journeyArchiveMapReady = initGoogleMap;
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=journeyArchiveMapReady&v=weekly`;
    script.async = true;
    script.defer = true;
    script.onerror = initLeafletMap;
    document.head.appendChild(script);
    window.setTimeout(() => { if (!mapInstance) initLeafletMap(); }, 9000);
  }

  function resetMapToWorld() {
    clearRouteLayers();
    pendingRouteId = null;
    pendingSpotOrder = null;
    if (!mapInstance) return;
    if (mapProvider === "google") {
      mapInstance.panTo({ lat: 18, lng: 10 });
      mapInstance.setZoom(2);
    } else {
      mapInstance.flyTo([18, 10], 2, { duration: .8 });
    }
  }

  function flagImageURL(country) {
    return `https://flagcdn.com/w40/${encodeURIComponent(country.countryCode.toLowerCase())}.png`;
  }

  function normalizeSearchTerm(value) {
    return String(value ?? "").toLocaleLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]/gu, "");
  }

  function makeSearchIndex() {
    const countryAliases = {
      "united-kingdom": ["UK", "Britain", "Great Britain", "England"],
      "united-states": ["USA", "US", "U.S."],
      china: ["PRC", "중화인민공화국"],
      spain: ["España"]
    };
    const cityAliases = {
      spain: { Madrid: "마드리드", Barcelona: "바르셀로나" },
      portugal: { Lisbon: "리스본", Porto: "포르투" },
      china: { Beijing: "베이징", Shanghai: "상하이" },
      hungary: { Budapest: "부다페스트" },
      austria: { Vienna: "빈", Salzburg: "잘츠부르크" },
      finland: { Helsinki: "헬싱키", Rovaniemi: "로바니에미" },
      estonia: { Tallinn: "탈린" },
      germany: { Berlin: "베를린", Munich: "뮌헨" },
      "united-kingdom": { London: "런던", Edinburgh: "에든버러" },
      france: { Paris: "파리", Versailles: "베르사유", Lyon: "리옹" },
      cambodia: { "Phnom Penh": "프놈펜", "Siem Reap": "시엠립" },
      vietnam: { Hanoi: "하노이", "Ninh Bình": "닌빈", "Hội An": "호이안" },
      japan: { Tokyo: "도쿄", Kyoto: "교토" },
      italy: { Florence: "피렌체", Bologna: "볼로냐" },
      canada: { Toronto: "토론토", Vancouver: "밴쿠버" },
      "united-states": { "New York": "뉴욕", "San Francisco": "샌프란시스코" },
      mexico: { "Mexico City": "멕시코시티", Oaxaca: "오악사카" },
      peru: { Lima: "리마", Cusco: "쿠스코" },
      nepal: { Kathmandu: "카트만두", Pokhara: "포카라" },
      brazil: { "Rio de Janeiro": "리우데자네이루", "São Paulo": "상파울루" },
      chile: { Santiago: "산티아고", "San Pedro de Atacama": "산페드로 데 아타카마" },
      argentina: { "Buenos Aires": "부에노스아이레스", Iguazú: "이구아수" }
    };
    const index = [];

    countries.forEach((country) => {
      const aliases = countryAliases[country.id] || [];
      const travelTerms = [
        ...(country.travel?.food || []).flatMap((item) => [item.name, item.area]),
        ...(country.travel?.hotels || []).flatMap((item) => [item.name, item.area])
      ];
      index.push({
        kind: "country",
        countryId: country.id,
        label: country.localName,
        meta: `${country.name} · ${country.region} · ${country.count}개 큐레이션`,
        query: country.travel?.mapsQuery || country.name,
        zoom: country.zoom || 5,
        terms: [country.localName, country.name, country.region, ...aliases, ...travelTerms],
        exactTerms: [country.localName, country.name, ...aliases]
      });

      const cityIndex = new Map();
      routes.filter((route) => route.countryId === country.id).forEach((route) => {
        const city = route.location.split("·")[0].trim();
        const localizedCity = cityAliases[country.id]?.[city] || city;
        const key = normalizeSearchTerm(localizedCity);
        if (!cityIndex.has(key)) {
          cityIndex.set(key, {
          kind: "city",
          countryId: country.id,
          routeId: route.id,
          label: localizedCity,
            meta: `${country.localName} · ${route.title}`,
            query: `${city} ${country.name}`,
            zoom: 12,
            terms: [],
            exactTerms: [city, localizedCity]
          });
        }
        const candidate = cityIndex.get(key);
        candidate.terms.push(city, localizedCity, route.title, route.location, ...(route.stops || []));
      });
      index.push(...cityIndex.values());
    });
    return index;
  }

  function findSearchMatches(query) {
    const normalized = normalizeSearchTerm(query);
    if (!normalized) return [];
    return searchIndex.filter((candidate) => candidate.terms.some((term) => normalizeSearchTerm(term).includes(normalized)))
      .sort((a, b) => {
        const exactA = a.exactTerms.some((term) => normalizeSearchTerm(term) === normalized) ? 1 : 0;
        const exactB = b.exactTerms.some((term) => normalizeSearchTerm(term) === normalized) ? 1 : 0;
        if (exactA !== exactB) return exactB - exactA;
        if (a.kind !== b.kind) return a.kind === "country" ? -1 : 1;
        return a.label.localeCompare(b.label, "ko");
      });
  }

  function filterCountryCards(countryIds) {
    countryList.querySelectorAll("[data-country]").forEach((button) => {
      button.hidden = !countryIds.has(button.dataset.country);
      button.classList.remove("search-target");
    });
  }

  function hideSearchOptions() {
    searchResults.hidden = true;
    searchInput.setAttribute("aria-expanded", "false");
  }

  function showNoSearchResults() {
    searchResults.hidden = true;
    searchInput.setAttribute("aria-expanded", "false");
    searchFeedback.innerHTML = '<span aria-hidden="true">ⓘ</span><span>등록되지 않은 여행지입니다. 추후 업데이트 예정입니다.</span>';
    searchFeedback.hidden = false;
  }

  function hideRouteGenerationAction() {
    searchRouteGeneration.hidden = true;
    searchRouteGeneration.replaceChildren();
  }

  function routeGenerationButtonMarkup(query, className = "route-generation-button") {
    const value = String(query || "").trim();
    return `<button class="${className}" type="button" data-generate-route="${escapeHTML(value)}">${escapeHTML(value)} 맞춤 여행 루트 자동 생성하기 <span aria-hidden="true">✦</span></button>`;
  }

  function showRouteGenerationAction(query) {
    const value = String(query || "").trim();
    if (value.length < 2) {
      hideRouteGenerationAction();
      return;
    }
    searchRouteGeneration.innerHTML = routeGenerationButtonMarkup(value);
    searchRouteGeneration.hidden = false;
  }

  function chooseSearchResult(candidate) {
    lastActivatedSearch = normalizeSearchTerm(searchInput.value);
    searchFeedback.hidden = true;
    showRouteGenerationAction(searchInput.value);
    hideSearchOptions();
    filterCountryCards(new Set([candidate.countryId]));
    selectCountry(candidate.countryId, {
      toggle: false,
      openBoth: true,
      scroll: false,
      routeId: candidate.routeId || null,
      mapQuery: candidate.query,
      mapZoom: candidate.zoom,
      mapLabel: candidate.kind === "city" ? candidate.label : null
    });
    const card = countryList.querySelector(`[data-country="${candidate.countryId}"]`);
    if (card) {
      card.classList.add("search-target");
      card.focus({ preventScroll: true });
    }
    countryDetails.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function updateSearch() {
    const query = searchInput.value.trim();
    const normalized = normalizeSearchTerm(query);
    searchFeedback.hidden = true;
    if (!normalized) {
      currentSearchMatches = [];
      hideSearchOptions();
      hideRouteGenerationAction();
      filterCountryCards(new Set(countries.map((country) => country.id)));
      lastActivatedSearch = "";
      return;
    }

    if (selectedCountryId && normalized !== lastActivatedSearch) resetCountryView();
    currentSearchMatches = findSearchMatches(query);
    filterCountryCards(new Set(currentSearchMatches.map((candidate) => candidate.countryId)));

    if (!currentSearchMatches.length) {
      if ([...query].length >= 2) {
        showNoSearchResults();
        showRouteGenerationAction(query);
      } else hideSearchOptions();
      return;
    }

    const exact = currentSearchMatches.find((candidate) => candidate.exactTerms.some((term) => normalizeSearchTerm(term) === normalized));
    if (exact && normalized.length >= 2 && normalized !== lastActivatedSearch) {
      chooseSearchResult(exact);
      return;
    }

    hideRouteGenerationAction();
    searchResults.innerHTML = `${currentSearchMatches.slice(0, 7).map((candidate, index) => `
      <button class="search-result" type="button" role="option" aria-selected="false" data-search-result="${index}">
        <span class="search-result-icon" aria-hidden="true">${candidate.kind === "city" ? "⌖" : escapeHTML(countryById.get(candidate.countryId)?.flag || "🌍")}</span>
        <span class="search-result-copy"><strong>${escapeHTML(candidate.label)}</strong><small>${escapeHTML(candidate.meta)}</small></span>
        <span class="search-result-arrow" aria-hidden="true">↗</span>
      </button>`).join("")}${routeGenerationButtonMarkup(query, "search-generate-inline")}`;
    searchResults.hidden = false;
    searchInput.setAttribute("aria-expanded", "true");
  }

  function submitSearch() {
    if (!searchInput.value.trim()) {
      hideSearchOptions();
      searchFeedback.hidden = true;
      return;
    }
    const matches = findSearchMatches(searchInput.value);
    if (!matches.length) {
      showNoSearchResults();
      showRouteGenerationAction(searchInput.value);
      return;
    }
    const normalized = normalizeSearchTerm(searchInput.value);
    const exact = matches.find((candidate) => candidate.exactTerms.some((term) => normalizeSearchTerm(term) === normalized));
    chooseSearchResult(exact || matches[0]);
  }

  const ROUTE_PLACE_FIELDS = "places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.types,places.addressComponents,places.rating,places.userRatingCount,places.photos.name,places.photos.authorAttributions.displayName,places.photos.authorAttributions.uri";

  async function searchGooglePlacesForRoute(textQuery, { countryCode = "", center = null, radius = 25000, maxResultCount = 5 } = {}) {
    const key = data.mapConfig?.placesApiKey;
    if (!key || !String(textQuery || "").trim()) return [];
    const body = { textQuery: String(textQuery).trim(), maxResultCount };
    if (/^[a-z]{2}$/i.test(countryCode)) body.regionCode = countryCode.toUpperCase();
    if (center && Number.isFinite(Number(center[0])) && Number.isFinite(Number(center[1]))) {
      body.locationBias = {
        circle: {
          center: { latitude: Number(center[0]), longitude: Number(center[1]) },
          radius: Math.min(Math.max(Number(radius) || 25000, 1000), 50000)
        }
      };
    }
    try {
      const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": ROUTE_PLACE_FIELDS
        },
        body: JSON.stringify(body)
      });
      if (!response.ok) return [];
      const payload = await response.json();
      return Array.isArray(payload.places) ? payload.places : [];
    } catch (error) {
      return [];
    }
  }

  function routeDistanceMeters(a, b) {
    const radians = (value) => value * Math.PI / 180;
    const lat1 = Number(a.lat ?? a.latitude ?? a[0]);
    const lng1 = Number(a.lng ?? a.longitude ?? a[1]);
    const lat2 = Number(b.lat ?? b.latitude ?? b[0]);
    const lng2 = Number(b.lng ?? b.longitude ?? b[1]);
    const dLat = radians(lat2 - lat1);
    const dLng = radians(lng2 - lng1);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLng / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function orderRouteSpotsNearestNeighbor(spots, origin = null) {
    if (spots.length < 3) return spots.map((spot, index) => ({ ...spot, order: index + 1 }));
    const remaining = spots.map((spot, index) => ({ spot, index }));
    let current;
    if (origin) {
      const startIndex = remaining.reduce((best, item, index) =>
        routeDistanceMeters(item.spot, origin) < routeDistanceMeters(remaining[best].spot, origin) ? index : best, 0);
      current = remaining.splice(startIndex, 1)[0].spot;
    } else {
      current = remaining.shift().spot;
    }
    const ordered = [current];
    while (remaining.length) {
      const nextIndex = remaining.reduce((best, item, index) =>
        routeDistanceMeters(current, item.spot) < routeDistanceMeters(current, remaining[best].spot) ? index : best, 0);
      current = remaining.splice(nextIndex, 1)[0].spot;
      ordered.push(current);
    }
    return ordered.map((spot, index) => ({ ...spot, order: index + 1 }));
  }

  function placePopularityScore(place) {
    return (Number(place.rating) || 0) + Math.log10((Number(place.userRatingCount) || 0) + 1) * .2;
  }

  function findRouteTemplate(query) {
    const normalized = normalizeSearchTerm(query);
    return (data.autoRouteTemplates || []).flatMap((template) =>
      (template.aliases || []).map((alias) => ({ template, alias: normalizeSearchTerm(alias) }))
    ).filter(({ alias }) => alias && (alias === normalized || normalized.includes(alias)))
      .sort((a, b) => {
        const aCityMatch = normalized.includes(normalizeSearchTerm(a.template.location || "")) ? 1 : 0;
        const bCityMatch = normalized.includes(normalizeSearchTerm(b.template.location || "")) ? 1 : 0;
        return bCityMatch - aCityMatch || b.alias.length - a.alias.length;
      })[0]?.template || null;
  }

  function getCountryFromPlace(place) {
    const component = place?.addressComponents?.find((item) => item.types?.includes("country"));
    return component ? { code: String(component.shortText || "").toLowerCase(), name: component.longText || "" } : null;
  }

  function isGeographicRegionPlace(place) {
    const types = new Set([...(place?.types || []), place?.primaryType].filter(Boolean));
    return [
      "country", "locality", "postal_town", "administrative_area_level_1", "administrative_area_level_2",
      "administrative_area_level_3", "neighborhood", "sublocality", "sublocality_level_1", "colloquial_area"
    ].some((type) => types.has(type));
  }

  function isUnhelpfulRoutePlace(place) {
    const types = new Set([...(place.types || []), place.primaryType].filter(Boolean));
    return ["hotel", "lodging", "hostel", "motel", "bed_and_breakfast", "resort_hotel", "restaurant", "cafe", "bar", "food", "store", "shopping_mall"]
      .some((type) => types.has(type));
  }

  async function toGeneratedSpot(place, index, context, templateStop = null) {
    const location = place?.location;
    if (!location || !Number.isFinite(Number(location.latitude)) || !Number.isFinite(Number(location.longitude))) return null;
    const displayName = place.displayName?.text || templateStop?.name || `경유지 ${index + 1}`;
    const queryName = templateStop?.searchName || displayName;
    const sourcePhoto = place.photos?.[0] || null;
    const photo = sourcePhoto?.name ? await fetchGooglePhotoMedia(sourcePhoto) : null;
    const address = place.formattedAddress || "";
    const photoAttributions = photo?.attributions || sourcePhoto?.authorAttributions?.map((author) => ({
      name: author.displayName || "",
      url: author.uri || "https://maps.google.com/"
    })) || [];
    return {
      order: index + 1,
      name: templateStop?.name || displayName,
      lat: Number(location.latitude),
      lng: Number(location.longitude),
      address,
      rating: Number(place.rating) || null,
      userRatingCount: Number(place.userRatingCount) || 0,
      desc: `${templateStop?.desc || `${address || context.location}에 있는 검색된 명소입니다. 이동 순서와 운영 정보를 방문 전에 확인하세요.`}${address && templateStop?.desc ? ` 주소: ${address}` : ""}`,
      photoQuery: `${queryName}, ${context.location}, ${context.countryName}`,
      image: photo?.url || "",
      imageVerified: Boolean(photo?.url),
      googlePhotoName: photo?.googlePhotoName || sourcePhoto?.name || "",
      photoAttributions
    };
  }

  async function searchTemplateStops(template, context) {
    return Promise.all(template.stops.map(async (stop, index) => {
      let place = null;
      const results = await searchGooglePlacesForRoute(`${stop.searchName}, ${template.location}, ${template.countryName}`, {
        countryCode: context.countryCode,
        center: template.center,
        radius: 30000,
        maxResultCount: 5
      });
      const candidates = results.filter((item) => item.location && !isUnhelpfulRoutePlace(item));
      if (candidates.length) {
        place = candidates.sort((a, b) => routeDistanceMeters(a.location, template.stops[index]) - routeDistanceMeters(b.location, template.stops[index]))[0];
        if (routeDistanceMeters(place.location, stop) > 40000) place = null;
      }
      const chosen = place || { displayName: { text: stop.name }, location: { latitude: stop.lat, longitude: stop.lng } };
      return toGeneratedSpot(chosen, index, context, stop);
    })).then((spots) => spots.filter(Boolean));
  }

  async function searchGenericRoutePlaces(query, context) {
    const searches = [
      `top tourist attractions in ${query}`,
      `popular landmarks and historic sites in ${query}`,
      `museums and parks in ${query}`
    ];
    const resultSets = await Promise.all(searches.map((textQuery) => searchGooglePlacesForRoute(textQuery, {
      countryCode: context.countryCode,
      center: context.center,
      radius: 40000,
      maxResultCount: 6
    })));
    const seen = new Set();
    const places = resultSets.flat().filter((place) => {
      if (!place.location || isUnhelpfulRoutePlace(place)) return false;
      const key = place.id || `${normalizeSearchTerm(place.displayName?.text)}:${Number(place.location.latitude).toFixed(3)},${Number(place.location.longitude).toFixed(3)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => placePopularityScore(b) - placePopularityScore(a)).slice(0, 5);
    return places;
  }

  async function searchGeneratedRecommendations(type, context) {
    const noun = type === "food" ? "restaurants" : "hotels";
    const places = await searchGooglePlacesForRoute(`${noun} in ${context.location}, ${context.countryName}`, {
      countryCode: context.countryCode,
      center: context.center,
      radius: 25000,
      maxResultCount: 4
    });
    const matches = places.filter((place) => place.displayName?.text && place.location);
    if (!matches.length) {
      const food = type === "food";
      return [{
        name: `${context.location} ${food ? "현지 맛집" : "추천 숙소"} 검색`,
        area: context.location,
        detail: `${context.location} 주변 ${food ? "식당" : "숙소"} 후보를 Google 지도에서 확인하세요. 방문 전 운영 정보와 최근 후기를 확인하는 것을 권합니다.`,
        mapsQuery: `${food ? "restaurants" : "hotels"} in ${context.location}, ${context.countryName}`
      }];
    }
    const hasType = (place, patterns) => [...(place.types || []), place.primaryType].filter(Boolean)
      .some((placeType) => patterns.some((pattern) => placeType === pattern || placeType.includes(pattern)));
    const typedMatches = matches.filter((place) => type === "food"
      ? hasType(place, ["restaurant", "cafe", "bakery"])
      : hasType(place, ["lodging", "hotel", "hostel", "motel", "guest_house", "bed_and_breakfast", "resort_hotel"]));
    const typedSet = new Set(typedMatches);
    const rankedMatches = [
      ...typedMatches.sort((a, b) => placePopularityScore(b) - placePopularityScore(a)),
      ...matches.filter((place) => !typedSet.has(place)).sort((a, b) => placePopularityScore(b) - placePopularityScore(a))
    ].slice(0, 2);
    return rankedMatches.map((place) => ({
      name: place.displayName.text,
      area: place.formattedAddress || context.location,
      detail: `${place.formattedAddress || context.location}에서 검색된 ${type === "food" ? "음식점" : "숙소"} 후보입니다.${place.rating ? ` Google 평점 ${place.rating.toFixed(1)}${place.userRatingCount ? ` · 후기 ${place.userRatingCount.toLocaleString()}개` : ""}.` : ""} 운영 시간, 예약 및 최근 후기를 방문 전에 확인하세요.`,
      mapsQuery: `${place.displayName.text} ${context.countryName}`,
      rating: Number(place.rating) || null,
      userRatingCount: Number(place.userRatingCount) || 0
    }));
  }

  async function generateRouteByQuery(query) {
    const trimmedQuery = String(query || "").trim();
    if (trimmedQuery.length < 2) throw new Error("국가나 도시 이름을 두 글자 이상 입력해 주세요.");
    await Promise.all([ensureCountryCatalog(), safetyNewsReady]);

    const template = findRouteTemplate(trimmedQuery);
    const matches = findSearchMatches(trimmedQuery);
    const normalizedQuery = normalizeSearchTerm(trimmedQuery);
    const exactMatch = matches.find((candidate) => candidate.exactTerms.some((term) => normalizeSearchTerm(term) === normalizedQuery));
    const candidate = exactMatch || matches.find((item) => item.kind === "city") || matches[0] || null;
    const sourceRoute = template ? null : routes.find((route) => route.id === candidate?.routeId)
      || (candidate?.countryId ? countries.find((country) => country.id === candidate.countryId)?.routes?.[0] : null)
      || null;
    const sourceCountry = sourceRoute ? countryById.get(sourceRoute.countryId) : candidate?.countryId ? countryById.get(candidate.countryId) : null;

    let regionPlace = null;
    if (!template && !sourceRoute) {
      const regionCandidates = await searchGooglePlacesForRoute(trimmedQuery, { maxResultCount: 5 });
      regionPlace = regionCandidates.find(isGeographicRegionPlace) || null;
    }
    const placeCountry = getCountryFromPlace(regionPlace);
    let code = String(template?.countryCode || sourceCountry?.countryCode || placeCountry?.code || findCountryOption(trimmedQuery)?.code || "").toLowerCase();
    let catalogCountry = countryCatalog.find((record) => record.code === code);
    let countryName = template?.countryName || sourceCountry?.name || catalogCountry?.englishName || placeCountry?.name || trimmedQuery;
    let localName = template?.localName || sourceCountry?.localName || catalogCountry?.localName || countryName;
    let location = template?.location || (sourceRoute ? sourceRoute.location.split("·")[0].trim() : candidate?.kind === "city" ? candidate.label : regionPlace?.displayName?.text || trimmedQuery);
    let center = template?.center || (sourceRoute?.routeSpots?.length
      ? [sourceRoute.routeSpots[0].lat, sourceRoute.routeSpots[0].lng]
      : regionPlace?.location ? [regionPlace.location.latitude, regionPlace.location.longitude] : null);
    const context = { countryCode: code, countryName, localName, location, center };

    let spots;
    if (template) {
      spots = await searchTemplateStops(template, context);
      spots = orderRouteSpotsNearestNeighbor(spots, center);
    } else if (sourceRoute?.routeSpots?.length) {
      spots = sourceRoute.routeSpots.slice(0, 5).map((spot, index) => ({
        ...spot,
        order: index + 1,
        countryId: undefined,
        photoQuery: `${spot.name}, ${location}, ${countryName}`
      }));
    } else {
      const places = await searchGenericRoutePlaces(trimmedQuery, context);
      if (places.length < 2) throw new Error("Google Places에서 이 지역의 명소 좌표를 충분히 찾지 못했습니다. 도시나 지역명을 더 구체적으로 입력해 주세요.");
      if (!code) {
        const discoveredCountry = places.map(getCountryFromPlace).find((item) => item?.code);
        if (discoveredCountry) {
          code = discoveredCountry.code;
          catalogCountry = countryCatalog.find((record) => record.code === code);
          countryName = catalogCountry?.englishName || discoveredCountry.name || trimmedQuery;
          localName = catalogCountry?.localName || discoveredCountry.name || countryName;
          context.countryCode = code;
          context.countryName = countryName;
          context.localName = localName;
        }
      }
      if (!/^[a-z]{2}$/.test(code)) {
        throw new Error("검색된 명소에서 국가 코드를 확인할 수 없습니다. 도시나 지역명을 더 구체적으로 입력해 주세요.");
      }
      if (!context.center) {
        context.center = [
          places.reduce((sum, place) => sum + Number(place.location.latitude), 0) / places.length,
          places.reduce((sum, place) => sum + Number(place.location.longitude), 0) / places.length
        ];
        center = context.center;
      }
      const unorderedSpots = (await Promise.all(places.map((place, index) => toGeneratedSpot(place, index, context))))
        .filter(Boolean);
      spots = orderRouteSpotsNearestNeighbor(unorderedSpots, context.center);
    }
    if (!/^[a-z]{2}$/.test(code)) throw new Error("검색된 지역의 국가 코드를 확인할 수 없습니다. 국가명이나 도시명을 더 구체적으로 입력해 주세요.");
    if (spots.length < 2) throw new Error("루트를 만들 장소 좌표가 부족합니다. 다른 검색어나 더 구체적인 지역명을 입력해 주세요.");
    spots = spots.map((spot, index) => ({ ...spot, order: index + 1 }));

    const [foodItems, hotelItems] = await Promise.all([
      searchGeneratedRecommendations("food", context),
      searchGeneratedRecommendations("hotel", context)
    ]);
    const safetyCountry = countries.find((country) => country.countryCode?.toLowerCase() === code);
    const safetyAlerts = safetyCountry?.safetyAlerts?.length ? safetyCountry.safetyAlerts.map((alert) => ({ ...alert })) : [{
      level: "현지 확인",
      title: `${localName} 공식 여행경보 확인`,
      detail: `${location} 방문 전 외교부 여행경보와 현지 정부의 치안·교통·기상 공지를 확인하세요. 자동 생성 루트는 실시간 안전 판단을 대신하지 않습니다.`,
      source: { label: "외교부 해외안전여행", url: "https://www.0404.go.kr/" }
    }];
    const naturalRisk = safetyCountry?.naturalRisk ? { ...safetyCountry.naturalRisk } : {
      level: "현지 확인",
      title: "지역별 자연재해·기상 정보",
      detail: `${location}의 출발 당일 기상·재난 경보와 현장 통제를 확인하세요.`
    };
    const externalSafety = externalSafetyNewsByCountryCode.get(code);
    const timestamp = Date.now();
    const routeId = `auto-${code}-${timestamp}`;
    const distance = spots.slice(1).reduce((total, spot, index) => total + routeDistanceMeters(spots[index], spot), 0) / 1000;
    const description = template?.overview || sourceRoute?.description || `${trimmedQuery} 주변에서 Google Places가 찾은 명소를 방문 순서로 정리한 루트 초안입니다. 장소 간 실제 이동 시간과 운영 정보를 확인한 뒤 일정을 조정하세요.`;
    const item = {
      id: `custom-${code}-${timestamp}`,
      routeId,
      name: countryName,
      localName,
      countryCode: code,
      region: safetyCountry?.region || "AUTO-GENERATED ROUTE",
      location,
      routeTitle: template?.routeTitle || sourceRoute?.title || `${location} 맞춤 여행 루트`,
      duration: "하루",
      distance: `${distance.toFixed(1)} km · 예상 동선`,
      overview: description,
      description,
      spots: spots.map(({ countryId, ...spot }) => spot),
      foodItems,
      hotelItems,
      safetyAlerts,
      safetyMemo: safetyAlerts[0]?.detail || "",
      naturalRisk,
      profileInsight: safetyCountry?.profileInsight || "추천 장소는 검색 시점의 정보입니다. 출발 전 공식 안전 공지와 현장 운영 정보를 확인하세요.",
      safetyUpdates: externalSafety?.safetyUpdates || safetyCountry?.safetyUpdates || [],
      lastUpdated: externalSafety?.lastUpdated || safetyCountry?.lastUpdated || new Date().toISOString().slice(0, 10),
      safetyNewsDateSource: externalSafety?.lastUpdated ? "external" : safetyCountry?.safetyNewsDateSource || "bundled",
      isGeneratedDraft: true
    };
    return item;
  }

  async function runRouteGeneration(query, button) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = `${query} 여행 루트를 구성하는 중…`;
    searchFeedback.hidden = true;
    try {
      const item = await generateRouteByQuery(query);
      addCustomToData(item);
      refreshAfterCustomChange();
      filterCountryCards(new Set([item.id]));
      selectCountry(item.id, {
        toggle: false,
        openBoth: true,
        scroll: false,
        routeId: item.routeId,
        mapQuery: `${item.location}, ${item.name}`,
        mapZoom: 13,
        mapLabel: "맞춤 루트 초안"
      });
      countryDetails.scrollIntoView({ behavior: "smooth", block: "start" });
      hideSearchOptions();
      searchRouteGeneration.innerHTML = '<p class="route-generation-status">루트 초안을 지도와 아카이브에 반영했습니다. 여행 큐레이션 카드에서 내 아카이브에 저장할 수 있습니다.</p>';
      searchRouteGeneration.hidden = false;
      searchFeedback.hidden = true;
      toast("맞춤 여행 루트를 생성했습니다. 저장하면 새로고침 후에도 유지됩니다.");
    } catch (error) {
      button.disabled = false;
      button.textContent = originalText;
      searchFeedback.innerHTML = `<span aria-hidden="true">ⓘ</span><span>${escapeHTML(error.message || "여행 루트를 생성하지 못했습니다.")}</span>`;
      searchFeedback.hidden = false;
    }
  }

  function renderCountryCards() {
    countryList.innerHTML = countries.map((country, index) => `
      <button class="country-card" type="button" data-country="${escapeHTML(country.id)}" aria-pressed="false">
        <span class="country-card-top"><span class="country-index">${String(index + 1).padStart(2, "0")}</span></span>
        <span class="country-card-name"><img class="country-flag" src="${flagImageURL(country)}" alt="" width="24" height="18" loading="lazy">${escapeHTML(country.localName)}</span>
        <span class="country-card-region">${escapeHTML(country.region)} · ${String(country.count).padStart(2, "0")} NOTES${country.custom ? ' · MY ROUTE' : ""}</span>
        <span class="country-card-arrow" aria-hidden="true">↗</span>
      </button>`).join("");
    $("#country-count").textContent = `${countries.length} COUNTRIES`;
    $("#country-count-short").textContent = String(countries.length).padStart(2, "0");
  }

  function renderSafetyCards() {
    safetyCountryList.innerHTML = countries.map((country) => {
      const mainAlert = country.safetyAlerts?.[0];
      const backId = `safety-back-${country.id}`;
      return `
        <article class="safety-country-card" data-flip-card data-pinned="false">
          <div class="safety-card-inner">
            <button class="safety-card-face safety-card-front" type="button" data-flip-front aria-expanded="false" aria-controls="${backId}">
              <span class="safety-card-heading"><span class="safety-country-name"><img class="country-flag" src="${flagImageURL(country)}" alt="" width="24" height="18" loading="lazy"><strong>${escapeHTML(country.localName)}</strong></span><span class="risk-badge">${escapeHTML(mainAlert?.level || "정보")}</span></span>
              <span class="safety-card-topic">${escapeHTML(mainAlert?.title || "현지 안전정보")}</span>
              <span class="safety-flip-cue" aria-hidden="true">↻</span>
            </button>
            <div class="safety-card-face safety-card-back" id="${backId}" aria-hidden="true" inert>
              <div class="safety-card-heading"><span class="safety-country-name"><img class="country-flag" src="${flagImageURL(country)}" alt="" width="24" height="18" loading="lazy"><strong>${escapeHTML(country.localName)}</strong></span><span class="risk-badge">${escapeHTML(mainAlert?.level || "정보")}</span></div>
              <h4>${escapeHTML(mainAlert?.title || "현지 안전정보")}</h4>
              <p class="safety-country-summary">${escapeHTML(mainAlert?.detail || "여행 전 공식 안전 공지를 확인하세요.")}</p>
              ${mainAlert?.source?.url ? `<a class="safety-card-source" href="${safeURL(mainAlert.source.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(mainAlert.source.label)} ↗</a>` : ""}
              <div class="safety-card-actions">
                <button class="safety-flip-back" type="button" data-flip-back>앞면</button>
                <button class="safety-detail-link" type="button" data-safety-country="${escapeHTML(country.id)}">국가별 상세 ↗</button>
              </div>
            </div>
          </div>
        </article>`;
    }).join("");
  }

  function setSafetyCardFace(card, flipped, pinned = card.dataset.pinned === "true") {
    card.classList.toggle("is-flipped", flipped);
    card.dataset.pinned = String(pinned);
    const front = card.querySelector("[data-flip-front]");
    const back = card.querySelector(".safety-card-back");
    front.setAttribute("aria-expanded", String(flipped));
    front.setAttribute("aria-hidden", String(flipped));
    if (flipped) back.removeAttribute("inert");
    else back.setAttribute("inert", "");
    back.setAttribute("aria-hidden", String(!flipped));
  }

  function setSelectedCountryUI(country) {
    countryList.querySelectorAll("[data-country]").forEach((button) => {
      const active = button.dataset.country === country?.id;
      button.setAttribute("aria-pressed", String(active));
      button.classList.toggle("is-active", active);
    });
  }

  function resetCountryView() {
    countryDetails.hidden = true;
    selectedCountryId = null;
    setSelectedCountryUI(null);
    filterCountryCards(new Set(countries.map((country) => country.id)));
    resetMapToWorld();
    mapOpenLink.href = mapSearchURL("World map");
    mapStatus.textContent = "WORLD MAP";
    mapCaption.textContent = mapProvider === "google" ? "Google Maps" : "OpenStreetMap fallback";
  }

  function selectCountry(countryId, { toggle = true, openSafety = false, openBoth = true, scroll = true, mapQuery = null, mapZoom = null, mapLabel = null, routeId = null, focusSpotOrder = null } = {}) {
    const country = countryById.get(countryId);
    if (!country) return;

    if (toggle && selectedCountryId === countryId && !countryDetails.hidden) {
      resetCountryView();
      return;
    }

    selectedCountryId = countryId;
    setSelectedCountryUI(country);
    const countryRoutes = routes.filter((route) => route.countryId === countryId);
    const selectedRoute = countryRoutes.find((route) => route.id === routeId) || countryRoutes[0];
    const query = mapQuery || country.travel?.mapsQuery || country.name;
    const zoom = mapZoom || country.zoom || 5;
    mapOpenLink.href = selectedRoute ? googleDirectionsURL(selectedRoute) : mapSearchURL(query);
    mapStatus.textContent = selectedRoute
      ? `${country.name.toUpperCase()} · ROUTE ${selectedRoute.number}`
      : `${country.name.toUpperCase()} · ${country.region}`;
    mapCaption.textContent = mapLabel ? `${country.localName} · ${mapLabel}` : selectedRoute?.title || country.localName;
    renderCountryDetails(country, { openSafety, openBoth });
    countryDetails.hidden = false;
    if (selectedRoute) drawRouteOnMap(selectedRoute.id, { focusOrder: focusSpotOrder });
    else if (mapInstance) panToCountry(country, zoom);

    if (scroll) countryDetails.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function panToCountry(country, zoom = country.zoom || 5) {
    if (mapProvider === "google") {
      mapInstance.panTo({ lat: country.coordinates[0], lng: country.coordinates[1] });
      mapInstance.setZoom(zoom);
    } else if (mapProvider === "leaflet") {
      mapInstance.flyTo(country.coordinates, zoom, { duration: .8 });
    }
  }

  function selectRouteOnMap(routeId, spotOrder = null) {
    const route = routes.find((item) => item.id === routeId);
    if (!route) return;
    if (selectedCountryId !== route.countryId) {
      selectCountry(route.countryId, { toggle: false, openBoth: true, routeId, focusSpotOrder: spotOrder, scroll: false });
    } else if (selectedRouteId === routeId && spotOrder) {
      focusRouteSpot(routeId, spotOrder);
    } else {
      drawRouteOnMap(routeId, { focusOrder: spotOrder });
    }
    mapViewport.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderRouteCards(country) {
    const countryRoutes = country.routes || routes.filter((route) => route.countryId === country.id);
    if (!countryRoutes.length) return '<p class="empty-note">여행 루트가 준비 중입니다.</p>';
    return countryRoutes.map((route) => `
      <article class="mini-route-card" data-route-card="${escapeHTML(route.id)}">
        <div class="mini-route-image" data-route-cover-frame="${escapeHTML(route.id)}">
          <div class="mini-route-image-fallback" data-route-cover-fallback><span aria-hidden="true">⌖</span><strong>${escapeHTML(route.routeSpots?.[0]?.name || route.title)}</strong><small>장소 사진을 불러오는 중</small></div>
          <img data-route-cover-image alt="${escapeHTML(route.routeSpots?.[0]?.name || route.title)}" loading="lazy" hidden onerror="this.hidden=true;this.parentElement.querySelector('[data-route-cover-fallback]').removeAttribute('hidden');this.parentElement.querySelector('[data-route-cover-fallback] small').textContent='사진을 표시할 수 없어요';this.parentElement.querySelector('[data-route-cover-credit]').hidden=true">
          <div class="mini-route-image-credit" data-route-cover-credit hidden></div>
          <span>ROUTE ${escapeHTML(route.number)}</span>
        </div>
        <div class="mini-route-copy">
          <div class="mini-route-meta"><span>${escapeHTML(route.location)}</span><span>${escapeHTML(route.duration)} · ${escapeHTML(route.distance)}</span></div>
          <h4>${escapeHTML(route.title)}</h4>
          <ol class="route-step-list" aria-label="${escapeHTML(route.title)} 경유 스팟">
            ${(route.routeSpots || []).map((spot) => `
              <li><button class="route-step" type="button" data-route-step="${escapeHTML(route.id)}" data-spot-order="${escapeHTML(spot.order)}" aria-label="${escapeHTML(spot.order)}번 ${escapeHTML(spot.name)} 지도에서 보기">
                <span class="route-step-number">${String(spot.order).padStart(2, "0")}</span><span class="route-step-name">${escapeHTML(spot.name)}</span><span class="route-step-arrow" aria-hidden="true">↗</span>
              </button></li>`).join("")}
          </ol>
          <button class="route-map-select" type="button" data-route-select="${escapeHTML(route.id)}">지도에서 루트 보기 <span aria-hidden="true">⌖</span></button>
          <a class="google-search-link" href="${googleDirectionsURL(route)}" target="_blank" rel="noopener noreferrer">Google 지도 경로 열기 <span aria-hidden="true">↗</span></a>
        </div>
      </article>`).join("");
  }

  function renderRecommendations(items, country, kind) {
    if (!items?.length) return '<p class="empty-note">추천 정보를 준비 중입니다.</p>';
    return `<div class="recommendation-list">${items.map((item) => `
      <details class="recommendation-disclosure">
        <summary>
           <span class="recommendation-summary-copy"><span class="recommendation-area">${escapeHTML(item.area)}</span><strong>${escapeHTML(item.name)}</strong>${item.rating != null && Number.isFinite(Number(item.rating)) ? `<span class="recommendation-rating">★ ${Number(item.rating).toFixed(1)}${item.userRatingCount ? ` · 후기 ${Number(item.userRatingCount).toLocaleString()}개` : ""}</span>` : ""}</span>
          <span class="recommendation-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="recommendation-detail">
          <p>${escapeHTML(item.detail)}</p>
          ${kind === "food" && item.mustTry ? `<p class="must-try"><strong>꼭 먹을 메뉴</strong><span>${escapeHTML(item.mustTry)}</span></p>` : ""}
          ${kind === "hotel" && item.nearbyTransit ? `<p class="nearby-transit"><strong>교통 거점</strong><span>${escapeHTML(item.nearbyTransit)}</span></p>` : ""}
          <a class="google-review-link" href="${mapSearchURL(item.mapsQuery || `${item.name} ${item.area} ${country.name}`)}" target="_blank" rel="noopener noreferrer">Google Maps에서 평점·${kind === "food" ? "메뉴·" : ""}후기 확인 <span aria-hidden="true">↗</span></a>
        </div>
      </details>`).join("")}</div>`;
  }

  function isISODate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  function localSafetyCategory(value) {
    const category = String(value || "안전 정보").trim();
    const normalized = category.toLocaleLowerCase();
    if (/시위|집회|파업|protest|strike|demonstrat|riot/.test(normalized)) return "시위";
    if (/여행경보|travel advisory|travel alert|travel warning/.test(normalized)) return "여행경보";
    if (/치안|crime|theft|security/.test(normalized)) return "치안";
    if (/자연재해|earthquake|flood|storm|wildfire|volcano|landslide|weather|disaster/.test(normalized)) return "자연재해";
    if (/보건|health|outbreak|disease/.test(normalized)) return "보건";
    if (/교통|transport|transit|aviation/.test(normalized)) return "교통";
    return category;
  }

  function normalizeSafetyUpdates(items) {
    if (!Array.isArray(items)) return [];
    return items.map((item) => {
      const sourceUrl = item?.sourceUrl || item?.source?.url || "";
      const safeSourceUrl = /^https:\/\//i.test(sourceUrl) ? sourceUrl : "";
      return {
        date: isISODate(item?.date) ? item.date : "",
        category: localSafetyCategory(item?.category),
        title: String(item?.title || "").trim().slice(0, 180),
        summary: String(item?.summary || "").trim().slice(0, 800),
        sourceUrl: safeSourceUrl
      };
    }).filter((item) => item.title && item.summary)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 10);
  }

  function renderSafetyNewsSection(country) {
    const updates = normalizeSafetyUpdates(country.safetyUpdates);
    const updated = isISODate(country.lastUpdated)
      ? `${country.lastUpdated}${country.safetyNewsDateSource === "external" ? "" : " · 기본 데이터"}`
      : "기준일 정보 없음";
    return `<section class="safety-news-section" data-safety-news="${escapeHTML(country.id)}" aria-label="${escapeHTML(country.localName)} 최신 안전 업데이트">
      <div class="safety-news-heading"><div><p>DAILY SAFETY UPDATES</p><h4>최신 안전 업데이트</h4></div><span>기준일 · ${escapeHTML(updated)}</span></div>
      ${updates.length ? `<ul class="safety-news-list">${updates.map((item) => `
        <li class="safety-news-item">
          <div class="safety-news-meta"><time datetime="${escapeHTML(item.date)}">${escapeHTML(item.date || "날짜 미상")}</time><span>${escapeHTML(item.category)}</span></div>
          <h5>${escapeHTML(item.title)}</h5><p>${escapeHTML(item.summary)}</p>
          ${item.sourceUrl ? `<a href="${safeURL(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">출처 확인 ↗</a>` : ""}
        </li>`).join("")}</ul>` : '<p class="safety-news-empty">최근 등록된 특이 안전 뉴스가 없습니다.</p>'}
    </section>`;
  }

  function refreshSafetyNewsSection(country) {
    const section = [...accordionHost.querySelectorAll("[data-safety-news]")]
      .find((element) => element.dataset.safetyNews === country.id);
    if (section) section.outerHTML = renderSafetyNewsSection(country);
  }

  async function loadExternalSafetyNews() {
    try {
      const response = await fetch(new URL("safety-news.json", window.location.href), { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json();
      const rows = payload?.countries;
      const rootDate = isISODate(payload?.lastUpdated) ? payload.lastUpdated : "";
      const entries = Array.isArray(rows)
        ? rows.map((entry) => [entry?.id || entry?.countryCode || "", entry])
        : Object.entries(rows || {});
      entries.forEach(([key, entry]) => {
        const countryCode = String(entry?.countryCode || entry?.country_code || countries.find((item) => item.id === key)?.countryCode ||
          (/^[a-z]{2}$/i.test(key) ? key : "")).toLowerCase();
        if (!/^[a-z]{2}$/.test(countryCode)) return;
        const updates = Array.isArray(entry) ? entry : entry?.safetyUpdates ?? entry?.safetyNews;
        const lastUpdated = isISODate(entry?.lastUpdated) ? entry.lastUpdated : rootDate;
        externalSafetyNewsByCountryCode.set(countryCode, {
          safetyUpdates: Array.isArray(updates) ? normalizeSafetyUpdates(updates) : [],
          lastUpdated
        });
      });
      for (const country of countries) {
        const entry = Array.isArray(rows)
          ? rows.find((item) => item?.id === country.id || item?.countryCode === country.countryCode)
          : rows?.[country.id] || rows?.[country.countryCode];
        if (!entry) {
          if (rootDate) {
            country.lastUpdated = rootDate;
            country.safetyNewsDateSource = "external";
            refreshSafetyNewsSection(country);
          }
          continue;
        }
        const updates = Array.isArray(entry) ? entry : entry.safetyUpdates ?? entry.safetyNews;
        if (Array.isArray(updates)) country.safetyUpdates = normalizeSafetyUpdates(updates);
        const entryDate = isISODate(entry.lastUpdated) ? entry.lastUpdated : rootDate;
        if (entryDate) {
          country.lastUpdated = entryDate;
          country.safetyNewsDateSource = "external";
        }
        refreshSafetyNewsSection(country);
      }
    } catch (error) {
      // The bundled per-country defaults remain the offline and missing-file fallback.
    }
  }

  function renderTravelPanel(country) {
    const travel = country.travel || {};
    const draftBanner = country.generatedDraft ? `<aside class="generated-route-draft">
      <p><strong>루트 초안</strong> 자동 검색으로 구성된 여행지입니다. 내 아카이브에 저장하면 새로고침 후에도 유지됩니다.</p>
      <button type="button" data-save-generated-route="${escapeHTML(country.id)}">내 아카이브에 저장</button>
    </aside>` : "";
    return `
      <div class="panel-intro"><p class="panel-summary">${escapeHTML(travel.overview || "여행 루트와 현지 정보를 확인하세요.")}</p></div>
      ${draftBanner}
      <div class="travel-block">
        <div class="block-heading"><span class="block-sticker sticker-pink" aria-hidden="true">✈</span><div><p>CURATED ROUTES</p><h4>여행 루트</h4></div></div>
        <div class="mini-route-grid">${renderRouteCards(country)}</div>
      </div>
      <div class="travel-info-grid">
        <section class="travel-info-card">
          <div class="block-heading"><span class="block-sticker sticker-orange" aria-hidden="true">⌁</span><div><p>LOCAL TABLE</p><h4>로컬 맛집</h4></div></div>
          ${renderRecommendations(travel.food, country, "food")}
        </section>
        <section class="travel-info-card">
          <div class="block-heading"><span class="block-sticker sticker-purple" aria-hidden="true">⌂</span><div><p>PLACES TO STAY</p><h4>추천 숙소</h4></div></div>
          ${renderRecommendations(travel.hotels, country, "hotel")}
        </section>
      </div>
      <p class="review-method-note">${escapeHTML(data.recommendationNote || "Google 평점과 최근 후기는 지도 링크에서 확인하세요.")}</p>
      <div class="transit-callout"><span class="callout-icon" aria-hidden="true">🚆</span><div><strong>대중교통 팁</strong><p>${escapeHTML(countryRoutesText(country))}</p></div></div>
      <a class="country-map-link" href="${mapSearchURL(travel.mapsQuery || country.name)}" target="_blank" rel="noopener noreferrer">${escapeHTML(country.localName)} Google 지도 <span aria-hidden="true">↗</span></a>`;
  }

  function countryRoutesText(country) {
    const countryRoutes = routes.filter((route) => route.countryId === country.id);
    const tips = [...new Set(countryRoutes.map((route) => route.transit).filter(Boolean))];
    return tips.length ? tips.join(" ") : "현지 교통 수단과 운행 시간을 출발 전에 확인하세요.";
  }

  function renderSafetyPanel(country) {
    const alerts = country.safetyAlerts || [];
    const natural = country.naturalRisk || { level: "정보 확인", title: "자연재해 정보", detail: "공식 기상·재난 공지를 확인하세요." };
    return `
      <p class="advisory-note">여행경보와 현지 상황은 수시로 바뀝니다. 출발 전 공식 공지를 확인하세요.</p>
      <div class="alerts-list">${alerts.map((alert) => `
        <article class="safety-alert">
          <span class="alert-level">${escapeHTML(alert.level)}</span>
          <div class="safety-alert-copy"><h4>${escapeHTML(alert.title)}</h4><p>${escapeHTML(alert.detail)}</p><a href="${safeURL(alert.source?.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(alert.source?.label || "공식 안전 정보")} ↗</a></div>
        </article>`).join("")}</div>
      ${renderSafetyNewsSection(country)}
      <article class="natural-risk-card">
        <div class="natural-risk-heading"><span class="block-sticker sticker-sky" aria-hidden="true">⌁</span><div><p>NATURAL HAZARDS</p><h4>${escapeHTML(natural.title)}</h4></div><span class="risk-badge">${escapeHTML(natural.level)}</span></div>
        <p>${escapeHTML(natural.detail)}</p>
        <div class="hazard-links"><a href="${safeURL(data.liveFeeds?.globalDisasterAlerts)}" target="_blank" rel="noopener noreferrer">GDACS 재난 경보 ↗</a><a href="${safeURL(data.liveFeeds?.tsunami)}" target="_blank" rel="noopener noreferrer">쓰나미 경보 ↗</a><a href="${safeURL(data.liveFeeds?.volcano)}" target="_blank" rel="noopener noreferrer">화산 활동 정보 ↗</a></div>
      </article>
      <aside class="profile-callout"><span aria-hidden="true">✳</span><div><strong>FIELD INSIGHT</strong><p>${escapeHTML(country.profileInsight || "공식 안내와 현장 상황을 함께 확인하세요.")}</p></div></aside>
      <a class="official-link country-official-link" href="https://www.0404.go.kr/" target="_blank" rel="noopener noreferrer">외교부에서 ${escapeHTML(country.localName)} 최신 여행경보 확인 ↗</a>`;
  }

  function accordionMarkup(country, type, title, icon, contents, isOpen) {
    const key = `${country.id}-${type}`;
    return `
      <article class="accordion-card${isOpen ? " is-open" : ""}" data-accordion="${key}">
        <button class="accordion-trigger" type="button" aria-expanded="${isOpen}" aria-controls="accordion-body-${key}" id="accordion-trigger-${key}">
          <span class="accordion-icon ${type === "travel" ? "accordion-icon-travel" : "accordion-icon-safety"}" aria-hidden="true">${icon}</span>
          <span class="accordion-title-wrap"><span class="accordion-overline">${type === "travel" ? "TRAVEL CURATION" : "SAFETY INTELLIGENCE"}</span><span class="accordion-title">${title}</span></span>
          <span class="accordion-chevron" aria-hidden="true">⌄</span>
        </button>
        <div class="accordion-content" id="accordion-body-${key}" role="region" aria-labelledby="accordion-trigger-${key}" aria-hidden="${!isOpen}"${isOpen ? "" : " inert"}>
          <div class="accordion-content-clip"><div class="accordion-inner">${contents}</div></div>
        </div>
      </article>`;
  }

  function renderCountryDetails(country, { openSafety = false, openBoth = false } = {}) {
    $("#selected-flag").src = flagImageURL(country);
    $("#selected-flag").alt = "";
    $("#selected-country-name").textContent = country.localName;
    $("#selected-country-overview").textContent = country.travel?.overview || "";
    const travelOpen = openBoth || !openSafety;
    const safetyOpen = openBoth || openSafety;
    accordionHost.innerHTML = `
      ${accordionMarkup(country, "travel", "여행 큐레이션", "✈", renderTravelPanel(country), travelOpen)}
      ${accordionMarkup(country, "safety", "안전 & 리스크 인텔리전스", "🛡", renderSafetyPanel(country), safetyOpen)}`;
    if (travelOpen) loadRouteCardPhotos(country);
  }

  function setupAccordions() {
    accordionHost.addEventListener("click", (event) => {
      const saveGenerated = event.target.closest("[data-save-generated-route]");
      if (saveGenerated) {
        saveGeneratedRoute(saveGenerated.dataset.saveGeneratedRoute);
        return;
      }
      const routeSelect = event.target.closest("[data-route-select]");
      if (routeSelect) {
        selectRouteOnMap(routeSelect.dataset.routeSelect);
        return;
      }
      const routeStep = event.target.closest("[data-route-step]");
      if (routeStep) {
        selectRouteOnMap(routeStep.dataset.routeStep, Number(routeStep.dataset.spotOrder));
        return;
      }
      const trigger = event.target.closest(".accordion-trigger");
      if (!trigger) return;
      const card = trigger.closest(".accordion-card");
      const body = card.querySelector(".accordion-content");
      const open = trigger.getAttribute("aria-expanded") !== "true";
      card.classList.toggle("is-open", open);
      trigger.setAttribute("aria-expanded", String(open));
      body.setAttribute("aria-hidden", String(!open));
      if (open) body.removeAttribute("inert");
      else body.setAttribute("inert", "");
      if (open && card.dataset.accordion === `${selectedCountryId}-travel`) {
        const country = countryById.get(selectedCountryId);
        if (country) loadRouteCardPhotos(country);
      }
    });
  }

  function setupSafetyCardInteractions() {
    safetyCountryList.addEventListener("pointerover", (event) => {
      if (event.pointerType !== "mouse") return;
      const card = event.target.closest("[data-flip-card]");
      if (!card || (event.relatedTarget && card.contains(event.relatedTarget)) || card.dataset.pinned === "true") return;
      setSafetyCardFace(card, true, false);
    });
    safetyCountryList.addEventListener("pointerout", (event) => {
      if (event.pointerType !== "mouse") return;
      const card = event.target.closest("[data-flip-card]");
      if (!card || (event.relatedTarget && card.contains(event.relatedTarget)) || card.dataset.pinned === "true") return;
      setSafetyCardFace(card, false, false);
    });
    safetyCountryList.addEventListener("click", (event) => {
      const countryLink = event.target.closest("[data-safety-country]");
      if (countryLink) {
        selectCountry(countryLink.dataset.safetyCountry, { toggle: false, openSafety: true, openBoth: false });
        return;
      }
      const card = event.target.closest("[data-flip-card]");
      if (!card) return;
      if (event.target.closest("[data-flip-back]")) {
        setSafetyCardFace(card, false, false);
        card.querySelector("[data-flip-front]").focus({ preventScroll: true });
      } else if (event.target.closest("[data-flip-front]")) {
        const pinned = card.dataset.pinned !== "true";
        setSafetyCardFace(card, pinned, pinned);
        if (pinned) card.querySelector("[data-flip-back]").focus({ preventScroll: true });
      }
    });
  }

  function setupNavigation() {
    // The header has no navigation tabs; anchor links in the page handle scrolling natively.
  }

  function setupBookIntro() {
    const intro = $("#book-intro");
    if (intro.hidden) return;
    const cover = $("#book-cover");
    const openButton = $("#book-open");
    let opening = false;
    let dismissed = false;

    const finishOpening = () => {
      if (dismissed) return;
      dismissed = true;
      intro.classList.add("is-dismissed");
      document.body.classList.remove("intro-locked");
      window.setTimeout(hideIntro, 650);
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        hideIntro();
      }
    };

    const hideIntro = () => {
      if (intro.hidden) return;
      intro.hidden = true;
      intro.setAttribute("aria-hidden", "true");
      $("#hero-title").focus({ preventScroll: true });
    };

    const startOpening = () => {
      if (opening) return;
      opening = true;
      cover.setAttribute("aria-expanded", "true");
      openButton.setAttribute("aria-expanded", "true");
      intro.classList.add("is-opening");
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finishOpening();
      else window.setTimeout(finishOpening, 1300);
    };

    cover.addEventListener("transitionend", (event) => {
      if (event.target === cover && event.propertyName === "transform") finishOpening();
    });
    intro.addEventListener("transitionend", (event) => {
      if (event.target !== intro || event.propertyName !== "opacity") return;
      hideIntro();
    });
    intro.addEventListener("click", startOpening);
    document.addEventListener("keydown", (event) => {
      if (intro.hidden) return;
      if (event.key === "Escape") {
        event.preventDefault();
        startOpening();
      } else if (event.key === "Tab") {
        const focusable = [cover, openButton].filter((element) => !element.disabled);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });
  }

  function setupSearch() {
    searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      submitSearch();
    });
    searchInput.addEventListener("input", updateSearch);
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hideSearchOptions();
        hideRouteGenerationAction();
        searchFeedback.hidden = true;
      } else if (event.key === "ArrowDown" && !searchResults.hidden) {
        event.preventDefault();
        searchResults.querySelector(".search-result")?.focus();
      }
    });
    searchResults.addEventListener("click", (event) => {
      const generateButton = event.target.closest("[data-generate-route]");
      if (generateButton) {
        runRouteGeneration(generateButton.dataset.generateRoute, generateButton);
        return;
      }
      const option = event.target.closest("[data-search-result]");
      if (!option) return;
      const candidate = currentSearchMatches[Number(option.dataset.searchResult)];
      if (candidate) chooseSearchResult(candidate);
    });
    searchRouteGeneration.addEventListener("click", (event) => {
      const button = event.target.closest("[data-generate-route]");
      if (!button || button.disabled) return;
      runRouteGeneration(button.dataset.generateRoute, button);
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".hero-search-wrap")) {
        hideSearchOptions();
        hideRouteGenerationAction();
      }
    });
  }

  const STORAGE_KEY = "journeyArchiveCustomDestinations";
  const modal = $("#destination-modal");
  const destinationForm = $("#destination-form");
  const spotRows = $("#spot-rows");
  const managedList = $("#managed-list");
  const toastElement = $("#toast");
  let customDestinations = loadCustomDestinations();
  let toastTimer = null;
  let countryCatalog = countries.map((country) => ({
    code: String(country.countryCode || "").toLowerCase(),
    localName: country.localName || country.name,
    englishName: country.name,
    aliases: [country.localName, country.name].filter(Boolean)
  }));
  let countryCatalogPromise = null;
  const placeSearchTimers = new WeakMap();
  const placeSearchControllers = new WeakMap();

  function loadCustomDestinations() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((item) => item && item.id && item.countryCode) : [];
    } catch (error) {
      console.warn("Unable to read saved destinations.", error);
      return [];
    }
  }

  function saveCustomDestinations() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(customDestinations));
    } catch (error) {
      console.warn("Unable to save destinations.", error);
      toast("저장 공간이 부족해 저장하지 못했습니다.");
    }
  }

  function findCountryOption(value) {
    const query = normalizeSearchTerm(value);
    if (!query) return null;
    return countryCatalog.find((record) => record.aliases.some((alias) => normalizeSearchTerm(alias) === query)) || null;
  }

  function renderCountrySuggestions(value = "") {
    const datalist = $("#country-suggestions");
    if (!datalist) return;
    const query = normalizeSearchTerm(value);
    const matches = countryCatalog.filter((record) => !query || record.aliases.some((alias) => normalizeSearchTerm(alias).startsWith(query))).slice(0, query ? 24 : 40);
    const options = [];
    matches.forEach((record) => {
      const matchingAliases = query
        ? record.aliases.filter((alias) => normalizeSearchTerm(alias).startsWith(query))
        : [record.localName || record.englishName];
      matchingAliases.forEach((alias) => {
        const otherName = record.aliases.find((candidate) => candidate !== alias);
        options.push(`<option value="${escapeHTML(alias)}" label="${escapeHTML(`${otherName ? `${otherName} · ` : ""}${record.code.toUpperCase()}`)}"></option>`);
      });
    });
    datalist.innerHTML = options.join("");
  }

  function ensureCountryCatalog() {
    if (countryCatalogPromise) return countryCatalogPromise;
    countryCatalogPromise = Promise.all([
      fetch("https://cdn.jsdelivr.net/npm/country-list@2.3.0/data.json").then((response) => response.ok ? response.json() : []).catch(() => []),
      fetch("https://cdn.jsdelivr.net/npm/i18n-iso-countries@7.14.0/langs/ko.json").then((response) => response.ok ? response.json() : {}).catch(() => ({}))
    ]).then(([records, translationData]) => {
        if (!Array.isArray(records)) return countryCatalog;
        const koreanNames = translationData?.countries || {};
        const byCode = new Map(countryCatalog.map((record) => [record.code, record]));
        records.forEach((item) => {
          const code = String(item.code || "").toLowerCase();
          const englishName = item.name || "";
          const localName = koreanNames[code.toUpperCase()] || englishName;
          if (!code || !englishName) return;
          const existing = byCode.get(code);
          if (existing) {
            existing.aliases = [...new Set([...existing.aliases, localName, englishName].filter(Boolean))];
            existing.localName ||= localName;
            existing.englishName ||= englishName;
          } else {
            byCode.set(code, { code, localName, englishName, aliases: [...new Set([localName, englishName].filter(Boolean))] });
          }
        });
        countryCatalog = [...byCode.values()].sort((a, b) => a.localName.localeCompare(b.localName, "ko"));
        const currentName = destinationForm.querySelector('[name="countryName"]').value;
        renderCountrySuggestions(currentName);
        const match = findCountryOption(currentName);
        const codeInput = destinationForm.querySelector('[name="countryCode"]');
        if (match && codeInput.value !== match.code) {
          codeInput.value = match.code;
          clearSpotLocationsForCountryChange();
        }
        return countryCatalog;
      })
      .catch(() => countryCatalog);
    return countryCatalogPromise;
  }

  function setPlaceSearchStatus(row, message) {
    const status = row.querySelector("[data-place-search-status]");
    if (status) status.textContent = message;
  }

  function clearSpotLocationsForCountryChange() {
    spotRows.querySelectorAll("[data-spot-row]").forEach((row) => {
      const timer = placeSearchTimers.get(row);
      if (timer) window.clearTimeout(timer);
      placeSearchControllers.get(row)?.abort();
      renderPlaceSuggestions(row, []);
      row.querySelector('[name="spotLat"]').value = "";
      row.querySelector('[name="spotLng"]').value = "";
      setPlaceSearchStatus(row, "국가가 바뀌었습니다. 장소를 다시 검색해 좌표를 확인해 주세요.");
    });
  }

  function renderPlaceSuggestions(row, places) {
    const list = row.querySelector("[data-place-suggestions]");
    if (!list) return;
    row.placeSuggestions = places;
    list.replaceChildren();
    places.forEach((place, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "spot-place-option";
      button.dataset.placeSuggestion = String(index);
      button.setAttribute("role", "option");
      const title = document.createElement("strong");
      title.textContent = place.displayName?.text || "이름 없는 장소";
      const address = document.createElement("small");
      address.textContent = place.formattedAddress || "";
      button.append(title, address);
      list.append(button);
    });
    list.hidden = places.length === 0;
  }

  async function searchSpotPlaces(input) {
    const row = input.closest("[data-spot-row]");
    const query = input.value.trim();
    const apiKey = data.mapConfig?.placesApiKey;
    if (!row || query.length < 3) return;
    if (!apiKey) {
      setPlaceSearchStatus(row, "장소 검색 키가 없어 위도·경도를 직접 입력해 주세요.");
      return;
    }
    const countryName = destinationForm.querySelector('[name="countryName"]').value.trim();
    const countryCode = destinationForm.querySelector('[name="countryCode"]').value.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) {
      setPlaceSearchStatus(row, "먼저 국가를 목록에서 선택하거나 ISO 코드를 입력해 주세요.");
      return;
    }
    const controller = new AbortController();
    placeSearchControllers.set(row, controller);
    const body = {
      textQuery: countryName ? `${query}, ${countryName}` : query,
      maxResultCount: 5,
      regionCode: countryCode
    };
    setPlaceSearchStatus(row, "장소를 찾는 중…");
    try {
      const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location"
        },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (placeSearchControllers.get(row) !== controller || !row.isConnected) return;
      const places = (payload.places || []).filter((place) => Number.isFinite(place.location?.latitude) && Number.isFinite(place.location?.longitude));
      renderPlaceSuggestions(row, places);
      setPlaceSearchStatus(row, places.length ? "검색 결과에서 장소를 선택하면 좌표를 자동 입력합니다." : "검색 결과가 없습니다. 위도·경도는 직접 입력할 수 있어요.");
    } catch (error) {
      if (error.name === "AbortError") return;
      setPlaceSearchStatus(row, "장소 검색에 실패했습니다. 장소명과 국가를 확인하거나 좌표를 직접 입력해 주세요.");
    }
  }

  function schedulePlaceSearch(input) {
    const row = input.closest("[data-spot-row]");
    if (!row) return;
    const previousTimer = placeSearchTimers.get(row);
    if (previousTimer) window.clearTimeout(previousTimer);
    placeSearchControllers.get(row)?.abort();
    renderPlaceSuggestions(row, []);
    row.querySelector('[name="spotLat"]').value = "";
    row.querySelector('[name="spotLng"]').value = "";
    const query = input.value.trim();
    if (query.length < 3) {
      setPlaceSearchStatus(row, "장소명을 3자 이상 입력하면 검색 결과가 표시됩니다.");
      return;
    }
    const timer = window.setTimeout(() => searchSpotPlaces(input), 500);
    placeSearchTimers.set(row, timer);
  }

  function rawImageURL(value) {
    return /^https:\/\//i.test(value || "") ? value : "";
  }

  function addCustomToData(item) {
    const id = item.id;
    const code = String(item.countryCode || "").toLowerCase();
    const localName = item.localName || item.name;
    const spots = (item.spots || []).map((spot, index) => ({
      order: index + 1,
      countryId: id,
      city: item.location || item.name,
      name: spot.name || `스팟 ${index + 1}`,
      lat: Number(spot.lat),
      lng: Number(spot.lng),
      desc: spot.desc || "",
      image: rawImageURL(spot.image),
      imageVerified: Boolean(rawImageURL(spot.image)),
      photoQuery: spot.photoQuery || `${spot.name || `스팟 ${index + 1}`}, ${item.location || item.name}, ${item.name}`,
      address: spot.address || "",
      rating: Number.isFinite(Number(spot.rating)) ? Number(spot.rating) : null,
      userRatingCount: Number(spot.userRatingCount) || 0,
      googlePhotoName: spot.googlePhotoName || "",
      photoAttributions: Array.isArray(spot.photoAttributions) ? spot.photoAttributions : []
    })).filter((spot) => Number.isFinite(spot.lat) && Number.isFinite(spot.lng));
    if (!spots.length) return;

    const routeId = item.routeId || `custom-${id}`;
    const route = {
      id: routeId,
      countryId: id,
      number: String(routes.length + 1).padStart(2, "0"),
      title: item.routeTitle || `${localName} 여행 루트`,
      location: item.location || item.name,
      duration: item.duration || "하루",
      distance: item.distance || "—",
      coordinates: spots.map((spot) => [spot.lat, spot.lng]),
      stops: spots.map((spot) => spot.name),
      image: spots.find((spot) => spot.image)?.image || "",
      imageAlt: `${localName} 여행 사진`,
      note: item.overview || "직접 추가한 여행 루트입니다.",
      description: item.description || item.overview || "직접 추가한 여행 루트입니다.",
      highlights: spots.map((spot) => ({ name: spot.name, detail: spot.desc || "현지에서 만나는 여행 스팟입니다." })),
      food: item.foodItems?.[0] || (item.foodMemo ? { name: item.foodMemo, detail: item.foodMemo } : undefined),
      swim: { name: "현지 안전 안내 확인", detail: "수영 가능 구역과 당일 안전 안내를 현지에서 확인하세요.", safety: "지정 수역만 이용" },
      transit: "현지 대중교통과 도로 상황을 출발 전에 확인하세요.",
      routeSpots: spots
    };

    const foodItems = Array.isArray(item.foodItems) && item.foodItems.length ? item.foodItems : item.foodMemo ? [{
      name: item.foodMemo,
      area: localName,
      detail: item.foodMemo,
      mustTry: item.foodMemo,
      mapsQuery: `${item.foodMemo} ${item.name}`
    }] : [];
    const hotelItems = Array.isArray(item.hotelItems) && item.hotelItems.length ? item.hotelItems : item.hotelMemo ? [{
      name: item.hotelMemo,
      area: localName,
      detail: item.hotelMemo,
      nearbyTransit: "역·공항과의 접근성을 출발 전에 확인하세요.",
      mapsQuery: `${item.hotelMemo} ${item.name}`
    }] : [];

    const country = {
      id,
      name: item.name,
      localName,
      countryCode: code,
      flag: "🌍",
      region: item.region || "CUSTOM ROUTE",
      coordinates: [spots[0].lat, spots[0].lng],
      zoom: 12,
      count: 1,
      custom: true,
      generatedDraft: Boolean(item.isGeneratedDraft),
      generatedItem: item,
      travel: {
        overview: item.overview || "직접 추가한 여행지입니다.",
        food: foodItems,
        hotels: hotelItems,
        mapsQuery: item.name
      },
      safetyAlerts: Array.isArray(item.safetyAlerts) && item.safetyAlerts.length ? item.safetyAlerts : item.safetyMemo ? [{
        level: "직접 추가",
        title: "내 안전·리스크 메모",
        detail: item.safetyMemo,
        source: { label: "외교부 해외안전여행", url: "https://www.0404.go.kr/" }
      }] : [{
        level: "정보 확인",
        title: "현지 안전 공지 확인",
        detail: "출발 전 여행경보와 현지 치안·기상 공지를 확인하세요.",
        source: { label: "외교부 해외안전여행", url: "https://www.0404.go.kr/" }
      }],
      naturalRisk: item.naturalRisk || { level: "현지 확인", title: "지진·기상 등 자연재해", detail: "현지 재난 경보와 기상 안내를 출발 전에 확인하세요." },
      profileInsight: item.profileInsight || "직접 추가한 여행지는 현지 사정에 따라 달라질 수 있습니다. 공식 공지와 최신 후기를 함께 확인하세요.",
      safetyUpdates: Array.isArray(item.safetyUpdates) ? item.safetyUpdates : [],
      lastUpdated: item.lastUpdated || new Date().toISOString().slice(0, 10),
      safetyNewsDateSource: item.safetyNewsDateSource || "bundled",
      routes: [route],
      routeSpots: spots
    };

    countries.push(country);
    routes.push(route);
    countryById.set(id, country);
  }

  function removeCustomFromData(id) {
    for (let index = routes.length - 1; index >= 0; index -= 1) {
      if (routes[index].countryId === id) routes.splice(index, 1);
    }
    for (let index = countries.length - 1; index >= 0; index -= 1) {
      if (countries[index].id === id) countries.splice(index, 1);
    }
    countryById.delete(id);
    if (selectedCountryId === id) resetCountryView();
  }

  function saveGeneratedRoute(id) {
    const country = countryById.get(id);
    const item = country?.generatedItem;
    if (!country?.generatedDraft || !item) return false;
    const savedItem = { ...item, isGeneratedDraft: false };
    const nextDestinations = [...customDestinations.filter((entry) => entry.id !== id), savedItem];
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDestinations));
    } catch (error) {
      toast("저장 공간이 부족해 루트를 보관하지 못했습니다.");
      return false;
    }
    customDestinations = nextDestinations;
    country.generatedItem = savedItem;
    country.generatedDraft = false;
    refreshAfterCustomChange();
    if (selectedCountryId === id) renderCountryDetails(country, { openBoth: true });
    toast("맞춤 여행 루트를 내 아카이브에 저장했습니다.");
    return true;
  }

  function refreshAfterCustomChange() {
    searchIndex = makeSearchIndex();
    renderCountryCards();
    renderSafetyCards();
    if (mapInstance) addCountryMarkers();
  }

  function toast(message) {
    if (!toastElement) return;
    toastElement.textContent = message;
    toastElement.hidden = false;
    toastElement.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastElement.classList.remove("is-visible");
      window.setTimeout(() => { toastElement.hidden = true; }, 220);
    }, 2600);
  }

  function spotRowMarkup() {
    return `<div class="spot-row" data-spot-row>
      <div class="spot-name-field">
        <input name="spotName" type="text" placeholder="장소명 (예: 앙코르와트)" autocomplete="off" aria-label="장소명" required>
        <div class="spot-place-suggestions" data-place-suggestions role="listbox" hidden></div>
        <small class="spot-place-status" data-place-search-status aria-live="polite">장소명을 3자 이상 입력하면 좌표 검색을 시작합니다.</small>
      </div>
      <div class="spot-row-grid">
        <input name="spotLat" type="number" step="any" placeholder="위도 lat" required>
        <input name="spotLng" type="number" step="any" placeholder="경도 lng" required>
      </div>
      <input name="spotImage" type="url" placeholder="대표 사진 URL (https://...)">
      <input name="spotDesc" type="text" placeholder="한 줄 설명">
      <button type="button" class="spot-remove" aria-label="스팟 삭제">×</button>
    </div>`;
  }

  function addSpotRow() {
    spotRows.insertAdjacentHTML("beforeend", spotRowMarkup());
  }

  function renderManagedList() {
    if (!managedList) return;
    if (!customDestinations.length) {
      managedList.innerHTML = '<p class="managed-empty">아직 추가한 여행지가 없습니다.</p>';
      return;
    }
    managedList.innerHTML = customDestinations.map((item) => `
      <div class="managed-item">
        <span>${escapeHTML(item.localName || item.name)} <small>${escapeHTML(item.countryCode)}</small></span>
        <button type="button" class="managed-delete" data-delete-custom="${escapeHTML(item.id)}">삭제</button>
      </div>`).join("");
  }

  function openDestinationModal() {
    modal.hidden = false;
    document.body.classList.add("modal-open");
    renderManagedList();
    if (!spotRows.children.length) addSpotRow();
    renderCountrySuggestions(destinationForm.querySelector('[name="countryName"]').value);
    ensureCountryCatalog();
    destinationForm.querySelector('[name="countryName"]').focus();
  }

  function closeDestinationModal() {
    modal.hidden = true;
    document.body.classList.remove("modal-open");
  }

  function deleteCustomDestination(id) {
    const item = customDestinations.find((entry) => entry.id === id);
    if (!item) return;
    if (!window.confirm(`${item.localName || item.name} 여행지를 삭제할까요?`)) return;
    customDestinations = customDestinations.filter((entry) => entry.id !== id);
    saveCustomDestinations();
    removeCustomFromData(id);
    refreshAfterCustomChange();
    renderManagedList();
    toast("여행지를 삭제했습니다.");
  }

  function clearAllCustomDestinations() {
    if (!customDestinations.length) {
      toast("삭제할 여행지가 없습니다.");
      return;
    }
    if (!window.confirm("추가한 여행지를 모두 삭제할까요?")) return;
    customDestinations.slice().forEach((item) => removeCustomFromData(item.id));
    customDestinations = [];
    saveCustomDestinations();
    refreshAfterCustomChange();
    renderManagedList();
    toast("추가한 여행지를 모두 삭제했습니다.");
  }

  function handleDestinationSubmit(event) {
    event.preventDefault();
    const form = new FormData(destinationForm);
    const name = String(form.get("countryName") || "").trim();
    const code = String(form.get("countryCode") || "").trim().toLowerCase();
    if (!name || !/^[a-z]{2}$/.test(code)) {
      toast("국가명과 2자리 국가 코드를 확인해 주세요.");
      return;
    }
    const spots = [...spotRows.querySelectorAll("[data-spot-row]")].map((row) => ({
      name: String(row.querySelector('[name="spotName"]')?.value || "").trim(),
      lat: row.querySelector('[name="spotLat"]')?.value,
      lng: row.querySelector('[name="spotLng"]')?.value,
      image: String(row.querySelector('[name="spotImage"]')?.value || "").trim(),
      desc: String(row.querySelector('[name="spotDesc"]')?.value || "").trim()
    })).filter((spot) => spot.name && Number.isFinite(Number(spot.lat)) && Number.isFinite(Number(spot.lng)));
    if (!spots.length) {
      toast("위치가 있는 스팟을 하나 이상 추가해 주세요.");
      return;
    }

    const item = {
      id: `custom-${code}-${Date.now()}`,
      name,
      localName: name,
      countryCode: code,
      overview: String(form.get("overview") || "").trim(),
      foodMemo: String(form.get("foodMemo") || "").trim(),
      hotelMemo: String(form.get("hotelMemo") || "").trim(),
      safetyMemo: String(form.get("safetyMemo") || "").trim(),
      spots
    };
    customDestinations.push(item);
    saveCustomDestinations();
    addCustomToData(item);
    refreshAfterCustomChange();
    destinationForm.reset();
    spotRows.innerHTML = "";
    addSpotRow();
    closeDestinationModal();
    selectCountry(item.id, { toggle: false, openBoth: true, scroll: false });
    toast("새 여행지가 지도에 추가되었습니다!");
  }

  function copyText(text) {
    const fallback = () => {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      let copied = false;
      try { copied = document.execCommand("copy"); } catch (error) { copied = false; }
      document.body.removeChild(area);
      return copied ? Promise.resolve() : Promise.reject(new Error("copy failed"));
    };
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(fallback);
    return fallback();
  }

  function shareSelectedDestination() {
    const country = countryById.get(selectedCountryId);
    if (!country) {
      toast("먼저 공유할 여행지를 선택해 주세요.");
      return;
    }
    if (country.generatedDraft && !saveGeneratedRoute(country.id)) return;
    const route = routes.find((entry) => entry.id === selectedRouteId && entry.countryId === country.id) || country.routes?.[0];
    const activeStep = countryDetails.querySelector(".route-step.is-active");
    const spotOrder = pinnedInfoSpot?.order || Number(activeStep?.dataset.spotOrder) || 1;
    const spot = route?.routeSpots?.find((entry) => entry.order === spotOrder);
    const url = new URL(window.location.href);
    url.searchParams.set("country", country.custom ? country.id : country.countryCode || country.id);
    url.searchParams.set("spot", String(spotOrder));
    if (route) url.searchParams.set("route", route.id);

    const title = `${country.localName} 여행 큐레이션 · Journey & Archive`;
    const text = [`${country.localName} · ${route?.title || "여행 루트"}`];
    if (spot) text.push(`${spot.order}. ${spot.name} — ${spot.desc || "여행 스팟"}`);
    if (route?.routeSpots?.length) text.push(`루트: ${route.routeSpots.map((entry) => entry.name).join(" → ")}`);
    text.push(url.toString());
    const summary = text.join("\n");

    if (navigator.share) {
      navigator.share({ title, text: summary, url: url.toString() }).catch(() => {});
      return;
    }
    copyText(summary).then(() => toast("공유 링크가 복사되었습니다!")).catch(() => toast("링크 복사에 실패했습니다."));
  }

  function applySharedURL() {
    const params = new URLSearchParams(window.location.search);
    const key = params.get("country");
    if (!key) return false;
    const normalized = key.toLowerCase();
    const country = countries.find((entry) => entry.id === key || String(entry.countryCode).toLowerCase() === normalized);
    if (!country) {
      toast("공유된 여행지를 찾을 수 없습니다.");
      return false;
    }
    const intro = $("#book-intro");
    if (intro) {
      intro.hidden = true;
      intro.setAttribute("aria-hidden", "true");
    }
    document.body.classList.remove("intro-locked");
    const routeId = params.get("route");
    const validRouteId = routeId && routes.some((entry) => entry.id === routeId && entry.countryId === country.id) ? routeId : undefined;
    selectCountry(country.id, {
      toggle: false,
      openBoth: true,
      routeId: validRouteId,
      focusSpotOrder: Number(params.get("spot")) || 1,
      scroll: false
    });
    window.setTimeout(() => mapViewport.scrollIntoView({ behavior: "smooth", block: "start" }), 400);
    toast("공유된 여행지를 열었습니다.");
    return true;
  }

  customDestinations.forEach((item) => addCustomToData(item));
  addSpotRow();
  renderManagedList();

  $("#add-destination").addEventListener("click", openDestinationModal);
  $("#close-destination-modal").addEventListener("click", closeDestinationModal);
  $("#reset-destinations").addEventListener("click", clearAllCustomDestinations);
  $("#clear-custom").addEventListener("click", clearAllCustomDestinations);
  $("#share-destination").addEventListener("click", shareSelectedDestination);
  $("#add-spot-row").addEventListener("click", addSpotRow);
  const countryNameInput = destinationForm.querySelector('[name="countryName"]');
  const countryCodeInput = destinationForm.querySelector('[name="countryCode"]');
  countryNameInput.addEventListener("input", () => {
    const match = findCountryOption(countryNameInput.value);
    const nextCode = match?.code || "";
    renderCountrySuggestions(countryNameInput.value);
    if (countryCodeInput.value !== nextCode) {
      countryCodeInput.value = nextCode;
      clearSpotLocationsForCountryChange();
    }
  });
  countryCodeInput.addEventListener("input", () => {
    const nextCode = countryCodeInput.value.trim().toLowerCase();
    if (countryCodeInput.value !== nextCode) countryCodeInput.value = nextCode;
    if (nextCode !== (countryNameInput.dataset.lastCountryCode || "")) clearSpotLocationsForCountryChange();
    countryNameInput.dataset.lastCountryCode = nextCode;
  });
  spotRows.addEventListener("input", (event) => {
    const input = event.target.closest('[name="spotName"]');
    if (input) schedulePlaceSearch(input);
  });
  spotRows.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.target.matches('[name="spotName"]')) return;
    const firstOption = event.target.closest("[data-spot-row]")?.querySelector("[data-place-suggestions]:not([hidden]) .spot-place-option");
    if (firstOption) {
      event.preventDefault();
      firstOption.click();
    }
  });
  spotRows.addEventListener("click", (event) => {
    const suggestion = event.target.closest("[data-place-suggestion]");
    if (suggestion) {
      const row = suggestion.closest("[data-spot-row]");
      const place = row?.placeSuggestions?.[Number(suggestion.dataset.placeSuggestion)];
      if (!place?.location) return;
      const nameInput = row.querySelector('[name="spotName"]');
      const latInput = row.querySelector('[name="spotLat"]');
      const lngInput = row.querySelector('[name="spotLng"]');
      nameInput.value = place.displayName?.text || nameInput.value;
      latInput.value = String(place.location.latitude);
      lngInput.value = String(place.location.longitude);
      renderPlaceSuggestions(row, []);
      setPlaceSearchStatus(row, `좌표 입력 완료 · ${place.formattedAddress || "장소 위치 확인"}`);
      return;
    }
    const remove = event.target.closest(".spot-remove");
    if (!remove) return;
    const row = remove.closest("[data-spot-row]");
    if (spotRows.children.length === 1) {
      placeSearchControllers.get(row)?.abort();
      renderPlaceSuggestions(row, []);
      row.querySelectorAll("input").forEach((input) => { input.value = ""; });
      setPlaceSearchStatus(row, "장소명을 3자 이상 입력하면 좌표 검색을 시작합니다.");
      return;
    }
    placeSearchControllers.get(row)?.abort();
    row.remove();
  });
  managedList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-custom]");
    if (button) deleteCustomDestination(button.dataset.deleteCustom);
  });
  destinationForm.addEventListener("submit", handleDestinationSubmit);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeDestinationModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) closeDestinationModal();
  });

  countryList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-country]");
    if (button) selectCountry(button.dataset.country);
  });
  $("#close-country").addEventListener("click", resetCountryView);

  searchIndex = makeSearchIndex();
  renderCountryCards();
  renderSafetyCards();
  setupAccordions();
  setupSafetyCardInteractions();
  setupNavigation();
  setupSearch();
  safetyNewsReady = loadExternalSafetyNews();
  applySharedURL();
  setupBookIntro();
  initializeMap();
})();
