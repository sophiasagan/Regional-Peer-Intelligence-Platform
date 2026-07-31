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
const REGION_SELECTED_COLOR = '#C4B5FD'; // indigo-300 — custom region selected counties
const STATE_NO_DATA_COLOR   = '#BFDBFE'; // blue-200 — in-state counties with no share data

// Approximate bounding boxes [minLng, minLat, maxLng, maxLat] per 2-digit state FIPS
const STATE_BBOX = {
  '01':[-88.5,30.1,-84.9,35.0],'02':[-180,51.2,-130,71.4],'04':[-114.8,31.3,-109.0,37.0],
  '05':[-94.6,33.0,-89.6,36.5],'06':[-124.5,32.5,-114.1,42.0],'08':[-109.1,36.9,-102.0,41.0],
  '09':[-73.7,40.9,-71.8,42.1],'10':[-75.8,38.4,-75.0,39.8],'11':[-77.1,38.8,-76.9,39.0],
  '12':[-87.6,24.5,-80.0,31.0],'13':[-85.6,30.4,-80.8,35.0],'15':[-178.3,18.9,-154.8,28.4],
  '16':[-117.2,41.9,-111.0,49.0],'17':[-91.5,36.9,-87.5,42.5],'18':[-88.1,37.8,-84.8,41.8],
  '19':[-96.6,40.4,-90.1,43.5],'20':[-102.1,37.0,-94.6,40.0],'21':[-89.6,36.5,-81.9,39.1],
  '22':[-94.0,28.9,-88.8,33.0],'23':[-71.1,43.1,-66.9,47.5],'24':[-79.5,37.9,-75.0,39.7],
  '25':[-73.5,41.2,-69.9,42.9],'26':[-90.4,41.7,-82.4,48.3],'27':[-97.2,43.5,-89.5,49.4],
  '28':[-91.7,30.2,-88.1,35.0],'29':[-95.8,36.0,-89.1,40.6],'30':[-116.1,44.4,-104.0,49.0],
  '31':[-104.1,40.0,-95.3,43.0],'32':[-120.0,35.0,-114.0,42.0],'33':[-72.6,42.7,-70.7,45.3],
  '34':[-75.6,38.9,-73.9,41.4],'35':[-109.1,31.3,-103.0,37.0],'36':[-79.8,40.5,-71.9,45.0],
  '37':[-84.3,33.8,-75.5,36.6],'38':[-104.1,45.9,-96.6,49.0],'39':[-84.8,38.4,-80.5,42.3],
  '40':[-103.0,33.6,-94.4,37.0],'41':[-124.6,42.0,-116.5,46.3],'42':[-80.5,39.7,-74.7,42.3],
  '44':[-71.9,41.1,-71.1,42.0],'45':[-83.4,32.0,-78.5,35.2],'46':[-104.1,42.5,-96.4,45.9],
  '47':[-90.3,34.9,-81.6,36.7],'48':[-106.6,25.8,-93.5,36.5],'49':[-114.1,37.0,-109.0,42.0],
  '50':[-73.4,42.7,-71.5,45.0],'51':[-83.7,36.5,-75.2,39.5],'53':[-124.8,45.5,-116.9,49.0],
  '54':[-82.6,37.2,-77.7,40.6],'55':[-92.9,42.5,-86.8,47.1],'56':[-111.1,41.0,-104.1,45.0],
};

// Quantile breaks (p25/p50/p75) from actual heatmap share values for data-driven coloring.
// Returns null when fewer than 4 data points — callers fall back to fixed thresholds.
function computeBreaks(counties) {
  const vals = counties
    .map(c => c.market_share)
    .filter(v => v != null && v > 0)
    .sort((a, b) => a - b);
  if (vals.length < 4) return null;
  const at = p => vals[Math.min(Math.floor(p * vals.length), vals.length - 1)];
  return [at(0.25), at(0.50), at(0.75)];
}

function shareToColor(share) {
  for (const { threshold, color } of SHARE_COLORS) {
    if (share >= threshold) return color;
  }
  return NO_DATA_COLOR;
}

const GEO_TYPES = [
  { key: 'county',        label: 'County',        placeholder: 'e.g. 26049 (Genesee MI)' },
  { key: 'msa',           label: 'MSA',           placeholder: 'e.g. 19820 (Detroit)' },
  { key: 'state',         label: 'State',         placeholder: 'Select a state' },
  { key: 'custom_region', label: 'Custom Region', placeholder: 'Enter county FIPS list' },
];

