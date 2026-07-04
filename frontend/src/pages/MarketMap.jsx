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
const COMPETITOR_COLOR      = '#EA580C';
const NO_DATA_COLOR         = '#E5E7EB';
const REGION_SELECTED_COLOR = '#C4B5FD'; // indigo-300 — selected counties with no share data

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
      .then(d => {
        console.log('[heatmap] response:', d?.counties?.length ?? 0, 'counties', d?.counties?.[0]);
        if (d?.counties) setCounties(d.counties);
      })
      .catch(err => console.error('[heatmap] fetch failed:', err));
  }, [charterNumber, metric, year, token]);

  return counties;
}

// customRegionFips: string[] of FIPS codes in the active custom region selection.
// Priority order:
//   1. Competitor county  → orange
//   2. In region, has share data → share-based blue (data wins over region marker)
//   3. In region, no share data  → indigo (visually marks the selected county)
//   4. No data                   → grey
function buildColorExpression(heatmapCounties, competitorCounties, customRegionFips = []) {
  const competitorFips  = new Set(competitorCounties.map(c => c.county_fips));
  const regionFipsSet   = new Set(customRegionFips);
  const matchPairs = [];
  for (const county of heatmapCounties) {
    matchPairs.push(county.county_fips, county.market_share);
  }

  // ['to-string', ['id']] normalises feature ID to string — MapLibre coerces
  // numeric-looking GeoJSON string IDs (e.g. "26049") to integers internally.
  const idStr = ['to-string', ['id']];

  // Build the share expression; fallback -1 means "no data"
  const shareExpr = matchPairs.length > 0
    ? ['match', idStr, ...matchPairs, -1]
    : -1;

  const competitorClause = competitorFips.size > 0
    ? [['in', idStr, ['literal', [...competitorFips]]], COMPETITOR_COLOR]
    : [];

  // Counties in the region but without share data should show the region colour
  // so they're visually selected. Counties that DO have share data keep the
  // share colour (priority: data over region marker).
  const regionNoDataClause = regionFipsSet.size > 0
    ? [
        ['all',
          ['in', idStr, ['literal', [...regionFipsSet]]],
          ['<', shareExpr, 0],
        ],
        REGION_SELECTED_COLOR,
      ]
    : [];

  // If there's no match-pairs data at all, fall through to region/no-data colours
  if (matchPairs.length === 0 && regionFipsSet.size === 0) return NO_DATA_COLOR;

  return [
    'case',
    ...competitorClause,
    ...regionNoDataClause,
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
  const mapRef       = useRef(null);
  const loadedRef    = useRef(false);
  const colorExprRef = useRef(colorExpr);
  // Always call the LATEST onCountyClick — geoType changes what it does (county
  // select vs custom-region toggle) but the map closure is created only once.
  const onClickRef   = useRef(onCountyClick);
  colorExprRef.current = colorExpr;
  onClickRef.current   = onCountyClick;

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

      // Apply whichever colorExpr arrived while the style was loading
      try {
        map.setPaintProperty('county-fill', 'fill-color', colorExprRef.current);
      } catch (err) {
        console.error('[MarketMap] setPaintProperty on load failed:', err);
      }

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

        if (fips) onClickRef.current({ fips, name: name || fips });
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
    } catch (err) {
      console.error('[MarketMap] setPaintProperty update failed:', err, colorExpr);
    }
  }, [colorExpr]);
}

// ── Shared autocomplete hook ──────────────────────────────────────────────────

