/**
 * ModOps Dashboard — Client Application
 * Fetches telemetry data from the Hono API and renders it into the dashboard UI.
 *
 * API Contract (matching backend):
 *   GET /api/friction/total    → { total: number }
 *   GET /api/friction/by-flair → Record<string, number>  (bare object)
 *   GET /api/friction/by-hour  → Record<string, number>  (keys: "0"-"23")
 *   GET /api/friction/by-day   → Record<string, number>  (keys: "Sun","Mon",...)
 */

// ─── Type Definitions ───────────────────────────────────────────────

interface FrictionTotalResponse {
  total: number;
  removals?: number;
}

// by-flair, by-hour, by-day all return bare Record<string, number>
type FrictionGroupResponse = Record<string, number>;

interface DashboardData {
  total: number;
  removals: number;
  byFlair: Record<string, number>;
  byHour: Record<string, number>;
  byDay: Record<string, number>;
}

// ─── Constants ──────────────────────────────────────────────────────

// Backend returns abbreviated day names (Sun, Mon, ...) as keys.
// Map them to full names for display.
const DAY_DISPLAY_NAMES: Record<string, string> = {
  'Sun': 'Sunday',
  'Mon': 'Monday',
  'Tue': 'Tuesday',
  'Wed': 'Wednesday',
  'Thu': 'Thursday',
  'Fri': 'Friday',
  'Sat': 'Saturday',
};

const FETCH_TIMEOUT_MS = 8000;

// ─── DOM References ─────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const dom = {
  // Hero card
  topFlairName: $<HTMLDivElement>('top-flair-name'),
  topFlairCount: $<HTMLSpanElement>('top-flair-count'),
  topFlairPctFill: $<HTMLSpanElement>('top-flair-pct-fill'),
  topFlairPctText: $<HTMLSpanElement>('top-flair-pct-text'),

  // Metrics
  metricTotal: $<HTMLDivElement>('metric-total'),
  metricPeakHour: $<HTMLDivElement>('metric-peak-hour'),
  metricPeakHourCount: $<HTMLDivElement>('metric-peak-hour-count'),
  metricPeakDay: $<HTMLDivElement>('metric-peak-day'),
  metricPeakDayCount: $<HTMLDivElement>('metric-peak-day-count'),
  metricDrift: $<HTMLDivElement>('metric-drift'),
  metricDriftDetail: $<HTMLDivElement>('metric-drift-detail'),

  // Flair breakdown
  flairList: $<HTMLDivElement>('flair-list'),

  // Modal
  modalOverlay: $<HTMLDivElement>('modal-overlay'),
  modalFlairName: $<HTMLElement>('modal-flair-name'),
  yamlSnippet: $<HTMLElement>('yaml-snippet'),
  btnRemediate: $<HTMLButtonElement>('btn-remediate'),
  btnCopy: $<HTMLButtonElement>('btn-copy'),
  copyLabel: $<HTMLSpanElement>('copy-label'),
  modalClose: $<HTMLButtonElement>('modal-close'),
  statusTimezone: $<HTMLSpanElement>('status-timezone'),
};

// ─── State ──────────────────────────────────────────────────────────

let currentTopFlair = '';

// ─── Data Fetching (with timeout + error boundaries) ────────────────

