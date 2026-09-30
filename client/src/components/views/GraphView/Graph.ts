import { cloneDeep } from 'lodash';

type Options = {
  windowMs: number;
  colors: string[];
  // Layer order; the first is drawn in front and heads the key. Unlisted names
  // keep arrival order, after the listed ones.
  seriesOrder: string[];
  // per-series color overrides; series without one fall back to `colors`
  seriesColors: { [name: string]: string };
  lineWidth: number;
  padding: number;
  keySpacing: number;
  keyLineLength: number;
  gridLineWidth: number; // device pixels
  gridLineColor: string;
  fontSize: number;
  textColor: string;
  maxTicks: number;
  crosshairColor: string;
  // color the hover dots are outlined with; should match the view background
  backgroundColor: string;
  hoverDotRadius: number;
  markerColor: string;
  markerLineWidth: number; // device pixels
};

import { DEFAULT_SERIES_COLORS } from './colors';

// all dimensions in this file are *CSS* pixels unless otherwise stated
export const DEFAULT_OPTIONS: Options = {
  windowMs: 5000,
  colors: [...DEFAULT_SERIES_COLORS],
  seriesOrder: [],
  seriesColors: {},
  lineWidth: 2,
  padding: 15,
  keySpacing: 4,
  keyLineLength: 12,
  gridLineWidth: 1, // device pixels
  gridLineColor: 'rgb(120, 120, 120)',
  fontSize: 14,
  textColor: 'rgb(50, 50, 50)',
  maxTicks: 7,
  crosshairColor: 'rgb(120, 120, 120)',
  backgroundColor: 'rgb(255, 255, 255)',
  hoverDotRadius: 3.5,
  markerColor: 'rgb(90, 90, 90)',
  markerLineWidth: 1, // device pixels
};

export const RECORDED_SUFFIX = '(rec)';
/** Recorded series are told apart by the dash alone: on the dark theme, alpha
 *  pulls a line toward the background and off its live twin's colour. */
const DASH_PATTERN = [5, 4];

// upper bound on the number of retained samples per series: about 33 minutes at
// 50 Hz, about 2.7 hours at the 100 ms default transmission interval
const MAX_HISTORY_SAMPLES = 100000;

