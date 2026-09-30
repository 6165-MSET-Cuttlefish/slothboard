import React, { Component } from 'react';
import { connect, ConnectedProps } from 'react-redux';

import BaseView, {
  BaseViewHeading,
  BaseViewBody,
  BaseViewIcons,
  BaseViewIconButton,
  BaseViewProps,
  BaseViewHeadingProps,
} from '@/components/views/BaseView';
import MultipleCheckbox from './MultipleCheckbox';
import GraphCanvas from './GraphCanvas';
import GraphSeriesList from './GraphSeriesList';
import ReplayBadge from '@/components/views/ReplayBadge';
import TextInput from '@/components/views/ConfigView/inputs/TextInput';

import { ReactComponent as ChartIcon } from '@/assets/icons/chart.svg';
import { ReactComponent as CloseIcon } from '@/assets/icons/close.svg';
import { ReactComponent as PlayIcon } from '@/assets/icons/play_arrow.svg';
import { ReactComponent as PauseIcon } from '@/assets/icons/pause.svg';
import { ReactComponent as PaletteIcon } from '@/assets/icons/palette.svg';
import { ReactComponent as FullscreenIcon } from '@/assets/icons/fullscreen.svg';
import { ReactComponent as FullscreenExitIcon } from '@/assets/icons/fullscreen_exit.svg';

import { RootState } from '@/store/reducers';
import { STOP_OP_MODE_TAG } from '@/store/types';
import { OpModeStatus } from '@/enums/OpModeStatus';
import { colors, ThemeConsumer } from '@/hooks/useTheme';
import { DEFAULT_OPTIONS } from './Graph';
import { pickDefaultColor, sameColor } from './colors';
import { validateInt, ValResult } from '@/components/inputs/validation';

// a window of zero or less has no meaning and divides by zero when plotting
const validateWindowMs = (raw: string): ValResult<number> => {
  const result = validateInt(raw);

  return result.valid && result.value <= 0
    ? { value: raw, valid: false }
    : result;
};

type TimeBounds = {
  minMs: number;
  maxMs: number;
};