function useGeoSearch(endpoint, query, token) {
  const [results, setResults] = useState([]);
  useEffect(() => {
    if (query.length < 2) { setResults([]); return; }
    const t = setTimeout(() => {
      fetch(`${API}${endpoint}?q=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.ok ? r.json() : [])
        .then(setResults)
        .catch(() => {});
    }, 280);
    return () => clearTimeout(t);
  }, [endpoint, query, token]);
  return results;
}

// ── County search autocomplete ────────────────────────────────────────────────

function CountySearchInput({ geoId, onGeoIdChange, token }) {
  const [query,       setQuery]       = useState('');
  const [displayText, setDisplayText] = useState('');
  const [open,        setOpen]        = useState(false);
  const containerRef = useRef(null);

  useEffect(() => { if (!geoId) { setDisplayText(''); setQuery(''); } }, [geoId]);

  const results = useGeoSearch('/geography/county/search', query, token);
  useEffect(() => { setOpen(results.length > 0); }, [results]);

  useEffect(() => {
    function handleClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function handleSelect(county) {
    setDisplayText(`${county.county_name}, ${county.state_code}`);
    setQuery('');
    setOpen(false);
    onGeoIdChange(county.county_fips);
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1 }}>
      <input
        className="geo-id-input"
        type="text"
        value={displayText || query}
        onChange={e => { setDisplayText(''); setQuery(e.target.value); onGeoIdChange(''); }}
        onFocus={() => query.length >= 2 && results.length > 0 && setOpen(true)}
        placeholder="e.g. Genesee or Oakland"
        aria-label="County search"
        autoComplete="off"
      />
      {open && (
        <div className="msa-dropdown" role="listbox">
          {results.map(c => (
            <div
              key={c.county_fips}
              className="msa-option"
              role="option"
              onMouseDown={() => handleSelect(c)}
            >
              <span className="msa-option-title">{c.county_name}, {c.state_code}</span>
              <span className="msa-option-code">{c.county_fips}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── MSA city-name autocomplete ────────────────────────────────────────────────

function MsaSearchInput({ geoId, onGeoIdChange, token }) {
  const [query,       setQuery]       = useState('');
  const [displayText, setDisplayText] = useState('');
  const [open,        setOpen]        = useState(false);
  const containerRef = useRef(null);

  useEffect(() => { if (!geoId) { setDisplayText(''); setQuery(''); } }, [geoId]);

  const results = useGeoSearch('/geography/msa/search', query, token);
  useEffect(() => { setOpen(results.length > 0); }, [results]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function handleSelect(cbsa) {
    setDisplayText(cbsa.cbsa_title);
    setQuery('');
    setOpen(false);
    onGeoIdChange(cbsa.cbsa_code);
  }

  function handleInput(e) {
    setDisplayText('');
    setQuery(e.target.value);
    onGeoIdChange('');
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1 }}>
      <input
        className="geo-id-input"
        type="text"
        value={displayText || query}
        onChange={handleInput}
        onFocus={() => query.length >= 2 && results.length > 0 && setOpen(true)}
        placeholder="e.g. Detroit or Flint"
        aria-label="MSA search"
        aria-autocomplete="list"
        aria-expanded={open}
        autoComplete="off"
      />
      {open && (
        <div className="msa-dropdown" role="listbox">
          {results.map(cbsa => (
            <div
              key={cbsa.cbsa_code}
              className="msa-option"
              role="option"
              onMouseDown={() => handleSelect(cbsa)}
            >
              <span className="msa-option-title">{cbsa.cbsa_title}</span>
              <span className="msa-option-code">{cbsa.cbsa_code}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Custom Region multi-county picker ────────────────────────────────────────

function CustomRegionInput({ selectedMap, onAdd, onRemove, token }) {
  const [query, setQuery] = useState('');
  const [open,  setOpen]  = useState(false);
  const containerRef = useRef(null);

  const results = useGeoSearch('/geography/county/search', query, token);
  useEffect(() => { setOpen(results.length > 0 && query.length >= 2); }, [results, query]);

  useEffect(() => {
    function handleClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const chips = [...selectedMap.entries()]; // [[fips, label], ...]

  return (
    <div className="custom-region-picker" ref={containerRef}>
      {chips.length > 0 && (
        <div className="cr-chips">
          {chips.map(([fips, label]) => (
            <span key={fips} className="cr-chip">
              {label}
              <button className="cr-chip-remove" onClick={() => onRemove(fips)} title="Remove">×</button>
            </span>
          ))}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <input
          className="geo-id-input"
          type="text"
          value={query}
          onChange={e => { setQuery(e.target.value); }}
          placeholder={chips.length ? 'Add another county…' : 'Search county or click map'}
          autoComplete="off"
        />
        {open && (
          <div className="msa-dropdown" role="listbox">
            {results
              .filter(c => !selectedMap.has(c.county_fips))
              .map(c => (
                <div
                  key={c.county_fips}
                  className="msa-option"
                  role="option"
                  onMouseDown={() => {
                    onAdd(c);
                    setQuery('');
                    setOpen(false);
                  }}
                >
                  <span className="msa-option-title">{c.county_name}, {c.state_code}</span>
                  <span className="msa-option-code">{c.county_fips}</span>
                </div>
              ))}
          </div>
        )}
      </div>
      {chips.length === 0 && (
        <p className="cr-hint">Click counties on the map to add them, or search above.</p>
      )}
    </div>
  );
}

function GeographySelector({ geoType, onGeoTypeChange, geoId, onGeoIdChange, token,
                              customRegion, onAddToRegion, onRemoveFromRegion }) {
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
      {geoType === 'county' ? (
        <CountySearchInput geoId={geoId} onGeoIdChange={onGeoIdChange} token={token} />
      ) : geoType === 'msa' ? (
        <MsaSearchInput geoId={geoId} onGeoIdChange={onGeoIdChange} token={token} />
      ) : geoType === 'custom_region' ? (
        <CustomRegionInput
          selectedMap={customRegion}
          onAdd={onAddToRegion}
          onRemove={onRemoveFromRegion}
          token={token}
        />
      ) : (
        <input
          className="geo-id-input"
          type="text"
          value={geoId}
          onChange={e => onGeoIdChange(e.target.value)}
          placeholder={GEO_TYPES.find(g => g.key === geoType)?.placeholder ?? ''}
          aria-label="Geography ID"
        />
      )}
    </div>
  );
}

function buildPeriodList(latest, count = 16) {
  let year = parseInt(latest.slice(0, 4), 10);
  let q    = parseInt(latest[5], 10);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(`${year}Q${q}`);
    if (--q === 0) { q = 4; year--; }
  }
  return out;
}
const QUICK_PERIODS = buildPeriodList('2026Q1', 16);

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

function ColorLegend({ metric, showRegion }) {
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
        {showRegion && (
          <div className="legend-row">
            <span className="legend-swatch" style={{ backgroundColor: REGION_SELECTED_COLOR }} />
            <span className="legend-label">Custom region</span>
          </div>
        )}
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
  // Custom region: Map<fips, displayLabel> built from search + map clicks
  const [customRegion,   setCustomRegion]  = useState(new Map());

  const mapContainerRef = useRef(null);

  const year = parseInt(period.slice(0, 4), 10);
  // Map always colors by deposits — only metric with branch-level geographic data.
  // activeMetric controls the right-panel competitor table, not the choropleth.
  const heatmapCounties = useHeatmapData(charterNumber, 'deposits', year, token);
  const [competitorCounties, setCompetitorCounties] = useState([]);

  const colorExpr = useMemo(
    () => buildColorExpression(
      heatmapCounties,
      selectedCompId ? competitorCounties : [],
      geoType === 'custom_region' ? [...customRegion.keys()] : [],
    ),
    // customRegionFipsStr tracks actual key changes without re-running on every Map mutation
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [heatmapCounties, competitorCounties, selectedCompId, geoType, customRegionFipsStr],
  );

  function handleGeoTypeChange(newType) {
    setGeoType(newType);
    setGeoId('');
    setSelectedCounty(null);
    setCustomRegion(new Map());
  }

  // Map click routes to: county selection (default) or custom region toggle
  const handleCountyClick = useCallback(({ fips, name }) => {
    if (geoType === 'custom_region') {
      setCustomRegion(prev => {
        const next = new Map(prev);
        if (next.has(fips)) next.delete(fips); else next.set(fips, name);
        return next;
      });
    } else {
      setSelectedCounty({ fips, name });
    }
  }, [geoType]);

  const addToRegion    = useCallback(county => setCustomRegion(prev =>
    new Map(prev).set(county.county_fips, `${county.county_name}, ${county.state_code}`)
  ), []);
  const removeFromRegion = useCallback(fips => setCustomRegion(prev => {
    const next = new Map(prev); next.delete(fips); return next;
  }), []);

  const mapContainerCb = useCallback(el => { mapContainerRef.current = el; }, []);
  useMapLibre(mapContainerRef, handleCountyClick, colorExpr);

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

  const customRegionFipsStr = [...customRegion.keys()].join(',');

  const rightGeoType =
    geoType === 'custom_region' ? 'custom_region' :
    selectedCounty ? 'county' : geoType;
  const rightGeoId =
    geoType === 'custom_region' ? customRegionFipsStr :
    selectedCounty ? selectedCounty.fips : geoId;

  return (
    <div className="market-map-page">
      <div className="market-map-layout">

        {/* Map column (60%) */}
        <div className="map-column">
          <div className="map-controls-overlay">
            <GeographySelector
              geoType={geoType}
              onGeoTypeChange={handleGeoTypeChange}
              geoId={geoId}
              onGeoIdChange={setGeoId}
              token={token}
              customRegion={customRegion}
              onAddToRegion={addToRegion}
              onRemoveFromRegion={removeFromRegion}
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

          <ColorLegend metric="deposits" showRegion={geoType === 'custom_region' && customRegion.size > 0} />
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