// first index i such that ts[i] >= value (ts is sorted ascending)
function lowerBound(ts: number[], value: number) {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// inclusive index range of the samples needed to draw [startMs, endMs]; one
// sample beyond each edge is included so lines run to the edge of the plot.
// null means the series has nothing to show in this window, including a
// series that starts after it or ended before it, whose nearest sample would
// otherwise drag the y-axis toward a value that isn't on screen
function visibleRange(ts: number[], startMs: number, endMs: number) {
  if (ts.length === 0) return null;

  const lo = lowerBound(ts, startMs);
  const hi = lowerBound(ts, endMs);

  if (lo === hi) {
    // no samples land inside the window; only a segment spanning it, or a
    // single sample sitting exactly on the right edge, is visible
    if (lo === ts.length) return null;
    if (lo === 0) return ts[0] <= endMs ? { first: 0, last: 0 } : null;

    return { first: lo - 1, last: lo };
  }

  return { first: Math.max(0, lo - 1), last: Math.min(ts.length - 1, hi) };
}

function niceNum(range: number, round: boolean) {
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / Math.pow(10, exponent);
  let niceFraction;
  if (round) {
    if (fraction < 1.5) {
      niceFraction = 1;
    } else if (fraction < 3) {
      niceFraction = 2;
    } else if (fraction < 7) {
      niceFraction = 5;
    } else {
      niceFraction = 10;
    }
  } else if (fraction <= 1) {
    niceFraction = 1;
  } else if (fraction <= 2) {
    niceFraction = 2;
  } else if (fraction <= 5) {
    niceFraction = 5;
  } else {
    niceFraction = 10;
  }
  return niceFraction * Math.pow(10, exponent);
}

// interesting algorithm (see http://erison.blogspot.nl/2011/07/algorithm-for-optimal-scaling-on-chart.html)
function getAxisScaling(min: number, max: number, maxTicks: number) {
  const range = niceNum(max - min, false);
  const tickSpacing = niceNum(range / (maxTicks - 1), true);
  const niceMin = Math.floor(min / tickSpacing) * tickSpacing;
  const niceMax = (Math.floor(max / tickSpacing) + 1) * tickSpacing;
  return {
    min: niceMin,
    max: niceMax,
    spacing: tickSpacing,
  };
}

// shamelessly stolen from https://github.com/chartjs/Chart.js/blob/master/src/core/core.ticks.js
function formatTicks(tickValue: number, ticks: number[]) {
  // If we have lots of ticks, don't use the ones
  let delta = ticks.length > 3 ? ticks[2] - ticks[1] : ticks[1] - ticks[0];

  // If we have a number like 2.5 as the delta, figure out how many decimal places we need
  if (Math.abs(delta) > 1) {
    if (tickValue !== Math.floor(tickValue)) {
      // not an integer
      delta = tickValue - Math.floor(tickValue);
    }
  }

  const logDelta = Math.log10(Math.abs(delta));
  let tickString = '';

  if (tickValue !== 0) {
    let numDecimal = -1 * Math.floor(logDelta);
    numDecimal = Math.max(Math.min(numDecimal, 20), 0); // toFixed has a max of 20 decimal places
    tickString = tickValue.toFixed(numDecimal);
  } else {
    tickString = '0'; // never show decimal places for 0
  }

  return tickString;
}

type Axis = {
  min: number;
  max: number;
  spacing: number;
};

function getTicks(axis: Axis) {
  // get tick array
  const ticks = [];
  for (let i = axis.min; i <= axis.max; i += axis.spacing) {
    ticks.push(i);
  }

  // generate strings
  const tickStrings = [];
  for (let i = 0; i < ticks.length; i++) {
    const s = formatTicks(ticks[i], ticks);
    tickStrings.push(s);
  }

  return tickStrings;
}

function scale(
  value: number,
  fromLow: number,
  fromHigh: number,
  toLow: number,
  toHigh: number,
) {
  const frac = (toHigh - toLow) / (fromHigh - fromLow);
  return toLow + frac * (value - fromLow);
}

type Sample = {
  name: string;
  value: number;
  recorded?: boolean;
};

// index of the sample in ts (sorted ascending) whose time is closest to t
function nearestIndex(ts: number[], t: number) {
  let lo = 0;
  let hi = ts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < t) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  if (lo > 0 && Math.abs(ts[lo - 1] - t) <= Math.abs(ts[lo] - t)) return lo - 1;
  return lo;
}

// format a sample for display in the hover overlay
export function formatValue(value: number) {
  if (!Number.isFinite(value)) return `${value}`;

  const mag = Math.abs(value);
  if (mag === 0) return '0';
  if (mag < 1e-3 || mag >= 1e6) return value.toExponential(2);

  return `${parseFloat(value.toPrecision(6))}`;
}

type HoverEntry = {
  name: string;
  color: string;
  value: number;
  // position of the sample, in CSS pixels relative to the canvas
  x: number;
  y: number;
};

export type HoverInfo = {
  // cursor position, in CSS pixels relative to the canvas
  cursorX: number;
  cursorY: number;
  // name of the series whose line is closest to the cursor
  nearestName: string;
  entries: HoverEntry[];
};

// a labeled instant in telemetry time
export type Marker = {
  t: number;
  label: string;
};

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// inclusive indices of the samples a series contributes to the plot
type SampleRange = {
  first: number;
  last: number;
};

// align coordinate to the nearest pixel, offset by a half pixel
// this helps with drawing thin lines; e.g., if a line of width 1px
// is drawn on an integer coordinate, it will be 2px wide
// x is assumed to be in *device* pixels
function alignCoord(x: number, scaling: number) {
  const roundX = Math.round(x * scaling);
  return (roundX + 0.5 * Math.sign(x - roundX)) / scaling;
}

type Scaling = {
  scalingX: number;
  scalingY: number;
};

function getScalingFactors(ctx: CanvasRenderingContext2D): Scaling {
  let transform;
  if (typeof ctx.getTransform === 'function') {
    transform = ctx.getTransform();
  } else if (
    typeof (ctx as unknown as { mozCurrentTransform?: number[] })
      .mozCurrentTransform !== 'undefined'
  ) {
    transform = window.DOMMatrix.fromFloat64Array(
      Float64Array.from(
        (ctx as unknown as { mozCurrentTransform: number[] })
          .mozCurrentTransform,
      ),
    );
  } else {
    throw new Error('unable to find canvas transform');
  }

  const { a, b, c, d } = transform;
  const scalingX = Math.sqrt(a * a + c * c);
  const scalingY = Math.sqrt(b * b + d * d);

  return {
    scalingX,
    scalingY,
  };
}

