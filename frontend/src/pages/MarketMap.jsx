/**
 * MarketMap — full-screen choropleth map (60%) + right panel (40%).
 *
 * Map (Mapbox GL JS):
 *   Base layer: US counties colored by tenant's deposit market share
 *   Color scale: 0-5% light → 30%+ darkest (blue spectrum)
 *   Competitor overlay: second color layer for a selected competitor
 *   Click county → right panel updates to CompetitorTable for that county
 *
 * GeographySelector: County | MSA | State | Custom Region (polygon draw)
 * Period: latest | select | compare two periods
 *
 * Dependencies to add to package.json:
 *   mapbox-gl             ^3.x
 *   @mapbox/mapbox-gl-draw ^1.x
 *
 * Env vars:
 *   VITE_MAPBOX_TOKEN    — required for map rendering
 *   VITE_API_URL         — backend base URL
 *   VITE_COUNTY_GEOJSON_URL — US counties GeoJSON (default: Plotly CDN)
 */

import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react';
import ConfidenceBadge from '../components/ConfidenceBadge';
import CompetitorTable from '../components/CompetitorTable';

const API              = import.meta.env.VITE_API_URL       ?? '';
const MAPBOX_TOKEN     = import.meta.env.VITE_MAPBOX_TOKEN  ?? '';
const COUNTY_GEOJSON   = import.meta.env.VITE_COUNTY_GEOJSON_URL
  ?? 'https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json';

// ── Color scale (spec: 0-5% light blue → 30%+ darkest) ───────────────────────
const SHARE_COLORS = [
  { threshold: 0.30, color: '#1E3A8A' },   // 30%+   darkest
  { threshold: 0.15, color: '#2563EB' },   // 15-30% dark
  { threshold: 0.05, color: '#93C5FD' },   // 5-15%  medium
  { threshold: 0,    color: '#DBEAFE' },   // 0-5%   light blue
];
const COMPETITOR_COLOR = '#EA580C';   // orange for competitor overlay
const NO_DATA_COLOR    = '#E5E7EB';   // gray for counties with no institution data

function shareToColor(share) {
  for (const { threshold, color } of SHARE_COLORS) {
    if (share >= threshold) return color;
  }
  return NO_DATA_COLOR;
}

// ── Geography type definitions ────────────────────────────────────────────────
const GEO_TYPES = [
  { key: 'county',        label: 'County',        placeholder: 'e.g. 26049 (Genesee MI)' },
  { key: 'msa',           label: 'MSA',           placeholder: 'e.g. 19820 (Detroit)' },
  { key: 'state',         label: 'State',         placeholder: 'e.g. MI' },
  { key: 'custom_region', label: 'Custom Region', placeholder: 'Draw on map' },
];

const METRIC_LABELS = {
  deposits:              'Deposits',
  loans:                 'Loans',
  members:               'Members',
  mortgage_originations: 'Mortgage Originations',
};

