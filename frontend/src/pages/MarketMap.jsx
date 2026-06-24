/**
 * MarketMap — choropleth map (60%) + right panel (40%).
 *
 * Map: MapLibre GL JS (free, no token) + CartoDB Positron tiles
 * Base layer: US counties colored by deposit market share
 * Click county → right panel updates to CompetitorTable
 *
 * Geography: County | MSA | State | Custom Region
 */

import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react';

// maplibre-gl loaded via CDN in index.html — available as window.maplibregl
const maplibregl = window.maplibregl;
import ConfidenceBadge from '../components/ConfidenceBadge';
import CompetitorTable from '../components/CompetitorTable';

const API            = import.meta.env.VITE_API_URL ?? '';
const COUNTY_GEOJSON = import.meta.env.VITE_COUNTY_GEOJSON_URL
  ?? 'https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json';

// Free CartoDB Positron style — no token required
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

// Color scale
const SHARE_COLORS = [
  { threshold: 0.30, color: '#1E3A8A' },
  { threshold: 0.15, color: '#2563EB' },
  { threshold: 0.05, color: '#93C5FD' },
  { threshold: 0,    color: '#DBEAFE' },
];
const COMPETITOR_COLOR = '#EA580C';
const NO_DATA_COLOR    = '#E5E7EB';

function shareToColor(share) {
  for (const { threshold, color } of SHARE_COLORS) {
    if (share >= threshold) return color;
  }
  return NO_DATA_COLOR;
}

const GEO_TYPES = [
  { key: 'county',        label: 'County',        placeholder: 'e.g. 26049 (Genesee MI)' },
  { key: 'msa',           label: 'MSA',           placeholder: 'e.g. 19820 (Detroit)' },
  { key: 'state',         label: 'State',         placeholder: 'e.g. MI' },
  { key: 'custom_region', label: 'Custom Region', placeholder: 'Enter county FIPS list' },
];

const METRIC_LABELS = {
  deposits:              'Deposits',
  loans:                 'Loans',
  members:               'Members',
  mortgage_originations: 'Mortgage Originations',
};