function fineMoveTo(
  ctx: CanvasRenderingContext2D,
  s: Scaling,
  x: number,
  y: number,
) {
  ctx.moveTo(alignCoord(x, s.scalingX), alignCoord(y, s.scalingY));
}

function fineLineTo(
  ctx: CanvasRenderingContext2D,
  s: Scaling,
  x: number,
  y: number,
) {
  ctx.lineTo(alignCoord(x, s.scalingX), alignCoord(y, s.scalingY));
}

export default class Graph {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  options: Options;

  data: { [key: string]: { ts: number[]; vs: number[]; dashed: boolean } };
  markers: Marker[];

  beginGraphNowMs = Number.NaN; // in telemetry time
  beginRenderTimeMs = Number.NaN; // in browser time

  // cursor position in CSS pixels relative to the canvas, null when not hovering
  cursor: { x: number; y: number } | null = null;
  // result of the last hit test; recomputed on every render
  hover: HoverInfo | null = null;

  // updated on each render to support hit testing against the drawn plot
  graphNowMs = Number.NaN; // in telemetry time
  plotRect: Rect = { x: 0, y: 0, width: 0, height: 0 }; // CSS pixels

  // extent of the retained history, in telemetry time
  firstSampleMs = Number.NaN;
  latestSampleMs = Number.NaN;

  scaling: Scaling;