async function fetchWithTimeout<T>(url: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.status === 403) {
      throw new Error('FORBIDDEN');
    }
    if (!response.ok) {
      console.error(`[ModOps] Failed to fetch ${url}: ${response.status}`);
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      throw error;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.error(`[ModOps] Request timed out after ${timeoutMs}ms: ${url}`);
      throw new Error(`Timeout: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Safely fetch a single endpoint, returning a fallback on failure.
 * This prevents one failed endpoint from crashing the entire dashboard.
 */
async function safeFetch<T>(url: string, fallback: T): Promise<T> {
  try {
    return await fetchWithTimeout<T>(url);
  } catch (error: any) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      throw error;
    }
    console.warn(`[ModOps] Using fallback for ${url}:`, error);
    return fallback;
  }
}

async function fetchDashboardData(): Promise<DashboardData> {
  // Each endpoint is fetched independently with its own fallback.
  // If one fails, the others still render.
  const [totalRes, flairRes, hourRes, dayRes] = await Promise.all([
    safeFetch<FrictionTotalResponse>('/api/friction/total', { total: 0 }),
    safeFetch<FrictionGroupResponse>('/api/friction/by-flair', {}),
    safeFetch<FrictionGroupResponse>('/api/friction/by-hour', {}),
    safeFetch<FrictionGroupResponse>('/api/friction/by-day', {}),
  ]);

  return {
    total: totalRes?.total ?? 0,
    removals: totalRes?.removals ?? 0,
    byFlair: isPlainObject(flairRes) ? flairRes : {},
    byHour: isPlainObject(hourRes) ? hourRes : {},
    byDay: isPlainObject(dayRes) ? dayRes : {},
  };
}

/** Type guard: check if a value is a non-null plain object */
function isPlainObject(val: unknown): val is Record<string, number> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

// ─── Rendering ──────────────────────────────────────────────────────

function findPeakEntry(data: Record<string, number>): [string, number] | null {
  const entries = Object.entries(data).filter(([, v]) => v > 0);
  if (entries.length === 0) return null;
  return entries.reduce((max, entry) => (entry[1] > max[1] ? entry : max));
}

function formatHour(hour: string): string {
  const h = parseInt(hour, 10);
  if (isNaN(h)) return hour;
  
  // Create a date object, set its hour in UTC, and retrieve the local hour
  const d = new Date();
  d.setUTCHours(h, 0, 0, 0);
  
  const localHour = d.getHours();
  const period = localHour >= 12 ? 'PM' : 'AM';
  const display = localHour === 0 ? 12 : localHour > 12 ? localHour - 12 : localHour;
  
  // Detect short timezone name (e.g. IST, EST)
  const tzAbbr = new Date().toLocaleTimeString(undefined, { timeZoneName: 'short' }).split(' ').pop() || '';
  const tzSuffix = tzAbbr ? ` (${tzAbbr})` : '';
  
  return `${display}:00 ${period}${tzSuffix}`;
}

function renderDashboard(data: DashboardData): void {
  // Total false positives
  if (dom.metricTotal) {
    dom.metricTotal.textContent = data.total.toLocaleString();
  }

  // Top offender flair
  const topFlair = findPeakEntry(data.byFlair);
  if (topFlair) {
    const [flairName, flairCount] = topFlair;
    currentTopFlair = flairName;
    if (dom.topFlairName) dom.topFlairName.textContent = flairName;
    if (dom.topFlairCount) dom.topFlairCount.textContent = flairCount.toLocaleString();

    const pct = data.total > 0 ? Math.round((flairCount / data.total) * 100) : 0;
    if (dom.topFlairPctFill) dom.topFlairPctFill.style.width = `${pct}%`;
    if (dom.topFlairPctText) dom.topFlairPctText.textContent = `${pct}% of total`;
  } else {
    currentTopFlair = '';
    if (dom.topFlairName) dom.topFlairName.textContent = 'No data yet';
    if (dom.topFlairCount) dom.topFlairCount.textContent = '0';
    if (dom.topFlairPctFill) dom.topFlairPctFill.style.width = '0%';
    if (dom.topFlairPctText) dom.topFlairPctText.textContent = '0% of total';
  }

  // Peak hour — backend returns numeric keys ("0"-"23")
  const peakHour = findPeakEntry(data.byHour);
  if (peakHour) {
    if (dom.metricPeakHour) dom.metricPeakHour.textContent = formatHour(peakHour[0]);
    if (dom.metricPeakHourCount) dom.metricPeakHourCount.textContent = `${peakHour[1]} events`;
  } else {
    if (dom.metricPeakHour) dom.metricPeakHour.textContent = '—';
    if (dom.metricPeakHourCount) dom.metricPeakHourCount.textContent = '';
  }

  // Peak day — backend returns abbreviated day names ("Sun", "Mon", ...)
  const peakDay = findPeakEntry(data.byDay);
  if (peakDay) {
    const displayName = DAY_DISPLAY_NAMES[peakDay[0]] ?? peakDay[0];
    if (dom.metricPeakDay) dom.metricPeakDay.textContent = displayName;
    if (dom.metricPeakDayCount) dom.metricPeakDayCount.textContent = `${peakDay[1]} events`;
  } else {
    if (dom.metricPeakDay) dom.metricPeakDay.textContent = '—';
    if (dom.metricPeakDayCount) dom.metricPeakDayCount.textContent = '';
  }

  // Rule Drift Score Calculation (Approach A: False Positive Rate Relative to Removals)
  if (dom.metricDrift && dom.metricDriftDetail) {
    const totalCount = data.total;
    let removalsCount = data.removals || 0;

    // Robust Fallback: If removals is untracked or less than total false positives,
    // fallback to totalCount so we calculate a conservative 100% FPR rather than breaking.
    if (totalCount > 0 && removalsCount < totalCount) {
      removalsCount = totalCount;
    }

    let status = 'Stable';
    let frictionIndex = 0;
    let fpr = 0;
    
    if (removalsCount > 0 && totalCount > 0) {
      fpr = (totalCount / removalsCount) * 100;
      // Target acceptable error rate threshold is 5%
      frictionIndex = Math.min(100, Math.round((fpr / 5) * 100));
      
      if (frictionIndex > 75) {
        status = 'Critical';
        dom.metricDrift.style.color = 'var(--accent-red)';
      } else if (frictionIndex > 35) {
        status = 'Moderate';
        dom.metricDrift.style.color = 'var(--accent-amber)';
      } else {
        status = 'Stable';
        dom.metricDrift.style.color = 'var(--accent-emerald)';
      }
    } else {
      dom.metricDrift.style.color = 'var(--accent-emerald)';
    }

    dom.metricDrift.textContent = status;
    dom.metricDriftDetail.textContent = `Friction Index: ${frictionIndex}% (FPR: ${fpr.toFixed(1)}%)`;

    // Dynamic icon color adjustment
    const driftIcon = $('metric-drift-icon');
    if (driftIcon) {
      const color = status === 'Critical' ? 'var(--accent-red)' : status === 'Moderate' ? 'var(--accent-amber)' : 'var(--accent-emerald)';
      driftIcon.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M2 14C4 11 7 17 10 13C13 9 16 12 18 8" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="18" cy="8" r="2" fill="${color}"/>
        </svg>
      `;
    }
  }

  // Flair breakdown list
  renderFlairList(data.byFlair);
}