function useHeatmapData(charterNumber, metric, year, token) {
  const [counties, setCounties] = useState([]);

  useEffect(() => {
    if (!charterNumber || !year) return;
    fetch(`${API}/market-share/heatmap?charter_number=${charterNumber}&metric=${metric}&year=${year}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => d?.counties && setCounties(d.counties))
      .catch(() => {});
  }, [charterNumber, metric, year, token]);

  return counties;
}

function buildColorExpression(heatmapCounties, competitorCounties) {
  const competitorFips = new Set(competitorCounties.map(c => c.county_fips));
  const matchPairs = [];
  for (const county of heatmapCounties) {
    matchPairs.push(county.county_fips, county.market_share);
  }
  if (matchPairs.length === 0) return NO_DATA_COLOR;

  const shareExpr = ['match', ['get', 'id'], ...matchPairs, -1];
  return [
    'case',
    ['in', ['get', 'id'], ['literal', [...competitorFips]]],
    COMPETITOR_COLOR,
    ['<', shareExpr, 0], NO_DATA_COLOR,
    ['step', shareExpr,
      SHARE_COLORS[3].color,
      0.05, SHARE_COLORS[2].color,
      0.15, SHARE_COLORS[1].color,
      0.30, SHARE_COLORS[0].color,
    ],
  ];
}

function useMapLibre(containerRef, onCountyClick, colorExpr) {
  const mapRef    = useRef(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style:     MAP_STYLE,
      center:    [-96, 39],
      zoom:      4,
    });
    mapRef.current = map;

    map.on('load', () => {
      // Plotly GeoJSON has top-level "id" (FIPS string) on each feature —
      // MapLibre uses that natively. Do NOT set promoteId, which would override
      // with properties.id (doesn't exist) and blank out feature.id on click events.
      map.addSource('counties', {
        type: 'geojson',
        data: COUNTY_GEOJSON,
      });

      map.addLayer({
        id:     'county-fill',
        type:   'fill',
        source: 'counties',
        paint:  {
          'fill-color':   NO_DATA_COLOR,
          'fill-opacity': 0.75,
        },
      });

      map.addLayer({
        id:     'county-fill-hover',
        type:   'fill',
        source: 'counties',
        paint:  {
          'fill-color':   '#1E40AF',
          'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.3, 0],
        },
      });

      map.addLayer({
        id:     'county-borders',
        type:   'line',
        source: 'counties',
        paint:  { 'line-color': '#CBD5E1', 'line-width': 0.5 },
      });

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

      // Helper: extract FIPS from a clicked feature
      // Plotly GeoJSON stores FIPS as the top-level "id" string on each feature.
      // MapLibre exposes this as feature.id in click/mousemove events.
      const getFips = (f) =>
        String(f.id ?? f.properties?.GEO_ID ?? f.properties?.GEOID ?? f.properties?.id ?? '');

      const getName = (f, fips) =>
        f.properties?.name ?? f.properties?.NAME ?? fips;

      let hoveredId = null;
      map.on('mousemove', 'county-fill', (e) => {
        if (e.features.length > 0) {
          if (hoveredId !== null) {
            map.setFeatureState({ source: 'counties', id: hoveredId }, { hover: false });
          }
          hoveredId = e.features[0].id;
          if (hoveredId != null) {
            map.setFeatureState({ source: 'counties', id: hoveredId }, { hover: true });
          }
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
        const feature = e.features[0];
        const fips    = getFips(feature);
        const name    = getName(feature, fips);

        if (selectedId !== null) {
          map.setFeatureState({ source: 'counties', id: selectedId }, { selected: false });
        }
        selectedId = feature.id;
        if (selectedId != null) {
          map.setFeatureState({ source: 'counties', id: selectedId }, { selected: true });
        }

        if (fips) onCountyClick({ fips, name: name || fips });
      });

      map.on('mouseenter', 'county-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'county-fill', () => { map.getCanvas().style.cursor = ''; });
    });

    map.on('error', (e) => console.error('MapLibre error:', e.error));

    return () => {
      map.remove();
      mapRef.current  = null;
      loadedRef.current = false;
    };
  }, []);

  // Update fill-color when heatmap data changes
  useEffect(() => {
    if (!loadedRef.current || !mapRef.current) return;
    try {
      mapRef.current.setPaintProperty('county-fill', 'fill-color', colorExpr);
    } catch (_) {}
  }, [colorExpr]);
}

function GeographySelector({ geoType, onGeoTypeChange, geoId, onGeoIdChange }) {
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
      <input
        className="geo-id-input"
        type="text"
        value={geoId}
        onChange={e => onGeoIdChange(e.target.value)}
        placeholder={GEO_TYPES.find(g => g.key === geoType)?.placeholder ?? ''}
        aria-label="Geography ID"
      />
    </div>
  );
}

const QUICK_PERIODS = ['2026Q1', '2025Q4', '2025Q3', '2025Q2', '2025Q1'];

function PeriodSelector({ period, onPeriodChange, compareMode, comparePeriod, onCompareModeChange, onComparePeriodChange }) {
  return (
    <div className="period-selector-panel">
      <div className="period-row">
        <label>Period</label>
        <select value={period} onChange={e => onPeriodChange(e.target.value)}>
          {QUICK_PERIODS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <label className="compare-toggle">
          <input type="checkbox" checked={compareMode} onChange={e => onCompareModeChange(e.target.checked)} />
          Compare to:
        </label>
        {compareMode && (
          <select value={comparePeriod} onChange={e => onComparePeriodChange(e.target.value)}>
            {QUICK_PERIODS.filter(p => p !== period).map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}

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

export default function MarketMap({ charterNumber, token }) {
  const [geoType,        setGeoType]       = useState('county');
  const [geoId,          setGeoId]         = useState('');
  const [period,         setPeriod]        = useState('2026Q1');
  const [compareMode,    setCompareMode]   = useState(false);
  const [comparePeriod,  setComparePeriod] = useState('2025Q1');
  const [activeMetric,   setActiveMetric]  = useState('deposits');
  const [selectedCounty, setSelectedCounty] = useState(null);
  const [selectedCompId, setSelectedCompId] = useState(null);

  const mapContainerRef = useRef(null);

  const year = parseInt(period.slice(0, 4), 10);
  const heatmapCounties = useHeatmapData(charterNumber, activeMetric, year, token);
  const [competitorCounties, setCompetitorCounties] = useState([]);

  const colorExpr = useMemo(
    () => buildColorExpression(heatmapCounties, selectedCompId ? competitorCounties : []),
    [heatmapCounties, competitorCounties, selectedCompId],
  );

  const mapContainerCb = useCallback(el => { mapContainerRef.current = el; }, []);
  useMapLibre(mapContainerRef, setSelectedCounty, colorExpr);

  useEffect(() => {
    if (!selectedCompId?.startsWith('ncua:')) {
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

  const rightGeoType = selectedCounty ? 'county' : geoType;
  const rightGeoId   = selectedCounty ? selectedCounty.fips : geoId;

  return (
    <div className="market-map-page">
      <div className="market-map-layout">

        {/* Map column (60%) */}
        <div className="map-column">
          <div className="map-controls-overlay">
            <GeographySelector
              geoType={geoType}
              onGeoTypeChange={setGeoType}
              geoId={geoId}
              onGeoIdChange={setGeoId}
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

          <div ref={mapContainerCb} className="mapbox-container" aria-label="Market share map" />

          {selectedCounty && (
            <div className="selected-county-label">
              Viewing: <strong>{selectedCounty.name}</strong> ({selectedCounty.fips})
              <button className="clear-btn" onClick={() => setSelectedCounty(null)} title="Clear">×</button>
            </div>
          )}

          <ColorLegend metric={activeMetric} />
        </div>

        {/* Right panel (40%) */}
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

          {!rightGeoId && !selectedCounty && (
            <p className="map-empty-hint">
              Click a county on the map or enter a geography to see the competitive breakdown.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