  constructor(canvas: HTMLCanvasElement, options: Options) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2d context from canvas');
    }
    this.ctx = ctx;

    this.options = cloneDeep(DEFAULT_OPTIONS);
    Object.assign(this.options, options || {});

    this.data = {};
    this.markers = [];

    this.scaling = {
      scalingX: 1,
      scalingY: 1,
    };

    this.reset();
  }

  reset() {
    // no prototype, so a series named '__proto__' is stored like any other
    this.data = Object.create(null);
    this.markers = [];

    this.beginGraphNowMs = Number.NaN; // in telemetry time
    this.beginRenderTimeMs = Number.NaN; // in browser time

    this.firstSampleMs = Number.NaN;
    this.latestSampleMs = Number.NaN;

    this.hover = null;

    // Dropping samples does not clear pixels: render() is the only repaint
    // and it is gated on not being paused, so the curves would stay frozen.
    // eslint-disable-next-line no-self-assign
    this.canvas.width = this.canvas.width;
  }

  // x and y are in CSS pixels relative to the canvas; pass null to clear
  setCursor(cursor: { x: number; y: number } | null) {
    this.cursor = cursor;
  }

  getHover() {
    return this.hover;
  }

  // re-anchors telemetry time to browser time; used when resuming after a pause
  // so that playback picks up from the newest sample instead of replaying the gap
  resync(time: number) {
    if (isNaN(this.latestSampleMs)) return;

    this.beginGraphNowMs = this.latestSampleMs - 250;
    this.beginRenderTimeMs = time;
  }

  // extent of the retained history, or null if nothing has been recorded
  getTimeBounds() {
    if (isNaN(this.firstSampleMs) || isNaN(this.latestSampleMs)) return null;

    return { minMs: this.firstSampleMs, maxMs: this.latestSampleMs };
  }

  // the telemetry time shown at the right edge for live (non-scrubbed) playback
  getGraphNowMs(time: number) {
    if (isNaN(this.beginGraphNowMs)) return Number.NaN;

    return this.beginGraphNowMs + (time - this.beginRenderTimeMs);
  }

  // telemetry time at the right edge: the scrub position, else live playback
  shownMs(time: number, scrubMs?: number | null) {
    return typeof scrubMs === 'number' && !isNaN(scrubMs)
      ? scrubMs
      : this.getGraphNowMs(time);
  }

  seriesFor(key: string, dashed = false) {
    if (!Object.prototype.hasOwnProperty.call(this.data, key)) {
      this.data[key] = { ts: [], vs: [], dashed };
    }

    return this.data[key];
  }

  // The first name is the topmost layer.
  orderedNames() {
    const { seriesOrder } = this.options;

    const names = Object.keys(this.data);
    if (seriesOrder.length === 0) return names;

    const rank = (name: string) => {
      const i = seriesOrder.indexOf(name);
      return i === -1 ? seriesOrder.length : i;
    };

    // the insertion index keeps unlisted series in a stable relative order
    return names
      .map((name, i) => ({ name, i }))
      .sort((a, b) => rank(a.name) - rank(b.name) || a.i - b.i)
      .map(({ name }) => name);
  }

  /** Moves every sample `ms` later. */
  shift(ms: number) {
    for (const { ts } of Object.values(this.data)) {
      for (let i = 0; i < ts.length; i++) ts[i] += ms;
    }
    for (const marker of this.markers) marker.t += ms;

    this.firstSampleMs += ms;
    this.latestSampleMs += ms;
  }

  /** Recorded series must leave the key and the y-axis range, and reset() would
   *  take the live plot down with them. */
  dropRecorded() {
    for (const key of Object.keys(this.data)) {
      if (this.data[key].dashed) delete this.data[key];
    }

    // the scrub range must shrink back to what is left
    const kept = Object.values(this.data).filter(({ ts }) => ts.length > 0);
    this.firstSampleMs = kept.length
      ? Math.min(...kept.map(({ ts }) => ts[0]))
      : Number.NaN;
    this.latestSampleMs = kept.length
      ? Math.max(...kept.map(({ ts }) => ts[ts.length - 1]))
      : Number.NaN;
  }

  colorFor(key: string) {
    const o = this.options;

    // A recorded twin wears its live series' colour; the dash tells them apart.
    const name = this.data[key]?.dashed
      ? key.slice(0, -` ${RECORDED_SUFFIX}`.length)
      : key;

    if (Object.prototype.hasOwnProperty.call(o.seriesColors, name))
      return o.seriesColors[name];

    const orderIndex = o.seriesOrder.indexOf(name);
    const index =
      orderIndex === -1 ? Object.keys(this.data).indexOf(name) : orderIndex;

    return o.colors[Math.max(index, 0) % o.colors.length];
  }

  add(time: number, samples: Sample[][], markers: Marker[] = []) {
    const o = this.options;
    let plotted = false;

    for (const { t, label } of markers) {
      if (isNaN(t)) continue;

      this.markers.push({ t, label });
    }

    for (const sample of samples) {
      const t = sample.reduce(
        (acc, { name, value }) => (name === 'time' ? value : acc),
        Number.NaN,
      );

      for (const series of sample) {
        const { name, value, recorded } = series;

        if (name === 'time') continue;

        // Not isNaN: Java stringifies 1.0/0.0 as "Infinity", and one such value
        // gives getYAxisScaling a NaN range that blanks every plotted series.
        if (!Number.isFinite(value)) continue;

        const key = recorded ? `${name} ${RECORDED_SUFFIX}` : name;

        const history = this.seriesFor(key, recorded === true).ts;
        const lastMs = history[history.length - 1];

        // a small step back is jitter between telemetry threads; a step of a
        // whole window is the robot clock moving, so the history starts over
        if (history.length > 0 && t < lastMs) {
          if (lastMs - t < o.windowMs) continue;

          this.reset();
        }

        const { ts, vs } = this.seriesFor(key, recorded === true);

        ts.push(t);
        vs.push(value);
        plotted = true;

        if (ts.length > MAX_HISTORY_SAMPLES) {
          // trimming one sample per packet would move the whole array every time
          const excess = Math.max(
            ts.length - MAX_HISTORY_SAMPLES,
            Math.floor(MAX_HISTORY_SAMPLES / 10),
          );
          ts.splice(0, excess);
          vs.splice(0, excess);

          // the oldest retained sample moved, so the history no longer reaches
          // as far back as it used to
          this.firstSampleMs = Math.min(
            ...Object.values(this.data)
              .filter((series) => series.ts.length > 0)
              .map((series) => series.ts[0]),
          );
        }

        if (isNaN(this.firstSampleMs) || t < this.firstSampleMs) {
          this.firstSampleMs = t;
        }
        if (isNaN(this.latestSampleMs) || t > this.latestSampleMs) {
          this.latestSampleMs = t;
        }
      }
    }

    // `plotted`, not `samples.length`: a batch can carry a time row and no
    // series, and a synthetic one's timestamp of 0 would anchor the plot clock
    // and push every later sample off screen.
    if (isNaN(this.beginGraphNowMs) && plotted) {
      const maxT = samples[samples.length - 1].reduce(
        (acc, { name, value }) => (name === 'time' ? value : acc),
        Number.NaN,
      );
      this.beginGraphNowMs = maxT - 250; // introduce lag to allow for transmission time
      this.beginRenderTimeMs = time;
    }
  }

  addMarker(t: number, label: string): Marker | null {
    if (isNaN(t)) return null;

    const marker = { t, label };
    this.markers.push(marker);

    return marker;
  }

  removeMarker(marker: Marker) {
    const index = this.markers.indexOf(marker);
    if (index === -1) return;

    this.markers.splice(index, 1);
  }

  // where a marker is drawn, in CSS pixels relative to the canvas
  markerXCoord(marker: Marker) {
    const { x, width } = this.plotRect;
    return (
      x +
      scale(
        marker.t - this.graphNowMs + this.options.windowMs,
        0,
        this.options.windowMs,
        0,
        width,
      )
    );
  }

  // the marker drawn closest to x, or null if none is within tolerance
  // (both in CSS pixels relative to the canvas)
  markerAt(x: number, tolerance: number): Marker | null {
    if (this.plotRect.width === 0 || isNaN(this.graphNowMs)) return null;

    const { x: plotX, width } = this.plotRect;

    let closest: Marker | null = null;
    let closestDist = tolerance;
    for (const marker of this.markers) {
      const markerX = this.markerXCoord(marker);
      // markers outside the plot are not drawn, so they cannot be hit
      if (markerX < plotX || markerX > plotX + width) continue;

      const dist = Math.abs(markerX - x);
      if (dist > closestDist) continue;

      closest = marker;
      closestDist = dist;
    }

    return closest;
  }

  // converts an x coordinate in CSS pixels (relative to the canvas) to telemetry time
  timeAtX(x: number) {
    const o = this.options;
    const { x: plotX, width } = this.plotRect;

    if (width === 0) return Number.NaN;

    return (
      this.graphNowMs - o.windowMs + scale(x - plotX, 0, width, 0, o.windowMs)
    );
  }

  // both coordinates are in CSS pixels relative to the canvas
  isInPlot(x: number, y: number) {
    const r = this.plotRect;
    return (
      r.width > 0 &&
      x >= r.x &&
      x <= r.x + r.width &&
      y >= r.y &&
      y <= r.y + r.height
    );
  }

  // series with nothing to show in [startMs, endMs] are left out
  getVisibleRanges(startMs: number, endMs: number) {
    const ranges = new Map<string, SampleRange>();

    for (const [name, { ts }] of Object.entries(this.data)) {
      const range = visibleRange(ts, startMs, endMs);
      if (range !== null) ranges.set(name, range);
    }

    return ranges;
  }

  getYAxisScaling(ranges: Map<string, SampleRange>) {
    let [min, max] = [Number.MAX_VALUE, -Number.MAX_VALUE];

    for (const [name, range] of ranges) {
      const { vs } = this.data[name];

      for (let i = range.first; i <= range.last; i++) {
        min = Math.min(vs[i], min);
        max = Math.max(vs[i], max);
      }
    }

    if (min > max) {
      // nothing falls inside the window
      return getAxisScaling(-1, 1, this.options.maxTicks);
    }

    if (Math.abs(min - max) < 1e-6) {
      return getAxisScaling(min - 1, max + 1, this.options.maxTicks);
    }

    return getAxisScaling(min, max, this.options.maxTicks);
  }

  // when scrubMs is given, it replaces live playback as the telemetry time shown
  // at the right edge of the plot
  render(time: number, scrubMs?: number | null) {
    const o = this.options;

    // eslint-disable-next-line
    this.canvas.width = this.canvas.width; // clears the canvas

    this.hover = null;

    const graphNowMs = this.shownMs(time, scrubMs);
    this.graphNowMs = graphNowMs;

    if (isNaN(graphNowMs)) return false;

    // no view starts earlier than a window (plus the 250 ms start lag) before
    // the oldest retained sample, so markers older than that can go
    if (!isNaN(this.firstSampleMs)) {
      const cutoff = this.firstSampleMs - o.windowMs - 250;
      this.markers = this.markers.filter(({ t }) => t >= cutoff);
    }

    const ranges = this.getVisibleRanges(graphNowMs - o.windowMs, graphNowMs);
    if (ranges.size === 0) return false;

    // scale the canvas to facilitate the use of CSS pixels
    this.ctx.scale(devicePixelRatio, devicePixelRatio);

    this.scaling = getScalingFactors(this.ctx);

    this.ctx.font = `${o.fontSize}px "Roboto", sans-serif`;
    this.ctx.textBaseline = 'middle';
    this.ctx.textAlign = 'left';
    this.ctx.lineWidth = o.lineWidth / devicePixelRatio;

    const width = this.canvas.width / devicePixelRatio;
    const height = this.canvas.height / devicePixelRatio;

    const keyHeight = this.renderKey(0, 0, width);
    this.renderGraph(
      0,
      keyHeight,
      width,
      height - keyHeight,
      graphNowMs,
      ranges,
    );

    return true;
  }

  renderKey(x: number, y: number, width: number) {
    const o = this.options;

    this.ctx.save();

    const names = this.orderedNames();
    const numSets = names.length;
    const height = numSets * o.fontSize + (numSets - 1) * o.keySpacing;
    for (let i = 0; i < numSets; i++) {
      const lineY = y + i * (o.fontSize + o.keySpacing) + o.fontSize / 2;
      const name = names[i];
      const color = this.colorFor(name);
      const { dashed } = this.data[name];
      const lineWidth =
        this.ctx.measureText(name).width + o.keyLineLength + o.keySpacing;
      const lineX = x + (width - lineWidth) / 2;

      this.ctx.strokeStyle = color;
      this.ctx.setLineDash(dashed ? DASH_PATTERN : []);
      this.ctx.beginPath();
      fineMoveTo(this.ctx, this.scaling, lineX, lineY);
      fineLineTo(this.ctx, this.scaling, lineX + o.keyLineLength, lineY);
      this.ctx.stroke();
      this.ctx.setLineDash([]);

      this.ctx.fillStyle = o.textColor;
      this.ctx.fillText(name, lineX + o.keyLineLength + o.keySpacing, lineY);
    }

    this.ctx.restore();

    return height;
  }

  renderGraph(
    x: number,
    y: number,
    width: number,
    height: number,
    graphNowMs: number,
    ranges: Map<string, SampleRange>,
  ) {
    const o = this.options;

    const graphHeight = height - 2 * o.padding;

    const axis = this.getYAxisScaling(ranges);
    const ticks = getTicks(axis);
    const axisWidth = this.renderAxisLabels(
      x + o.padding,
      y + o.padding,
      graphHeight,
      ticks,
    );

    const graphWidth = width - axisWidth - 3 * o.padding;
    const graphX = x + axisWidth + 2 * o.padding;
    const graphY = y + o.padding;

    this.plotRect = {
      x: graphX,
      y: graphY,
      width: graphWidth,
      height: graphHeight,
    };

    this.renderGridLines(
      graphX,
      graphY,
      graphWidth,
      graphHeight,
      5,
      ticks.length,
    );

    this.renderGraphLines(
      graphX,
      graphY,
      graphWidth,
      graphHeight,
      axis,
      graphNowMs,
      ranges,
    );

    this.renderMarkers(graphX, graphY, graphWidth, graphHeight, graphNowMs);

    this.hover = this.hitTest(
      x + axisWidth + 2 * o.padding,
      y + o.padding,
      graphWidth,
      graphHeight,
      axis,
      graphNowMs,
    );

    if (this.hover !== null) {
      this.renderHover(
        x + axisWidth + 2 * o.padding,
        y + o.padding,
        graphWidth,
        graphHeight,
        this.hover,
      );
    }
  }

  // finds the sample of each series closest in time to the cursor
  hitTest(
    x: number,
    y: number,
    width: number,
    height: number,
    axis: Axis,
    graphNowMs: number,
  ): HoverInfo | null {
    const o = this.options;

    const cursor = this.cursor;
    if (cursor === null) return null;

    if (
      cursor.x < x ||
      cursor.x > x + width ||
      cursor.y < y ||
      cursor.y > y + height
    ) {
      return null;
    }

    // map the cursor back onto the time axis
    const timeMs =
      graphNowMs - o.windowMs + scale(cursor.x - x, 0, width, 0, o.windowMs);

    // don't report a value for a series that has no sample near the cursor
    // (e.g., one that stopped reporting partway through the window)
    const minDeltaMs = o.windowMs / 25;

    const entries: HoverEntry[] = [];
    let nearestName = '';
    let nearestDist = Number.MAX_VALUE;

    for (const name of Object.keys(this.data)) {
      const { ts, vs } = this.data[name];
      const color = this.colorFor(name);

      if (ts.length === 0) continue;

      const i = nearestIndex(ts, timeMs);

      // a slowly updating series is never sampled near most of the cursor
      // positions, so the tolerance also follows its own spacing
      const prevDt = i > 0 ? ts[i] - ts[i - 1] : 0;
      const nextDt = i + 1 < ts.length ? ts[i + 1] - ts[i] : 0;
      const dt = (timeMs < ts[i] ? prevDt : nextDt) || prevDt || nextDt;

      if (Math.abs(ts[i] - timeMs) > Math.max(minDeltaMs, 1.5 * dt)) continue;

      const sampleY = y + scale(vs[i], axis.min, axis.max, height, 0);

      entries.push({
        name,
        color,
        value: vs[i],
        x: x + scale(ts[i] - graphNowMs + o.windowMs, 0, o.windowMs, 0, width),
        y: sampleY,
      });

      const dist = Math.abs(sampleY - cursor.y);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestName = name;
      }
    }

    if (entries.length === 0) return null;

    // order the entries the way they're stacked on screen
    entries.sort((a, b) => b.value - a.value);

    return {
      cursorX: cursor.x,
      cursorY: cursor.y,
      nearestName,
      entries,
    };
  }

  renderHover(
    x: number,
    y: number,
    width: number,
    height: number,
    hover: HoverInfo,
  ) {
    const o = this.options;

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(x, y, width, height);
    this.ctx.clip();

    // vertical crosshair through the cursor
    this.ctx.strokeStyle = o.crosshairColor;
    this.ctx.lineWidth = o.gridLineWidth / devicePixelRatio;
    this.ctx.setLineDash([4, 4]);
    this.ctx.beginPath();
    fineMoveTo(this.ctx, this.scaling, hover.cursorX, y);
    fineLineTo(this.ctx, this.scaling, hover.cursorX, y + height);
    this.ctx.stroke();
    this.ctx.setLineDash([]);

    // mark the sample of each series at the hovered time
    this.ctx.lineWidth = 1.5;
    this.ctx.strokeStyle = o.backgroundColor;
    for (const entry of hover.entries) {
      const radius =
        entry.name === hover.nearestName
          ? o.hoverDotRadius + 1.5
          : o.hoverDotRadius;

      this.ctx.beginPath();
      this.ctx.arc(entry.x, entry.y, radius, 0, 2 * Math.PI);
      this.ctx.fillStyle = entry.color;
      this.ctx.fill();
      this.ctx.stroke();
    }

    this.ctx.restore();
  }

  renderMarkers(
    x: number,
    y: number,
    width: number,
    height: number,
    graphNowMs: number,
  ) {
    const o = this.options;

    if (this.markers.length === 0) return;

    this.ctx.save();
    this.ctx.translate(x, y);
    // the path survives the save() above, so it has to be cleared before
    // clipping; otherwise the leftover data line is folded into the clip
    // region and its winding punches curve-shaped holes in the markers
    this.ctx.beginPath();
    this.ctx.rect(0, 0, width, height);
    this.ctx.clip();

    this.ctx.strokeStyle = o.markerColor;
    this.ctx.fillStyle = o.markerColor;
    this.ctx.lineWidth = o.markerLineWidth / devicePixelRatio;
    this.ctx.setLineDash([4, 4]);
    this.ctx.textAlign = 'left';

    for (const { t, label } of this.markers) {
      const markerX = scale(
        t - graphNowMs + o.windowMs,
        0,
        o.windowMs,
        0,
        width,
      );

      if (markerX < 0 || markerX > width) continue;

      this.ctx.beginPath();
      fineMoveTo(this.ctx, this.scaling, markerX, 0);
      fineLineTo(this.ctx, this.scaling, markerX, height);
      this.ctx.stroke();

      if (label === '') continue;

      // labels read bottom-to-top alongside their line to stay legible on
      // narrow graphs
      this.ctx.save();
      this.ctx.translate(markerX, height - o.keySpacing);
      this.ctx.rotate(-Math.PI / 2);
      this.ctx.fillText(label, o.keySpacing, o.fontSize * 0.75);
      this.ctx.restore();
    }

    this.ctx.restore();
  }

  renderAxisLabels(x: number, y: number, height: number, ticks: string[]) {
    this.ctx.save();

    let width = 0;
    for (let i = 0; i < ticks.length; i++) {
      const textWidth = this.ctx.measureText(ticks[i]).width;
      if (textWidth > width) {
        width = textWidth;
      }
    }

    // draw axis labels
    this.ctx.textAlign = 'right';
    this.ctx.fillStyle = this.options.textColor;

    const vertSpacing = height / (ticks.length - 1);
    x += width;
    for (let i = 0; i < ticks.length; i++) {
      this.ctx.fillText(ticks[i], x, y + (ticks.length - i - 1) * vertSpacing);
    }

    this.ctx.restore();

    return width;
  }

  renderGridLines(
    x: number,
    y: number,
    width: number,
    height: number,
    numTicksX: number,
    numTicksY: number,
  ) {
    this.ctx.save();

    this.ctx.strokeStyle = this.options.gridLineColor;
    this.ctx.lineWidth = this.options.gridLineWidth / devicePixelRatio;

    const horSpacing = width / (numTicksX - 1);
    const vertSpacing = height / (numTicksY - 1);

    for (let i = 0; i < numTicksX; i++) {
      const lineX = x + horSpacing * i;
      this.ctx.beginPath();
      fineMoveTo(this.ctx, this.scaling, lineX, y);
      fineLineTo(this.ctx, this.scaling, lineX, y + height);
      this.ctx.stroke();
    }

    for (let i = 0; i < numTicksY; i++) {
      const lineY = y + vertSpacing * i;
      this.ctx.beginPath();
      fineLineTo(this.ctx, this.scaling, x, lineY);
      fineLineTo(this.ctx, this.scaling, x + width, lineY);
      this.ctx.stroke();
    }

    this.ctx.restore();
  }

  renderGraphLines(
    x: number,
    y: number,
    width: number,
    height: number,
    axis: Axis,
    graphNowMs: number,
    ranges: Map<string, SampleRange>,
  ) {
    const o = this.options;

    this.ctx.lineWidth = o.lineWidth;

    this.ctx.save();
    this.ctx.translate(x, y);
    this.ctx.rect(0, 0, width, height);
    this.ctx.clip();

    // draw data lines
    // scaling is used instead of transform because of the non-uniform stretching warps the plot line
    // drawn back to front so that the head of the layer order ends up on top
    this.ctx.beginPath();
    this.orderedNames()
      .reverse()
      .forEach((k) => {
        const { ts, vs, dashed } = this.data[k];

        const range = ranges.get(k);
        if (range === undefined) return;

        this.ctx.beginPath();
        this.ctx.strokeStyle = this.colorFor(k);
        this.ctx.setLineDash(dashed ? DASH_PATTERN : []);
        fineMoveTo(
          this.ctx,
          this.scaling,
          scale(
            ts[range.first] - graphNowMs + o.windowMs,
            0,
            o.windowMs,
            0,
            width,
          ),
          scale(vs[range.first], axis.min, axis.max, height, 0),
        );
        for (let j = range.first + 1; j <= range.last; j++) {
          fineLineTo(
            this.ctx,
            this.scaling,
            scale(ts[j] - graphNowMs + o.windowMs, 0, o.windowMs, 0, width),
            scale(vs[j], axis.min, axis.max, height, 0),
          );
        }
        this.ctx.stroke();
        this.ctx.setLineDash([]);
      });

    this.ctx.restore();
  }

  getOptions() {
    return this.options;
  }

  setOptions(options: Options) {
    Object.assign(this.options, options);
  }
}