function getDriftClass(count: number): string {
  if (count >= 12) return 'drift-critical';
  if (count >= 6) return 'drift-moderate';
  return 'drift-stable';
}

function getDriftLabel(count: number): string {
  if (count >= 12) return 'High Drift';
  if (count >= 6) return 'Moderate';
  return 'Stable';
}

function renderFlairList(byFlair: Record<string, number>): void {
  if (!dom.flairList) return;

  const entries = Object.entries(byFlair)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) {
    dom.flairList.innerHTML =
      '<div class="flair-empty">No flair data yet. Waiting for mod actions...</div>';
    return;
  }

  const maxCount = entries[0]?.[1] ?? 1;

  dom.flairList.innerHTML = entries
    .map(([name, count], index) => {
      const displayName = name.trim() === '' ? 'no-flair' : name;
      const barWidth = Math.max(4, Math.round((count / maxCount) * 100));
      return `
        <div class="flair-row">
          <span class="flair-rank">${index + 1}</span>
          <span class="flair-name">${escapeHTML(displayName)}</span>
          <span class="flair-bar-container">
            <span class="flair-bar" style="width: ${barWidth}%"></span>
          </span>
          <span class="flair-drift-badge ${getDriftClass(count)}">${getDriftLabel(count)}</span>
          <span class="flair-count">${count}</span>
        </div>
      `;
    })
    .join('');
}