// Maps 2-digit state FIPS (from county FIPS prefix) → 2-letter state abbreviation.
// Used to derive state from a clicked county feature.
const STATE_FIPS_TO_ABBR = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT',
  '10':'DE','11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL',
  '18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD',
  '25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE',
  '32':'NV','33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND',
  '39':'OH','40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD',
  '47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV',
  '55':'WI','56':'WY',
};

const US_STATES = [
  ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],
  ['CA','California'],['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],
  ['DC','DC'],['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],['ID','Idaho'],
  ['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],
  ['KY','Kentucky'],['LA','Louisiana'],['ME','Maine'],['MD','Maryland'],
  ['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],['MS','Mississippi'],
  ['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],
  ['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],['NY','New York'],
  ['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],['OK','Oklahoma'],
  ['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],
  ['SD','South Dakota'],['TN','Tennessee'],['TX','Texas'],['UT','Utah'],
  ['VT','Vermont'],['VA','Virginia'],['WA','Washington'],['WV','West Virginia'],
  ['WI','Wisconsin'],['WY','Wyoming'],
];

const METRIC_LABELS = {
  deposits:              'Deposits',
  loans:                 'Loans',
  members:               'Members',
  mortgage_originations: 'Mortgage Originations',
};

// Legend titles — lowercase "share" suffix, sentence-case metric name
const LEGEND_TITLES = {
  deposits:              'Deposits share',
  loans:                 'Loans share',
  members:               'Members share',
  mortgage_originations: 'Mortgage originations share',
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

// stateFips: 2-digit state FIPS string (e.g. '26') — when set, in-state counties
// with no share data get STATE_NO_DATA_COLOR instead of plain grey so the state
// shape is visible even where the institution has no deposits.
function buildColorExpression(heatmapCounties, competitorCounties, stateFips = null, breaks = null) {
  const competitorFips = new Set(competitorCounties.map(c => c.county_fips));
  const matchPairs = [];
  for (const county of heatmapCounties) {
    matchPairs.push(county.county_fips, county.market_share);
  }

  // ['to-string', ['id']] normalises feature ID to string — MapLibre coerces
  // numeric-looking GeoJSON string IDs (e.g. "26049") to integers internally.
  const idStr = ['to-string', ['id']];

  if (matchPairs.length === 0 && competitorFips.size === 0 && !stateFips) return NO_DATA_COLOR;

  const shareExpr = matchPairs.length > 0
    ? ['match', idStr, ...matchPairs, -1]
    : -1;

  const competitorClause = competitorFips.size > 0
    ? [['in', idStr, ['literal', [...competitorFips]]], COMPETITOR_COLOR]
    : [];

  // In-state counties with no data get a distinct light-blue fill so the state
  // boundary is visible.
  // floor(county_fips_int / 1000) = state FIPS as integer — avoids leading-zero
  // truncation bug: MapLibre coerces "05001" → 5001, so slice("5001",0,2)="50"
  // would falsely match Vermont. Integer division: floor(5001/1000)=5 ≠ 50.
  const stateFipsExpr = ['floor', ['/', ['to-number', ['id']], 1000]];
  const stateNoDataClause = stateFips != null
    ? [
        ['all',
          ['==', stateFipsExpr, stateFips],
          ['<', shareExpr, 0],
        ],
        STATE_NO_DATA_COLOR,
      ]
    : [];

  const [b1, b2, b3] = breaks ?? [0.05, 0.15, 0.30];
  return [
    'case',
    ...competitorClause,
    ...stateNoDataClause,
    ['<', shareExpr, 0], NO_DATA_COLOR,
    ['step', shareExpr,
      SHARE_COLORS[3].color,
      b1, SHARE_COLORS[2].color,
      b2, SHARE_COLORS[1].color,
      b3, SHARE_COLORS[0].color,
    ],
  ];
}

// Returns a MapLibre line-width expression for the county-region-outline layer.
// In custom_region mode: 3px border on each selected county.
// In state mode: 2px border on every county in the state.
// Uses floor(fips_int / 1000) to derive state — avoids leading-zero truncation
// that occurs when MapLibre coerces string IDs like "05001" to integer 5001.
function buildOutlineExpr(customRegionFips, stateFips) {
  if (customRegionFips && customRegionFips.length > 0) {
    return ['case', ['in', ['to-string', ['id']], ['literal', customRegionFips]], 3, 0];
  }
  if (stateFips != null) {
    return ['case', ['==', ['floor', ['/', ['to-number', ['id']], 1000]], stateFips], 2, 0];
  }
  return 0;
}

function useMapLibre(containerRef, onCountyClick, colorExpr, regionOutlineExpr) {
  const mapRef            = useRef(null);
  const loadedRef         = useRef(false);
  const pendingFitRef     = useRef(null);
  const colorExprRef      = useRef(colorExpr);
  const regionOutlineRef  = useRef(regionOutlineExpr);
  // Always call the LATEST onCountyClick — geoType changes what it does (county
  // select vs custom-region toggle) but the map closure is created only once.
  const onClickRef        = useRef(onCountyClick);
  colorExprRef.current     = colorExpr;
  regionOutlineRef.current = regionOutlineExpr;
  onClickRef.current       = onCountyClick;

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

      // Thick indigo border for custom-region counties — sits above all other layers
      map.addLayer({
        id:     'county-region-outline',
        type:   'line',
        source: 'counties',
        paint:  {
          'line-color': REGION_SELECTED_COLOR,
          'line-width': 0,
        },
      });

      loadedRef.current = true;

      // Apply whichever colorExpr / regionOutlineExpr arrived while the style was loading
      try {
        map.setPaintProperty('county-fill', 'fill-color', colorExprRef.current);
        map.setPaintProperty('county-region-outline', 'line-width', regionOutlineRef.current);
      } catch (err) {
        console.error('[MarketMap] setPaintProperty on load failed:', err);
      }

      if (pendingFitRef.current) {
        try { map.fitBounds(pendingFitRef.current, { padding: 50, duration: 800 }); } catch (_) {}
        pendingFitRef.current = null;
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

  // Update region outline when custom region selection changes
  useEffect(() => {
    if (!loadedRef.current || !mapRef.current) return;
    try {
      mapRef.current.setPaintProperty('county-region-outline', 'line-width', regionOutlineExpr);
    } catch (err) {
      console.error('[MarketMap] region outline update failed:', err);
    }
  }, [regionOutlineExpr]);

  const fitBounds = useCallback((bounds) => {
    if (loadedRef.current && mapRef.current) {
      try { mapRef.current.fitBounds(bounds, { padding: 50, duration: 800 }); } catch (_) {}
    } else {
      pendingFitRef.current = bounds;
    }
  }, []);

  return { fitBounds };
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

function StateSelectInput({ geoId, onGeoIdChange }) {
  return (
    <select
      className="geo-id-input"
      value={geoId}
      onChange={e => onGeoIdChange(e.target.value)}
      aria-label="Select state"
    >
      <option value="">Select a state…</option>
      {US_STATES.map(([abbr, name]) => (
        <option key={abbr} value={abbr}>{abbr} — {name}</option>
      ))}
    </select>
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
      ) : geoType === 'state' ? (
        <StateSelectInput geoId={geoId} onGeoIdChange={onGeoIdChange} />
      ) : geoType === 'custom_region' ? (
        <CustomRegionInput
          selectedMap={customRegion}
          onAdd={onAddToRegion}
          onRemove={onRemoveFromRegion}
          token={token}
        />
      ) : null}
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

function ColorLegend({ metric, breaks }) {
  const [b1, b2, b3] = breaks ?? [0.05, 0.15, 0.30];
  const pct = v => `${(v * 100).toFixed(1)}%`;
  return (
    <div className="color-legend">
      <div className="legend-title">{LEGEND_TITLES[metric] ?? `${metric} share`}</div>
      <div className="legend-scale">
        {[
          { color: SHARE_COLORS[0].color, label: `${pct(b3)}+` },
          { color: SHARE_COLORS[1].color, label: `${pct(b2)}–${pct(b3)}` },
          { color: SHARE_COLORS[2].color, label: `${pct(b1)}–${pct(b2)}` },
          { color: SHARE_COLORS[3].color, label: `< ${pct(b1)}` },
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
  // Custom region: Map<fips, displayLabel> built from search + map clicks
  const [customRegion,   setCustomRegion]  = useState(new Map());

  const mapContainerRef = useRef(null);

  const year = parseInt(period.slice(0, 4), 10);
  // Heatmap follows activeMetric. Backend currently implements deposits fully;
  // other metrics will return data as they're added to compute_cu_allocations.
  const heatmapCounties = useHeatmapData(charterNumber, activeMetric, year, token);
  const breaks          = useMemo(() => computeBreaks(heatmapCounties), [heatmapCounties]);
  const [competitorCounties, setCompetitorCounties] = useState([]);

  const customRegionFipsStr = [...customRegion.keys()].join(',');

  // State FIPS as integer — used in MapLibre floor(fips/1000) expressions.
  // Returns null when not in state mode or no state selected.
  const stateFips = useMemo(() => {
    if (geoType !== 'state' || !geoId) return null;
    const fipsStr = Object.entries(STATE_FIPS_TO_ABBR).find(([, abbr]) => abbr === geoId)?.[0];
    return fipsStr != null ? parseInt(fipsStr, 10) : null;
  }, [geoType, geoId]);

  const colorExpr = useMemo(
    () => buildColorExpression(
      heatmapCounties,
      selectedCompId ? competitorCounties : [],
      stateFips,
      breaks,
    ),
    [heatmapCounties, competitorCounties, selectedCompId, stateFips, breaks],
  );

  const regionOutlineExpr = useMemo(
    () => buildOutlineExpr(
      geoType === 'custom_region' ? [...customRegion.keys()] : null,
      geoType === 'state' ? stateFips : null,
    ),
    // customRegionFipsStr as stable dep — Map identity changes on every update
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [geoType, customRegionFipsStr, stateFips],
  );

  function handleGeoTypeChange(newType) {
    setGeoType(newType);
    setGeoId('');
    setSelectedCounty(null);
    setCustomRegion(new Map());
  }

  // Map click routes by geoType:
  //   county       → select that county for the right panel
  //   state        → derive state abbreviation from county FIPS prefix, set geoId
  //   custom_region→ toggle county in/out of the region
  //   msa          → no-op (user picks MSA from the search input)
  const handleCountyClick = useCallback(({ fips, name }) => {
    if (geoType === 'custom_region') {
      setCustomRegion(prev => {
        const next = new Map(prev);
        if (next.has(fips)) next.delete(fips); else next.set(fips, name);
        return next;
      });
    } else if (geoType === 'state') {
      // MapLibre drops leading zeros (e.g. "05001" → integer 5001 → string "5001"),
      // so slice(0,2) would give "50" (VT) not "05" (AR). Use floor division instead.
      const stateFipsInt = Math.floor(parseInt(fips, 10) / 1000);
      const stateFipsStr = String(stateFipsInt).padStart(2, '0');
      const abbr = STATE_FIPS_TO_ABBR[stateFipsStr];
      if (abbr) setGeoId(abbr);
    } else if (geoType === 'county') {
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
  const { fitBounds }  = useMapLibre(mapContainerRef, handleCountyClick, colorExpr, regionOutlineExpr);

  // Auto-fit viewport to the institution's operating states when heatmap data arrives
  useEffect(() => {
    if (!heatmapCounties.length) return;
    const stateFipsSet = new Set(
      heatmapCounties.map(c => String(Math.floor(parseInt(c.county_fips, 10) / 1000)).padStart(2, '0'))
    );
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const fips of stateFipsSet) {
      const bb = STATE_BBOX[fips];
      if (!bb) continue;
      if (bb[0] < minLng) minLng = bb[0]; if (bb[1] < minLat) minLat = bb[1];
      if (bb[2] > maxLng) maxLng = bb[2]; if (bb[3] > maxLat) maxLat = bb[3];
    }
    if (minLng < Infinity) fitBounds([[minLng, minLat], [maxLng, maxLat]]);
  }, [heatmapCounties, fitBounds]);

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

  const rightGeoType =
    geoType === 'custom_region' ? 'custom_region' :
    (geoType === 'county' && selectedCounty) ? 'county' :
    geoType;
  const rightGeoId =
    geoType === 'custom_region' ? customRegionFipsStr :
    (geoType === 'county' && selectedCounty) ? selectedCounty.fips :
    geoId;

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

          {geoType === 'county' && selectedCounty && (
            <div className="selected-county-label">
              Viewing: <strong>{selectedCounty.name}</strong> ({selectedCounty.fips})
              <button className="clear-btn" onClick={() => setSelectedCounty(null)} title="Clear">×</button>
            </div>
          )}

          <ColorLegend metric={activeMetric} breaks={breaks} />
        </div>

        {/* Right panel (40%) */}
        <div className="map-right-panel">
          {geoType === 'county' && selectedCounty && (
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
            selectedCompetitor={selectedCompId}
            onSelectCompetitor={setSelectedCompId}
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
