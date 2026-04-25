"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";

const DEFAULT_CENTER = [12.8797, 121.774];
const DEFAULT_ZOOM = 6;

function createUserIcon(userId, isCurrentUser, isFocused) {
  const shortLabel = userId?.replace(/^user-/, "").slice(0, 2).toUpperCase() || "U";
  const className = [
    "user-pin",
    isCurrentUser ? "is-current" : "is-other",
    isFocused ? "is-focused" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return L.divIcon({
    className: "user-pin-wrapper",
    html: `
      <span class="${className}">
        <span class="user-pin-label">${shortLabel}</span>
      </span>
    `,
    iconSize: [34, 34],
    iconAnchor: [17, 17]
  });
}

function animateMarker(marker, nextLatLng, duration = 700) {
  const startLatLng = marker.getLatLng();
  const startTime = performance.now();

  const step = (now) => {
    const progress = Math.min((now - startTime) / duration, 1);
    const lat = startLatLng.lat + (nextLatLng.lat - startLatLng.lat) * progress;
    const lng = startLatLng.lng + (nextLatLng.lng - startLatLng.lng) * progress;

    marker.setLatLng([lat, lng]);

    if (progress < 1) {
      requestAnimationFrame(step);
    }
  };

  requestAnimationFrame(step);
}

export default function TrackingMap({
  locations,
  histories,
  currentUserId,
  focusedUserId
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map());
  const circlesRef = useRef(new Map());
  const linesRef = useRef(new Map());
  const hasInitialFitRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    // Start on a neutral Philippines-wide view until live locations arrive.
    const map = L.map(containerRef.current, {
      zoomControl: true,
      preferCanvas: true
    }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19
    }).addTo(map);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const activeUserIds = new Set();

    locations.forEach((location) => {
      activeUserIds.add(location.user_id);

      const isCurrentUser = location.user_id === currentUserId;
      const isFocused = location.user_id === focusedUserId;
      const nextLatLng = L.latLng(location.latitude, location.longitude);
      const popupHtml = `
        <div class="marker-popup">
          <strong>${isCurrentUser ? "You" : location.user_id}</strong>
          <div>Lat: ${location.latitude.toFixed(6)}</div>
          <div>Lng: ${location.longitude.toFixed(6)}</div>
          <div>Accuracy: ${Math.round(location.accuracy || 0)}m</div>
          <div>Updated: ${new Date(location.updated_at).toLocaleTimeString()}</div>
        </div>
      `;

      let marker = markersRef.current.get(location.user_id);
      if (!marker) {
        marker = L.marker(nextLatLng, {
          icon: createUserIcon(location.user_id, isCurrentUser, isFocused)
        }).addTo(map);
        marker.bindPopup(popupHtml);
        markersRef.current.set(location.user_id, marker);
      } else {
        marker.setIcon(createUserIcon(location.user_id, isCurrentUser, isFocused));
        animateMarker(marker, nextLatLng);
        marker.setPopupContent(popupHtml);
      }

      let circle = circlesRef.current.get(location.user_id);
      if (!circle) {
        circle = L.circle(nextLatLng, {
          radius: Math.max(location.accuracy || 30, 10),
          color: isCurrentUser ? "#2563eb" : "#16a34a",
          fillColor: isCurrentUser ? "#60a5fa" : "#86efac",
          fillOpacity: 0.16,
          weight: 1
        }).addTo(map);
        circlesRef.current.set(location.user_id, circle);
      } else {
        circle.setLatLng(nextLatLng);
        circle.setRadius(Math.max(location.accuracy || 30, 10));
        circle.setStyle({
          color: isCurrentUser ? "#2563eb" : "#16a34a",
          fillColor: isCurrentUser ? "#60a5fa" : "#86efac"
        });
      }

      const routeHistory = histories[location.user_id] || [];
      let routeLine = linesRef.current.get(location.user_id);

      if (routeHistory.length > 1) {
        // Draw a short breadcrumb trail so movement feels continuous between realtime updates.
        if (!routeLine) {
          routeLine = L.polyline(routeHistory, {
            color: isCurrentUser ? "#2563eb" : "#16a34a",
            weight: isFocused ? 4 : 3,
            opacity: 0.65
          }).addTo(map);
          linesRef.current.set(location.user_id, routeLine);
        } else {
          routeLine.setLatLngs(routeHistory);
          routeLine.setStyle({
            color: isCurrentUser ? "#2563eb" : "#16a34a",
            weight: isFocused ? 4 : 3
          });
        }
      } else if (routeLine) {
        map.removeLayer(routeLine);
        linesRef.current.delete(location.user_id);
      }
    });

    markersRef.current.forEach((marker, userId) => {
      if (!activeUserIds.has(userId)) {
        map.removeLayer(marker);
        markersRef.current.delete(userId);
      }
    });

    circlesRef.current.forEach((circle, userId) => {
      if (!activeUserIds.has(userId)) {
        map.removeLayer(circle);
        circlesRef.current.delete(userId);
      }
    });

    linesRef.current.forEach((line, userId) => {
      if (!activeUserIds.has(userId)) {
        map.removeLayer(line);
        linesRef.current.delete(userId);
      }
    });

    if (!locations.length) return;

    const focusedLocation = focusedUserId
      ? locations.find((location) => location.user_id === focusedUserId)
      : null;

    if (focusedLocation) {
      const nextCenter = L.latLng(focusedLocation.latitude, focusedLocation.longitude);
      const currentCenter = map.getCenter();
      const distanceFromCenter = map.distance(currentCenter, nextCenter);

      if (!hasInitialFitRef.current) {
        map.setView(nextCenter, 15, { animate: false });
        hasInitialFitRef.current = true;
        return;
      }

      if (distanceFromCenter > 80) {
        map.panTo(nextCenter, {
          animate: true,
          duration: 0.8
        });
      }
      return;
    }

    if (!hasInitialFitRef.current) {
      const bounds = L.latLngBounds(
        locations.map((location) => [location.latitude, location.longitude]),
      );
      map.fitBounds(bounds.pad(0.2), { maxZoom: 15 });
      hasInitialFitRef.current = true;
    }
  }, [currentUserId, focusedUserId, histories, locations]);

  return <div ref={containerRef} className="tracking-map" />;
}