function escapeHTML(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Modal Logic ────────────────────────────────────────────────────

function openModal(): void {
  const flairName = currentTopFlair || '<Flair Name>';
  if (dom.modalFlairName) dom.modalFlairName.textContent = flairName;
  if (dom.yamlSnippet) dom.yamlSnippet.textContent = `~flair_text: ["${flairName}"]`;
  dom.modalOverlay?.setAttribute('aria-hidden', 'false');
}

function closeModal(): void {
  dom.modalOverlay?.setAttribute('aria-hidden', 'true');
  if (dom.copyLabel) dom.copyLabel.textContent = 'Copy';
  dom.btnCopy?.classList.remove('copied');
}

async function copyYAML(): Promise<void> {
  const text = dom.yamlSnippet?.textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
    if (dom.copyLabel) dom.copyLabel.textContent = 'Copied!';
    dom.btnCopy?.classList.add('copied');
    setTimeout(() => {
      if (dom.copyLabel) dom.copyLabel.textContent = 'Copy';
      dom.btnCopy?.classList.remove('copied');
    }, 2000);
  } catch {
    // Fallback: select text for manual copy
    if (dom.yamlSnippet) {
      const range = document.createRange();
      range.selectNodeContents(dom.yamlSnippet);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }
}

// ─── Event Listeners ────────────────────────────────────────────────

dom.btnRemediate?.addEventListener('click', openModal);
dom.modalClose?.addEventListener('click', closeModal);
dom.btnCopy?.addEventListener('click', copyYAML);

// Close modal on overlay click
dom.modalOverlay?.addEventListener('click', (e: Event) => {
  if (e.target === dom.modalOverlay) closeModal();
});

// Close modal on Escape key
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') closeModal();
});

function renderAccessDenied(): void {
  const appContainer = $('app');
  if (!appContainer) return;

  appContainer.innerHTML = `
    <div class="access-denied-container">
      <div class="lock-icon-wrapper">
        <svg class="glowing-lock" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--accent-red)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
      </div>
      <h1 class="denied-title">Access Restricted</h1>
      <p class="denied-subtitle">Subreddit moderators only</p>
      
      <div class="denied-card">
        <p class="denied-message">
          The SubWatch Observability Dashboard contains sensitive moderation telemetry.
          Access is strictly restricted to active moderators of this community.
        </p>
        <div class="denied-badge">
          <span class="badge-dot"></span>
          <span class="badge-text">Security Protocol Active</span>
        </div>
      </div>
    </div>
  `;
}

// ─── Initialization ─────────────────────────────────────────────────

async function init(): Promise<void> {
  console.log('[ModOps] Dashboard initializing...');

  // Set local timezone in header
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tzAbbr = new Date().toLocaleTimeString(undefined, { timeZoneName: 'short' }).split(' ').pop() || '';
    const tzText = tzAbbr ? `${tzAbbr} (${tz})` : tz;
    if (dom.statusTimezone) {
      dom.statusTimezone.textContent = tzText;
    }
  } catch (e) {
    console.warn('[ModOps] Failed to resolve local timezone:', e);
  }

  try {
    const data = await fetchDashboardData();
    console.log('[ModOps] Data loaded:', data);
    renderDashboard(data);
  } catch (error: any) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      console.warn('[ModOps] Access denied: User is not a moderator.');
      renderAccessDenied();
    } else {
      console.error('[ModOps] Critical failure loading dashboard data:', error);
      // Dashboard will show default "0" / "—" values from the HTML
    }
  }
}

// Run on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