// Safari before 16.4 only exposes the webkit-prefixed Fullscreen API
type FullscreenDocument = {
  fullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type FullscreenElement = {
  requestFullscreen?: () => Promise<void> | void;
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type GraphViewState = {
  graphing: boolean;
  opmodePaused: boolean;
  userPaused: boolean;
  pausedTime: number;
  availableKeys: string[];
  // selection doubles as the layer order: the first key is drawn in front
  selectedKeys: string[];
  // colors are remembered per key, including for keys that are unchecked and
  // later re-checked; a Map because keys like 'constructor' come from the robot
  keyColors: ReadonlyMap<string, string>;
  showSeriesSettings: boolean;
  windowMs: ValResult<number>;
  // telemetry time shown at the right edge while scrubbing; null follows live data
  scrubMs: number | null;
  // telemetry time the frozen plot is actually showing at its right edge
  shownMs: number | null;
  timeBounds: TimeBounds | null;
  // bumped to clear the recorded history when a new op mode run begins
  runId: number;
  isFullscreen: boolean;
  // replaying the recorded history forward in real time, cursor and all
  playing: boolean;
};

const mapStateToProps = (state: RootState) => ({
  telemetry: state.telemetry,
  status: state.status,
  // Individual fields rather than the whole slice: state.playback gets a new
  // identity on every cursor tick, which would re-render the graph at 10 Hz on
  // top of the telemetry-driven renders.
  playbackMode: state.playback.mode,
  isReplaying: state.playback.isPlaying,
  foldToken: state.playback.foldToken,
  // Recorded values for the frame currently overlaid, in 'alongside' mode.
  replayData: state.replay.data,
});

const connector = connect(mapStateToProps);

type GraphViewProps = ConnectedProps<typeof connector> &
  BaseViewProps &
  BaseViewHeadingProps;

class GraphView extends Component<GraphViewProps, GraphViewState> {
  containerRef: React.RefObject<HTMLDivElement>;

  /** GraphCanvas adds once per batch, deciding by deep-comparing this array, so
   *  rebuilding it on every replay tick would re-add the same live samples. */
  private memo: {
    telemetry: GraphViewProps['telemetry'];
    selectedKeys: string[];
    mode: string;
    rows: { name: string; value: number; recorded?: boolean }[][];
  } | null = null;

  playFrameId: number | null = null;
  lastPlayFrameMs = 0;

  constructor(props: GraphViewProps) {
    super(props);

    this.state = {
      graphing: false,
      opmodePaused: false,
      userPaused: false,
      pausedTime: 0,
      availableKeys: [],
      selectedKeys: [],
      keyColors: new Map(),
      showSeriesSettings: false,
      windowMs: {
        value: DEFAULT_OPTIONS.windowMs,
        valid: true,
      },
      scrubMs: null,
      shownMs: null,
      timeBounds: null,
      runId: 0,
      isFullscreen: false,
      playing: false,
    };

    this.containerRef = React.createRef();

    this.start = this.start.bind(this);
    this.stop = this.stop.bind(this);

    this.userPlay = this.userPlay.bind(this);
    this.userPause = this.userPause.bind(this);

    this.handleSelectionChange = this.handleSelectionChange.bind(this);
    this.handleReorder = this.handleReorder.bind(this);
    this.handleColorChange = this.handleColorChange.bind(this);
    this.handleColorReset = this.handleColorReset.bind(this);

    this.keepFocusOnView = this.keepFocusOnView.bind(this);
    this.handleDocumentKeydown = this.handleDocumentKeydown.bind(this);
    this.handleFullscreenChange = this.handleFullscreenChange.bind(this);
    this.toggleFullscreen = this.toggleFullscreen.bind(this);
    this.onTimeBounds = this.onTimeBounds.bind(this);
    this.onShownTime = this.onShownTime.bind(this);
    this.goLive = this.goLive.bind(this);

    this.togglePlayback = this.togglePlayback.bind(this);
    this.startReplay = this.startReplay.bind(this);
    this.pauseReplay = this.pauseReplay.bind(this);
    this.playTick = this.playTick.bind(this);
  }

  // Keep focus on the view, or Space after clicking "Start Graphing" would
  // activate that button and stop graphing instead of toggling pause.
  keepFocusOnView(evt: React.MouseEvent) {
    evt.preventDefault();
    // Scrolling the tile into view would move the button from under the
    // pointer and lose the click.
    this.containerRef.current?.focus({ preventScroll: true });
  }

  componentDidMount() {
    if (this.containerRef.current) {
      this.containerRef.current.addEventListener(
        'keydown',
        this.handleDocumentKeydown,
      );
    }

    document.addEventListener('fullscreenchange', this.handleFullscreenChange);
    document.addEventListener(
      'webkitfullscreenchange',
      this.handleFullscreenChange,
    );
  }

  componentWillUnmount() {
    if (this.containerRef.current) {
      this.containerRef.current.removeEventListener(
        'keydown',
        this.handleDocumentKeydown,
      );
    }

    document.removeEventListener(
      'fullscreenchange',
      this.handleFullscreenChange,
    );
    document.removeEventListener(
      'webkitfullscreenchange',
      this.handleFullscreenChange,
    );

    this.cancelPlayback();
  }

  componentDidUpdate(prevProps: GraphViewProps) {
    if (this.noOpmodeRunning(this.props) && !this.noOpmodeRunning(prevProps)) {
      this.opmodePause();
    }
    if (!this.noOpmodeRunning(this.props) && this.noOpmodeRunning(prevProps)) {
      this.opmodePlay();
      // A resumed recording drives the plot again: an in-graph replay left over
      // from the pause would keep it frozen, and so would a scrub unless the
      // panel itself is paused.
      if (this.props.playbackMode === 'playback') {
        this.cancelPlayback();
        this.setState((state) => ({
          playing: false,
          scrubMs: state.userPaused ? state.scrubMs : null,
        }));
      }
    }

    // A load, seek or close re-bases the recording's clock, so an old scrub
    // position would point into some other stretch of it. shownMs stays: the
    // canvas already re-reported it in this same batch.
    if (this.props.foldToken !== prevProps.foldToken) {
      this.cancelPlayback();
      this.setState({ scrubMs: null, playing: false });
    }

    if (this.opmodeRunStarted(this.props, prevProps)) this.resetHistory();

    if (this.props.telemetry === prevProps.telemetry) return;

    this.setState((state) => {
      if (this.props.telemetry.length === 0) {
        return { availableKeys: [], selectedKeys: state.selectedKeys };
      }

      const availableKeys = [...state.availableKeys];
      for (const { data } of this.props.telemetry) {
        for (const k of Object.keys(data)) {
          if (isNaN(parseFloat(data[k]))) continue;

          if (availableKeys.includes(k)) continue;

          availableKeys.push(k);
        }
      }

      return {
        availableKeys,
        selectedKeys: state.selectedKeys,
      };
    });
  }

  handleSelectionChange(selectedKeys: string[]) {
    this.setState((state) => {
      const keyColors = new Map(state.keyColors);

      // Only arriving keys need a color picked; only theirs can collide.
      const staying = selectedKeys.filter((key) =>
        state.selectedKeys.includes(key),
      );
      const arriving = selectedKeys.filter(
        (key) => !state.selectedKeys.includes(key),
      );

      const used = staying
        .map((key) => keyColors.get(key))
        .filter((color): color is string => color !== undefined);

      for (const key of arriving) {
        // A returning key keeps its old color unless another line took it.
        const remembered = keyColors.get(key);
        const color =
          remembered !== undefined &&
          !used.some((taken) => sameColor(taken, remembered))
            ? remembered
            : pickDefaultColor(used);

        keyColors.set(key, color);
        used.push(color);
      }

      return { selectedKeys, keyColors };
    });
  }

  // Only the shown keys move; absent ones keep their slots in the selection.
  handleReorder(shownKeys: string[]) {
    this.setState((state) => {
      let next = 0;
      return {
        selectedKeys: state.selectedKeys.map((key) =>
          shownKeys.includes(key) ? shownKeys[next++] : key,
        ),
      };
    });
  }

  handleColorChange(key: string, color: string) {
    this.setState((state) => ({
      keyColors: new Map(state.keyColors).set(key, color),
    }));
  }

  handleColorReset(key: string) {
    this.setState((state) => {
      const used = state.selectedKeys
        .filter((k) => k !== key)
        .map((k) => state.keyColors.get(k))
        .filter((color): color is string => color !== undefined);

      return {
        keyColors: new Map(state.keyColors).set(key, pickDefaultColor(used)),
      };
    });
  }

  handleDocumentKeydown(evt: KeyboardEvent) {
    if (!this.state.graphing) return;

    // Leave keystrokes aimed at fields and buttons alone; the scrub slider's
    // arrow keys pan the graph like everywhere else in the view.
    const target = evt.target as HTMLElement | null;
    const field = target?.closest?.(
      'input, textarea, select, [contenteditable="true"]',
    );
    if (field && !(field instanceof HTMLInputElement && field.type === 'range'))
      return;
    if (
      (evt.code === 'Space' || evt.key === 'Enter') &&
      target?.closest?.('button')
    )
      return;

    if (evt.code === 'Space' || evt.key === 'k') {
      evt.preventDefault();
      this.togglePlayback();
    } else if (evt.key === 'ArrowLeft' || evt.key === 'ArrowRight') {
      evt.preventDefault();

      const windowMs = this.effectiveWindowMs();
      const step = windowMs * (evt.shiftKey ? 1 : 0.1);
      this.scrubBy(evt.key === 'ArrowLeft' ? -step : step);
    } else if (evt.key === 'Home') {
      evt.preventDefault();
      this.scrubTo(this.getScrubRange()?.min ?? null);
    } else if (evt.key === 'End') {
      evt.preventDefault();
      this.goLive();
    } else if (
      evt.key === 'Escape' &&
      this.state.scrubMs !== null &&
      !this.state.isFullscreen
    ) {
      // in fullscreen the browser claims Escape for exiting
      this.goLive();
    }
  }

  handleFullscreenChange() {
    this.setState({
      isFullscreen: this.fullscreenElement() === this.containerRef.current,
    });
  }

  fullscreenElement() {
    const doc = document as unknown as FullscreenDocument;

    return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  }

  toggleFullscreen() {
    const doc = document as unknown as FullscreenDocument;
    const el = this.containerRef.current as unknown as FullscreenElement | null;

    const toggle =
      this.fullscreenElement() === this.containerRef.current
        ? (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.bind(doc)
        : (el?.requestFullscreen ?? el?.webkitRequestFullscreen)?.bind(el);

    Promise.resolve(toggle?.()).catch(() => {
      // the browser refused; nothing to do but stay windowed
    });
  }

  noOpmodeRunning(props: GraphViewProps) {
    // While a recording drives the view, the robot's status is irrelevant and
    // often absent: opModeInfoList is empty whenever the dashboard is
    // disconnected, which is just the offline pit-review case, and reading it
    // here would keep the graph paused for the whole replay.
    if (props.playbackMode === 'playback') return !props.isReplaying;

    return (
      props.status.opModeInfoList?.length === 0 ||
      props.status.activeOpMode === STOP_OP_MODE_TAG ||
      props.status.activeOpModeStatus === OpModeStatus.STOPPED
    );
  }

  // a dropped socket empties opModeInfoList without ending the run, so a new
  // run is recognised from the op mode status alone
  opmodeRunStarted(props: GraphViewProps, prevProps: GraphViewProps) {
    const stopped = (status: GraphViewProps['status']) =>
      status.activeOpMode === STOP_OP_MODE_TAG ||
      status.activeOpModeStatus === OpModeStatus.STOPPED;

    if (stopped(props.status)) return false;
    if (stopped(prevProps.status)) return true;

    return props.status.activeOpMode !== prevProps.status.activeOpMode;
  }

  // true whenever the plot is frozen, whether by the user, a stopped op mode, or scrubbing
  isPaused() {
    return (
      this.state.userPaused ||
      this.state.opmodePaused ||
      this.state.scrubMs !== null
    );
  }

  effectiveWindowMs() {
    const { windowMs } = this.state;

    return windowMs.valid && windowMs.value > 0
      ? windowMs.value
      : DEFAULT_OPTIONS.windowMs;
  }

  // the span of positions the scrub slider can address; the right edge of the
  // plot can go no further left than one window past the oldest sample, or
  // than the start of a recording shorter than the window
  scrubRangeFor(bounds: TimeBounds) {
    const windowEnd = bounds.minMs + this.effectiveWindowMs();

    return {
      min: windowEnd <= bounds.maxMs ? windowEnd : bounds.minMs,
      max: bounds.maxMs,
    };
  }

  getScrubRange() {
    const bounds = this.state.timeBounds;

    return bounds === null ? null : this.scrubRangeFor(bounds);
  }

  onTimeBounds(timeBounds: TimeBounds | null) {
    this.setState((state) => {
      if (state.scrubMs === null || timeBounds === null) {
        return { timeBounds, scrubMs: state.scrubMs };
      }

      // a truncated history can leave the scrub position out of range
      const range = this.scrubRangeFor(timeBounds);

      return {
        timeBounds,
        scrubMs: Math.min(Math.max(state.scrubMs, range.min), range.max),
      };
    });
  }

  onShownTime(shownMs: number) {
    if (this.state.shownMs === shownMs) return;

    this.setState({ shownMs });
  }

  scrubTo(scrubMs: number | null) {
    const range = this.getScrubRange();
    if (range === null || scrubMs === null) return;

    this.setState((state) => ({
      scrubMs: Math.max(range.min, Math.min(range.max, scrubMs)),
      pausedTime: this.isPaused() ? state.pausedTime : Date.now(),
    }));
  }

  scrubBy(deltaMs: number) {
    const range = this.getScrubRange();
    if (range === null) return;

    this.scrubTo((this.state.scrubMs ?? range.max) + deltaMs);
  }

  goLive() {
    this.cancelPlayback();

    // with the op mode over, End goes to the end of the recording
    const range = this.getScrubRange();
    const endMs =
      this.noOpmodeRunning(this.props) && range !== null ? range.max : null;

    this.setState((state) => ({
      scrubMs: endMs,
      playing: false,
      pausedTime: this.isPaused() ? state.pausedTime : Date.now(),
    }));
  }

  cancelPlayback() {
    if (this.playFrameId !== null) {
      cancelAnimationFrame(this.playFrameId);
      this.playFrameId = null;
    }
  }

  // true when the recorded history can be replayed: the op mode is over, so
  // nothing new is arriving to fight the cursor for the right edge
  canReplay() {
    const range = this.getScrubRange();

    return (
      this.noOpmodeRunning(this.props) &&
      range !== null &&
      range.max > range.min
    );
  }

  // plays the history forward from the cursor at 1x, since telemetry time and
  // wall time are both in milliseconds
  startReplay() {
    const range = this.getScrubRange();
    if (range === null || range.max <= range.min) return;

    // starting from the end (or from live) replays the run from the beginning
    const cursor = this.state.scrubMs;
    const from = cursor === null || cursor >= range.max ? range.min : cursor;

    this.cancelPlayback();
    this.lastPlayFrameMs = performance.now();
    this.setState((state) => ({
      playing: true,
      scrubMs: from,
      pausedTime: this.isPaused() ? state.pausedTime : Date.now(),
    }));
    this.playFrameId = requestAnimationFrame(this.playTick);
  }

  pauseReplay() {
    this.cancelPlayback();
    this.setState({ playing: false });
  }

  playTick(now: number) {
    const range = this.getScrubRange();
    if (range === null) {
      this.pauseReplay();
      return;
    }

    const dt = now - this.lastPlayFrameMs;
    this.lastPlayFrameMs = now;

    const next = (this.state.scrubMs ?? range.min) + dt;

    if (next >= range.max) {
      // played out to the end of the recording
      this.cancelPlayback();
      this.setState({ scrubMs: range.max, playing: false });
      return;
    }

    this.setState({ scrubMs: Math.max(range.min, next) });
    this.playFrameId = requestAnimationFrame(this.playTick);
  }

  resetHistory() {
    this.cancelPlayback();
    this.setState((state) => ({
      runId: state.runId + 1,
      scrubMs: null,
      shownMs: null,
      timeBounds: null,
      playing: false,
    }));
  }

  start() {
    this.setState({
      ...this.state,
      graphing: true,
      userPaused: false,
      scrubMs: null,
      shownMs: null,
      timeBounds: null,
      playing: false,
    });
  }

  stop() {
    this.cancelPlayback();
    this.setState({
      ...this.state,
      graphing: false,
      playing: false,
      scrubMs: null,
      shownMs: null,
      timeBounds: null,
    });
  }

  userPause() {
    this.setState({
      ...this.state,
      userPaused: true,
      pausedTime: this.isPaused() ? this.state.pausedTime : Date.now(),
    });
  }

  // Partial updates: a replay pauses in the same batch as the canvas reports
  // new time bounds, which spreading this.state would put back.
  opmodePause() {
    this.setState({
      opmodePaused: true,
      pausedTime: this.isPaused() ? this.state.pausedTime : Date.now(),
    });
  }

  userPlay() {
    this.setState({
      ...this.state,
      userPaused: false,
    });
  }

  opmodePlay() {
    this.setState({
      opmodePaused: false,
    });
  }

  // Keys the current op mode is not sending stay selected, so they come back
  // checked when it sends them again, but have no line to edit until then.
  // Every op mode init and telemetry.clear() empties availableKeys, so until
  // the next packet the selection stands in for it.
  shownKeys() {
    const { selectedKeys, availableKeys } = this.state;
    if (availableKeys.length === 0) return selectedKeys;
    return selectedKeys.filter((key) => availableKeys.includes(key));
  }

  renderSeriesList(
    shownKeys: string[],
    seriesColors: { [key: string]: string },
  ) {
    return (
      <>
        <GraphSeriesList
          seriesKeys={shownKeys}
          colors={seriesColors}
          onReorder={this.handleReorder}
          onColorChange={this.handleColorChange}
          onColorReset={this.handleColorReset}
        />
        {shownKeys.length > 1 && (
          <p className="mt-1 text-sm opacity-60">
            The first line is drawn in front of the others.
          </p>
        )}
      </>
    );
  }

  // colors of the graphed keys only; the rest are remembered but unused
  seriesColors() {
    return Object.fromEntries(
      [...this.state.keyColors].filter(([key]) =>
        this.state.selectedKeys.includes(key),
      ),
    );
  }

  /** Rows for GraphCanvas, rebuilt only when the live batch changes. */
  buildRows() {
    const m = this.memo;
    if (
      m &&
      m.telemetry === this.props.telemetry &&
      m.mode === this.props.playbackMode &&
      m.selectedKeys.length === this.state.selectedKeys.length &&
      m.selectedKeys.every((k, i) => k === this.state.selectedKeys[i])
    ) {
      return m.rows;
    }

    const history = this.props.telemetry.filter((packet) => !packet.seed);
    const rows = history.map((packet, i, all) => {
      const row = [
        { name: 'time', value: packet.timestamp },
        ...Object.keys(packet.data)
          .filter((key) => this.state.selectedKeys.includes(key))
          .map((key) => ({ name: key, value: parseFloat(packet.data[key]) })),
      ];

      // Recorded values as their own dashed series, stamped with this packet's
      // timestamp rather than the recording's so both traces share one clock.
      // Last packet of the batch only, or the recorded trace repeats.
      if (this.props.playbackMode === 'ghost' && i === all.length - 1) {
        for (const key of this.state.selectedKeys) {
          const raw = this.props.replayData[key];
          if (raw === undefined) continue;

          const value = parseFloat(raw);
          if (isNaN(value)) continue;

          row.push({ name: key, value, recorded: true } as typeof row[number]);
        }
      }

      return row;
    });

    this.memo = {
      telemetry: this.props.telemetry,
      selectedKeys: [...this.state.selectedKeys],
      mode: this.props.playbackMode,
      rows,
    };
    return rows;
  }

  playPauseTitle() {
    if (this.noOpmodeRunning(this.props)) {
      if (this.state.playing) return 'Pause Replay';

      return this.canReplay()
        ? 'Replay the recording from the cursor'
        : 'Nothing recorded to replay yet';
    }

    return this.state.userPaused ? 'Resume Graphing' : 'Pause Graphing';
  }

  togglePlayback() {
    if (this.noOpmodeRunning(this.props)) {
      if (this.state.playing) {
        this.pauseReplay();
      } else {
        this.startReplay();
      }
    } else if (this.state.userPaused) {
      this.userPlay();
    } else {
      this.userPause();
    }
  }

  renderScrubber() {
    const bounds = this.state.timeBounds;
    const range = this.getScrubRange();

    const scrubbable =
      bounds !== null && range !== null && range.max > range.min;

    // a frozen plot does not follow the newest sample, so the readout shows
    // the window last drawn, clamped to the recording for display
    const shownEnd =
      this.state.scrubMs ?? (this.isPaused() ? this.state.shownMs : null);
    const position =
      range === null
        ? 0
        : Math.min(Math.max(shownEnd ?? range.max, range.min), range.max);

    const replayMode = this.noOpmodeRunning(this.props);
    const atEnd = range === null || (shownEnd ?? range.max) === range.max;

    // the slider works in ms since the start of the history rather than in
    // absolute telemetry time, which keeps the numbers small and the readout
    // honest: 0 s really is the beginning of the run
    const windowMs = this.effectiveWindowMs();
    const spanMs = bounds === null ? 0 : bounds.maxMs - bounds.minMs;
    const relPosition = bounds === null ? 0 : position - bounds.minMs;
    const relMin =
      bounds === null || range === null ? 0 : range.min - bounds.minMs;

    const windowEndS = relPosition / 1000;
    const windowStartS = Math.max(0, relPosition - windowMs) / 1000;
    const totalS = spanMs / 1000;

    return (
      <div className="flex items-center space-x-3 py-1">
        <input
          type="range"
          min={relMin}
          max={spanMs || 1}
          step={1}
          value={relPosition}
          disabled={!scrubbable}
          onChange={(evt) =>
            this.scrubTo((bounds?.minMs ?? 0) + parseFloat(evt.target.value))
          }
          title={
            scrubbable
              ? 'Drag to pan through the recorded history (or use the arrow keys)'
              : 'Not enough history recorded to pan yet'
          }
          className="h-2 min-w-0 flex-1 cursor-pointer appearance-none rounded-lg bg-gray-200 disabled:cursor-default disabled:opacity-50 dark:bg-slate-700
            [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary-500
            [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary-500"
        />
        <span
          className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs tabular-nums text-gray-600 dark:text-gray-400"
          title="Visible window, and the total length of the recorded history"
        >
          {bounds === null ? (
            <>&mdash;</>
          ) : (
            <>
              {windowStartS.toFixed(1)}&ndash;{windowEndS.toFixed(1)}s of{' '}
              {totalS.toFixed(1)}s
            </>
          )}
        </span>
        <button
          className="rounded-md border border-gray-200 bg-gray-100 py-1 px-3 text-sm shadow-md transition-colors hover:bg-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-opacity-30 disabled:opacity-50 disabled:hover:bg-gray-100 dark:border-slate-600 dark:bg-slate-700 dark:hover:bg-slate-600 dark:disabled:hover:bg-slate-700"
          onClick={this.goLive}
          disabled={replayMode ? atEnd : this.state.scrubMs === null}
          title={
            replayMode
              ? 'Jump to the end of the recording'
              : 'Return to the live end of the graph'
          }
        >
          {replayMode ? 'End' : 'Live'}
        </button>
      </div>
    );
  }

  render() {
    const showNoNumeric =
      !this.state.graphing && this.state.availableKeys.length === 0;
    const showEmpty =
      this.state.graphing && this.state.selectedKeys.length === 0;
    const showText = showNoNumeric || showEmpty;

    // with the op mode over, the play button replays the recording instead of
    // resuming a live feed that isn't coming back
    const replayMode = this.noOpmodeRunning(this.props);

    const graphData = this.buildRows();

    const shownKeys = this.shownKeys();
    const seriesColors = this.seriesColors();

    // markers sent from robot code share their packet's timestamp; a seek's
    // seed repeats the last packet's, so it is skipped like in buildRows
    const markers = this.props.telemetry
      .filter((packet) => !packet.seed)
      .flatMap((packet) =>
        (packet.markers ?? []).map((label) => ({
          t: packet.timestamp,
          label,
        })),
      );

    return (
      <BaseView
        className="flex flex-col overflow-auto"
        isUnlocked={this.props.isUnlocked}
        ref={this.containerRef}
        tabIndex={0}
      >
        <div className="flex">
          <BaseViewHeading isDraggable={this.props.isDraggable}>
            Graph
            {this.props.playbackMode === 'playback' && (
              <ReplayBadge source="replacing" />
            )}
            {this.props.playbackMode === 'ghost' && (
              <ReplayBadge source="alongside" />
            )}
          </BaseViewHeading>
          <BaseViewIcons>
            {this.state.graphing && shownKeys.length !== 0 && (
              <BaseViewIconButton
                title={
                  this.state.showSeriesSettings
                    ? 'Hide Line Settings'
                    : 'Show Line Settings'
                }
                className="icon-btn h-8 w-8"
                onMouseDown={this.keepFocusOnView}
                onClick={() =>
                  this.setState((state) => ({
                    showSeriesSettings: !state.showSeriesSettings,
                  }))
                }
              >
                <PaletteIcon className="h-5 w-5" viewBox="0 0 50 50" />
              </BaseViewIconButton>
            )}

            {this.state.graphing && this.state.selectedKeys.length !== 0 && (
              <BaseViewIconButton
                title={this.playPauseTitle()}
                disabled={
                  replayMode && !this.state.playing && !this.canReplay()
                }
                className="icon-btn h-8 w-8 disabled:opacity-40"
                onMouseDown={this.keepFocusOnView}
                // on the button rather than the icon so that Space and Enter
                // activate it like any other button
                onClick={this.togglePlayback}
              >
                {(replayMode ? !this.state.playing : this.state.userPaused) ? (
                  <PlayIcon className="h-6 w-6" />
                ) : (
                  <PauseIcon className="h-6 w-6" />
                )}
              </BaseViewIconButton>
            )}

            <BaseViewIconButton
              title={this.state.isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
              onMouseDown={this.keepFocusOnView}
              onClick={this.toggleFullscreen}
            >
              {this.state.isFullscreen ? (
                <FullscreenExitIcon className="h-6 w-6" />
              ) : (
                <FullscreenIcon className="h-6 w-6" />
              )}
            </BaseViewIconButton>

            <BaseViewIconButton
              title={this.state.graphing ? 'Stop Graphing' : 'Start Graphing'}
              onMouseDown={this.keepFocusOnView}
              onClick={this.state.graphing ? this.stop : this.start}
            >
              {this.state.graphing ? (
                <CloseIcon className="h-6 w-6" />
              ) : (
                <ChartIcon className="h-6 w-6" />
              )}
            </BaseViewIconButton>
          </BaseViewIcons>
        </div>
        <BaseViewBody className={showText ? 'flex-center' : ''}>
          {!this.state.graphing ? (
            showNoNumeric ? (
              <p className="justify-self-center text-center">
                Send number-valued telemetry data to graph them over time
              </p>
            ) : (
              <>
                <p className="my-2 text-center">
                  Press the upper-right button to graph selected keys over time
                </p>
                <p className="my-2 text-center text-sm opacity-75">
                  Click the graph to add a marker, type a label and press Enter;
                  click a marker to remove it
                </p>
                <h3 className="mt-6 font-medium">Telemetry to graph:</h3>
                <div className="ml-3">
                  <MultipleCheckbox
                    // Copies `selected` into state in its constructor with
                    // no derived-state hook, so remounting is the only way to
                    // re-seed it when a recording loads or seeks backwards.
                    key={this.props.foldToken}
                    arr={this.state.availableKeys}
                    onChange={this.handleSelectionChange}
                    selected={this.state.selectedKeys}
                  />
                </div>
                {shownKeys.length !== 0 && (
                  <div className="mt-4">
                    <h3 className="font-medium">Lines:</h3>
                    <div className="ml-3">
                      {this.renderSeriesList(shownKeys, seriesColors)}
                    </div>
                  </div>
                )}
                <div className="mt-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-medium">Options:</h3>
                  </div>
                  <div className="ml-3">
                    <table>
                      <tbody>
                        <tr>
                          <td>Window (ms)</td>
                          <td>
                            <TextInput
                              value={this.state.windowMs.value}
                              valid={this.state.windowMs.valid}
                              validate={validateWindowMs}
                              onChange={(arg) =>
                                this.setState({
                                  windowMs: arg,
                                })
                              }
                            />
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )
          ) : showEmpty ? (
            <p className="justify-self-center text-center">
              No telemetry selected to graph
            </p>
          ) : (
            <div
              className="flex h-full flex-col"
              // focus the view so the arrow keys pan the graph
              onMouseDown={() =>
                this.containerRef.current?.focus({ preventScroll: true })
              }
            >
              <div className="relative min-h-0 flex-1">
                <ThemeConsumer>
                  {({ isDarkMode }) => (
                    <GraphCanvas
                      batch={this.props.telemetry}
                      data={graphData}
                      markers={markers}
                      options={{
                        windowMs: this.effectiveWindowMs(),
                        seriesOrder: this.state.selectedKeys,
                        seriesColors,
                        gridLineColor: isDarkMode
                          ? colors.slate[500]
                          : colors.gray[300],
                        textColor: isDarkMode
                          ? colors.slate[100]
                          : colors.gray[900],
                        crosshairColor: isDarkMode
                          ? colors.slate[300]
                          : colors.gray[500],
                        // matches the BaseView background (bg-white / dark:bg-slate-900)
                        backgroundColor: isDarkMode
                          ? colors.slate[900]
                          : 'rgb(255, 255, 255)',
                        markerColor: isDarkMode
                          ? colors.slate[300]
                          : colors.gray[600],
                      }}
                      paused={this.isPaused()}
                      userPaused={this.state.userPaused}
                      pausedTime={this.state.pausedTime}
                      scrubMs={this.state.scrubMs}
                      runId={this.state.runId}
                      onTimeBounds={this.onTimeBounds}
                      onShownTime={this.onShownTime}
                      resetToken={this.props.foldToken}
                      showRecorded={this.props.playbackMode === 'ghost'}
                      replayDriven={this.props.playbackMode === 'playback'}
                    />
                  )}
                </ThemeConsumer>
                {/* anchored to the top rather than full-bleed so the lines it
                  restyles stay visible underneath */}
                {this.state.showSeriesSettings && shownKeys.length !== 0 && (
                  <div className="absolute inset-x-0 top-0 max-h-full overflow-auto rounded border border-gray-200 bg-white p-3 shadow-md dark:border-slate-600 dark:bg-slate-900">
                    <h3 className="font-medium">Lines:</h3>
                    <div className="ml-3">
                      {this.renderSeriesList(shownKeys, seriesColors)}
                    </div>
                  </div>
                )}
              </div>
              {this.renderScrubber()}
            </div>
          )}
        </BaseViewBody>
      </BaseView>
    );
  }
}

export default connector(GraphView);