// ── Heatmap data hook (base layer — one share value per county) ───────────────
function useHeatmapData(charterNumber, metric, year, token) {
  const [counties, setCounties] = useState([]);   // [{county_fips, market_share, confidence}]

  useEffect(() => {
    if (!charterNumber || !year) return;
    fetch(`${API}/market-share/heatmap?charter_number=${charterNumber}&metric=${metric}&year=${year}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => d?.counties && setCounties(d.counties))
      .catch(() => {});   // graceful — map renders without heatmap if endpoint not ready
  }, [charterNumber, metric, year, token]);

  return counties;
}

// ── Mapbox fill-color expression builder ─────────────────────────────────────
function buildColorExpression(heatmapCounties, competitorCounties) {
  // Build a match expression: county_fips → market_share (0.0-1.0)
  // Then step on that value to get color.
  // For counties with competitor data, use competitor color.

  const competitorFips = new Set(competitorCounties.map(c => c.county_fips));

  const matchPairs = [];
  for (const county of heatmapCounties) {
    matchPairs.push(county.county_fips, county.market_share);
  }

  if (matchPairs.length === 0) {
    return NO_DATA_COLOR;
  }

  const shareExpr = ['match', ['get', 'id'], ...matchPairs, -1];

  // Step expression: -1 (no data) → gray; 0→light; 0.05→medium; 0.15→dark; 0.30→darkest
  return [
    'case',
    // Competitor overlay takes priority
    ['in', ['get', 'id'], ['literal', [...competitorFips]]],
    COMPETITOR_COLOR,
    // Step by share value
    ['<', shareExpr, 0], NO_DATA_COLOR,
    ['step', shareExpr,
      SHARE_COLORS[3].color,
      0.05, SHARE_COLORS[2].color,
      0.15, SHARE_COLORS[1].color,
      0.30, SHARE_COLORS[0].color,
    ],
  ];
}

// ── Mapbox map hook ───────────────────────────────────────────────────────────
function useMapbox(containerRef, onCountyClick, colorExpr) {
  const mapRef    = useRef(null);
  const drawRef   = useRef(null);
  const loadedRef = useRef(false);

  // Initialize map once
  useEffect(() => {
    if (!MAPBOX_TOKEN || !containerRef.current || mapRef.current) return;

    import(/* @vite-ignore */ 'mapbox-gl').then(({ default: mapboxgl }) => {
      mapboxgl.accessToken = MAPBOX_TOKEN;

      const map = new mapboxgl.Map({
        container: containerRef.current,
        style:     'mapbox://styles/mapbox/light-v11',
        center:    [-96, 39],
        zoom:      4,
      });
      mapRef.current = map;

      map.on('load', () => {
        // Add US county boundaries as a GeoJSON source
        map.addSource('counties', {
          type: 'geojson',
          data: COUNTY_GEOJSON,
          promoteId: 'id',   // use feature 'id' property as feature state key
        });

        // Fill layer — choropleth
        map.addLayer({
          id:     'county-fill',
          type:   'fill',
          source: 'counties',
          paint:  {
            'fill-color':   NO_DATA_COLOR,
            'fill-opacity': 0.75,
          },
        });

        // Hover highlight
        map.addLayer({
          id:     'county-fill-hover',
          type:   'fill',
          source: 'counties',
          paint:  {
            'fill-color':   '#1E40AF',
            'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.3, 0],
          },
        });

        // County borders
        map.addLayer({
          id:     'county-borders',
          type:   'line',
          source: 'counties',
          paint:  {
            'line-color': '#CBD5E1',
            'line-width': 0.5,
          },
        });

        // Selected county border
        map.addLayer({
          id:     'county-selected',
          type:   'line',
          source: 'counties',
          paint:  {
            'line-color': '#1D4ED8',
            'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2.5, 0],
          },
        });

        loadedRef.current = true;

        // Click handler
        let hoveredId = null;
        map.on('mousemove', 'county-fill', (e) => {
          if (e.features.length > 0) {
            if (hoveredId !== null) {
              map.setFeatureState({ source: 'counties', id: hoveredId }, { hover: false });
            }
            hoveredId = e.features[0].id;
            map.setFeatureState({ source: 'counties', id: hoveredId }, { hover: true });
          }
        });
        map.on('mouseleave', 'county-fill', () => {
          if (hoveredId !== null) {
            map.setFeatureState({ source: 'counties', id: hoveredId }, { hover: false });
          }
          hoveredId = null;
        });

        let selectedId = null;
        map.on('click', 'county-fill', (e) => {
          if (!e.features.length) return;
          const fips    = String(e.features[0].id ?? e.features[0].properties?.id ?? '');
          const feature = e.features[0];

          if (selectedId !== null) {
            map.setFeatureState({ source: 'counties', id: selectedId }, { selected: false });
          }
          selectedId = feature.id;
          map.setFeatureState({ source: 'counties', id: selectedId }, { selected: true });

          onCountyClick({ fips, name: feature.properties?.name ?? fips });
        });

        map.on('mouseenter', 'county-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'county-fill', () => { map.getCanvas().style.cursor = ''; });
      });
    }).catch(err => console.error('Mapbox GL import failed:', err));

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
  }, []);   // init once

  // Update fill-color when color expression changes
  useEffect(() => {
    if (!loadedRef.current || !mapRef.current) return;
    try {
      mapRef.current.setPaintProperty('county-fill', 'fill-color', colorExpr);
    } catch (_) {}
  }, [colorExpr]);

  // Expose draw control toggle
  const startDraw = useCallback(() => {
    if (!mapRef.current) return;
    import(/* @vite-ignore */ '@mapbox/mapbox-gl-draw').then(({ default: MapboxDraw }) => {
      if (drawRef.current) {
        mapRef.current.removeControl(drawRef.current);
      }
      const draw = new MapboxDraw({
        displayControlsDefault: false,
        controls: { polygon: true, trash: true },
      });
      drawRef.current = draw;
      mapRef.current.addControl(draw);

      mapRef.current.on('draw.create', (e) => {
        const polygon = e.features[0];
        // TODO: POST polygon to /market-share/custom-region to get UUID back
        // For now: pass the raw GeoJSON to parent so it can extract county FIPS
        window.dispatchEvent(new CustomEvent('market-map:polygon-drawn', { detail: polygon }));
      });
    }).catch(() => {
      // mapbox-gl-draw not installed; show manual FIPS entry for custom regions
      window.dispatchEvent(new CustomEvent('market-map:draw-unavailable'));
    });
  }, []);

  const stopDraw = useCallback(() => {
    if (!mapRef.current || !drawRef.current) return;
    mapRef.current.removeControl(drawRef.current);
    drawRef.current = null;
  }, []);

  return { startDraw, stopDraw };
}

// ── GeographySelector (segmented control) ────────────────────────────────────
function GeographySelector({ geoType, onGeoTypeChange, geoId, onGeoIdChange, onStartDraw }) {
  return (
    <div className="geo-selector">
      <div className="geo-type-tabs" role="group" aria-label="Geography type">
        {GEO_TYPES.map(({ key, label }) => (
          <button
            key={key}
            className={`geo-tab ${geoType === key ? 'geo-tab--active' : ''}`}
            onClick={() => onGeoTypeChange(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {geoType !== 'custom_region' ? (
        <input
          className="geo-id-input"
          type="text"
          value={geoId}
          onChange={e => onGeoIdChange(e.target.value)}
          placeholder={GEO_TYPES.find(g => g.key === geoType)?.placeholder ?? ''}
          aria-label="Geography ID"
        />
      ) : (
        <button className="draw-polygon-btn" onClick={onStartDraw}>
          ✏ Draw region on map
        </button>
      )}
    </div>
  );
}

// ── Period selector ───────────────────────────────────────────────────────────
const QUICK_PERIODS = ['2026Q1', '2025Q4', '2025Q3', '2025Q2', '2025Q1'];

function PeriodSelector({ period, onPeriodChange, compareMode, comparePeriod, onCompareModeChange, onComparePeriodChange }) {
  return (
    <div className="period-selector-panel">
      <div className="period-row">
        <label>Period</label>
        <select value={period} onChange={e => onPeriodChange(e.target.value)}>
          {QUICK_PERIODS.map(p => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <label className="compare-toggle">
          <input
            type="checkbox"
            checked={compareMode}
            onChange={e => onCompareModeChange(e.target.checked)}
          />
          Compare to:
        </label>
        {compareMode && (
          <select value={comparePeriod} onChange={e => onComparePeriodChange(e.target.value)}>
            {QUICK_PERIODS.filter(p => p !== period).map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

// ── Color scale legend ────────────────────────────────────────────────────────
function ColorLegend({ metric }) {
  return (
    <div className="color-legend">
      <div className="legend-title">{METRIC_LABELS[metric] ?? metric} Share</div>
      <div className="legend-scale">
        {[
          { color: SHARE_COLORS[0].color, label: '30%+' },
          { color: SHARE_COLORS[1].color, label: '15–30%' },
          { color: SHARE_COLORS[2].color, label: '5–15%' },
          { color: SHARE_COLORS[3].color, label: '0–5%' },
          { color: NO_DATA_COLOR,         label: 'No data' },
        ].map(({ color, label }) => (
          <div key={label} className="legend-row">
            <span className="legend-swatch" style={{ backgroundColor: color }} />
            <span className="legend-label">{label}</span>
          </div>
        ))}
        <div className="legend-row">
          <span className="legend-swatch" style={{ backgroundColor: COMPETITOR_COLOR }} />
          <span className="legend-label">Selected competitor</span>
        </div>
      </div>
    </div>
  );
}

// ── Metric tab bar (for map-level metric, separate from table tabs) ───────────
function MapMetricBar({ activeMetric, onChange }) {
  return (
    <div className="map-metric-bar">
      {Object.entries(METRIC_LABELS).map(([key, label]) => (
        <button
          key={key}
          className={`map-metric-btn ${activeMetric === key ? 'map-metric-btn--active' : ''}`}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MarketMap({ charterNumber, token }) {
  const [geoType,         setGeoType]        = useState('county');
  const [geoId,           setGeoId]          = useState('');
  const [period,          setPeriod]         = useState('2026Q1');
  const [compareMode,     setCompareMode]    = useState(false);
  const [comparePeriod,   setComparePeriod]  = useState('2025Q1');
  const [activeMetric,    setActiveMetric]   = useState('deposits');
  const [selectedCounty,  setSelectedCounty] = useState(null);   // {fips, name}
  const [selectedCompId,  setSelectedCompId] = useState(null);   // charter_or_cert
  const [drawUnavailable, setDrawUnavailable] = useState(false);

  const mapContainerRef = useRef(null);

  // Heatmap: this institution's share per county (drives base layer color)
  const year = parseInt(period.slice(0, 4), 10);
  const heatmapCounties = useHeatmapData(charterNumber, activeMetric, year, token);

  // Competitor heatmap: show competitor's county footprint in orange
  const [competitorCounties, setCompetitorCounties] = useState([]);

  // Color expression — recomputed when heatmap or competitor changes
  const colorExpr = useMemo(
    () => buildColorExpression(heatmapCounties, selectedCompId ? competitorCounties : []),
    [heatmapCounties, competitorCounties, selectedCompId]
  );

  // Map
  const mapContainerCb = useCallback(el => { mapContainerRef.current = el; }, []);
  const { startDraw, stopDraw } = useMapbox(mapContainerRef, setSelectedCounty, colorExpr);

  // Listen for polygon draw events
  useEffect(() => {
    const handler = (e) => {
      const polygon = e.detail;
      // TODO: POST polygon to /market-share/custom-region → get UUID back
      // For now: show the GeoJSON bounding box coordinates
      console.info('Polygon drawn:', JSON.stringify(polygon.geometry));
      // Set a placeholder geo_id until backend integration is complete
      setGeoId(`polygon_${Date.now()}`);
    };
    const unavailHandler = () => setDrawUnavailable(true);
    window.addEventListener('market-map:polygon-drawn', handler);
    window.addEventListener('market-map:draw-unavailable', unavailHandler);
    return () => {
      window.removeEventListener('market-map:polygon-drawn', handler);
      window.removeEventListener('market-map:draw-unavailable', unavailHandler);
    };
  }, []);

  // When geoType changes to custom_region, start draw tool
  useEffect(() => {
    if (geoType === 'custom_region') {
      startDraw();
    } else {
      stopDraw();
    }
  }, [geoType]);

  // Competitor overlay: fetch competitor's heatmap when one is selected
  useEffect(() => {
    if (!selectedCompId || !selectedCompId.startsWith('ncua:')) {
      setCompetitorCounties([]);
      return;
    }
    const compCharter = parseInt(selectedCompId.replace('ncua:', ''), 10);
    fetch(`${API}/market-share/heatmap?charter_number=${compCharter}&metric=${activeMetric}&year=${year}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => d?.counties && setCompetitorCounties(d.counties))
      .catch(() => setCompetitorCounties([]));
  }, [selectedCompId, activeMetric, year, token]);

  // Determine active geography for right panel:
  // if user clicked a county on the map, use that; otherwise use the search box value
  const rightGeoType = selectedCounty ? 'county'  : geoType;
  const rightGeoId   = selectedCounty ? selectedCounty.fips : geoId;

  const hasMapboxToken = Boolean(MAPBOX_TOKEN);

  return (
    <div className="market-map-page">
      {/* ── Full-page layout: map 60% | panel 40% ── */}
      <div className="market-map-layout">

        {/* ── Left: Map (60%) ── */}
        <div className="map-column">

          {/* ── Top controls overlay ── */}
          <div className="map-controls-overlay">
            <GeographySelector
              geoType={geoType}
              onGeoTypeChange={setGeoType}
              geoId={geoId}
              onGeoIdChange={setGeoId}
              onStartDraw={startDraw}
            />
            <PeriodSelector
              period={period}
              onPeriodChange={setPeriod}
              compareMode={compareMode}
              comparePeriod={comparePeriod}
              onCompareModeChange={setCompareMode}
              onComparePeriodChange={setComparePeriod}
            />
            <MapMetricBar activeMetric={activeMetric} onChange={setActiveMetric} />
          </div>

          {/* ── Map container ── */}
          {hasMapboxToken ? (
            <div ref={mapContainerCb} className="mapbox-container" aria-label="Market share map" />
          ) : (
            <div className="map-placeholder">
              <p>Map requires <code>VITE_MAPBOX_TOKEN</code> environment variable.</p>
              <p>Add <code>mapbox-gl</code> and <code>@mapbox/mapbox-gl-draw</code> to your dependencies.</p>
            </div>
          )}

          {/* ── Draw unavailable notice ── */}
          {drawUnavailable && geoType === 'custom_region' && (
            <div className="draw-notice">
              Polygon draw tool requires <code>@mapbox/mapbox-gl-draw</code>.
              Enter a geography ID manually instead.
              <input
                className="geo-id-input"
                placeholder="Enter custom region UUID"
                onChange={e => setGeoId(e.target.value)}
              />
            </div>
          )}

          {/* ── Selected county label ── */}
          {selectedCounty && (
            <div className="selected-county-label">
              Viewing: <strong>{selectedCounty.name}</strong> ({selectedCounty.fips})
              <button
                className="clear-btn"
                onClick={() => setSelectedCounty(null)}
                title="Clear selection"
              >
                ×
              </button>
            </div>
          )}

          {/* ── Color legend ── */}
          <ColorLegend metric={activeMetric} />
        </div>

        {/* ── Right panel (40%) ── */}
        <div className="map-right-panel">
          {selectedCounty && (
            <div className="panel-geo-header">
              <h2 className="panel-title">{selectedCounty.name}</h2>
              <span className="panel-fips">FIPS {selectedCounty.fips}</span>
            </div>
          )}

          <CompetitorTable
            geoType={rightGeoType}
            geoId={rightGeoId}
            period={period}
            charterNumber={charterNumber}
            token={token}
            defaultMetric={activeMetric}
          />

          {/* ── Compare mode: second period table ── */}
          {compareMode && comparePeriod && rightGeoId && (
            <div className="compare-panel">
              <div className="compare-header">Comparison: {comparePeriod}</div>
              <CompetitorTable
                geoType={rightGeoType}
                geoId={rightGeoId}
                period={comparePeriod}
                charterNumber={charterNumber}
                token={token}
                defaultMetric={activeMetric}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
