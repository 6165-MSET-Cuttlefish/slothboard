import React from 'react';
import PropTypes from 'prop-types';

import Graph from './Graph';
import GraphTooltip from './GraphTooltip';
import AutoFitCanvas from '@/components/Canvas/AutoFitCanvas';
import { isEqual } from 'lodash';

// how close (in CSS pixels) a press must land to a marker to remove it
const MARKER_HIT_RADIUS = 8;

// approximate size of the label input, in CSS pixels; only used to keep it
// from hanging off the edge of the canvas
const DRAFT_WIDTH = 128;
const DRAFT_HEIGHT = 26;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

class GraphCanvas extends React.Component {
  constructor(props) {
    super(props);

    this.canvasRef = React.createRef();
    this.containerRef = React.createRef();
    this.draftRef = React.createRef();

    // a live graph moves a marker away between the press and the click
    this.pressedMarker = null;
    this.pressedInDraft = false;

    this.renderGraph = this.renderGraph.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleMouseLeave = this.handleMouseLeave.bind(this);
    this.handleMouseDown = this.handleMouseDown.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.handleDraftChange = this.handleDraftChange.bind(this);
    this.handleDraftKeydown = this.handleDraftKeydown.bind(this);

    this.unsubs = []; // unsub functions to be called to cleanup

    // time of the frame currently on the canvas
    this.lastRenderTimeMs = null;

    this.reportedBounds = null;

    this.state = {
      graphEmpty: false,
      hover: null,
      containerWidth: 0,
      containerHeight: 0,
      // the marker being labeled by the user, if any
      markerDraft: null,
    };
  }

  componentDidMount() {
    this.graph = new Graph(this.canvasRef.current, this.props.options);

    // no props change once the op mode is over, so draw now or nothing shows
    this.renderGraph();
  }

  componentWillUnmount() {
    this.cancelPendingFrame();
  }

  // TODO: Regretably, the current design requires that this.graph.add() only be called
  // once for each batch of telemetry. Violations of this contract cause artifacts in the
  // graph from out-of-order samples. (The graph code could be made more robust here, but
  // mitigating the issue here works just as well.)
  componentDidUpdate(prevProps) {
    let graphIsDirty = false;

    if (!isEqual(this.props.options, prevProps.options)) {
      this.graph.setOptions({
        ...this.graph.getOptions(),
        ...this.props.options,
      });
      graphIsDirty = true;
    }

    // a new op mode run starts the history over
    if (this.props.runId !== prevProps.runId) {
      this.graph.reset();
      this.reportBounds();
      graphIsDirty = true;
    }

    if (!prevProps.paused && this.props.paused) this.frozenAt = Date.now();
    if (
      prevProps.paused &&
      !this.props.paused &&
      this.props.replayDriven &&
      !prevProps.userPaused
    ) {
      // The recording paused too, so what is plotted moves up to meet it.
      this.graph.shift(Date.now() - (this.frozenAt ?? Date.now()));
    }

    // Before the add below: a seek re-sends history older than what is plotted.
    const didReset = prevProps.resetToken !== this.props.resetToken;
    if (didReset) {
      this.graph.reset();
      this.lastRenderTimeMs = null;
      this.reportBounds();
    } else if (prevProps.showRecorded && !this.props.showRecorded) {
      this.graph.dropRecorded();
      this.reportBounds();
      graphIsDirty = true;
    }

    const dataChanged = !isEqual(this.props.data, prevProps.data);

    // samples are recorded even while paused so that the full history remains
    // available for scrubbing
    if (dataChanged) {
      this.graph.add(Date.now(), this.props.data, this.props.markers);
      this.reportBounds();
    }

    if (prevProps.paused && !this.props.paused && !this.props.replayDriven) {
      // pick playback back up at the newest sample rather than replaying the
      // stretch of telemetry time that elapsed while paused
      this.graph.resync(Date.now());
    }

    // With the RAF loop stopped this is the only place a paused plot repaints.
    // The panel's own Pause holds it still as the replay plays, but not a seek.
    if (
      this.props.replayDriven &&
      this.props.paused &&
      (didReset || (dataChanged && !this.props.userPaused))
    ) {
      const now = Date.now();
      // onResize needs this: pausedTime is nowhere near a scrubbed playhead.
      this.lastRenderTimeMs = now;
      this.frozenAt = now;
      graphIsDirty = true;
    } else if (dataChanged) {
      graphIsDirty = true;
    }

    if (this.props.scrubMs !== prevProps.scrubMs) graphIsDirty = true;

    if (!this.props.paused && !this.requestId) graphIsDirty = true;

    if (graphIsDirty) this.renderGraph();
  }

  // the graph reports hover positions in canvas space; the tooltip is
  // positioned in container space
  measureContainer() {
    const canvas = this.canvasRef.current;
    const container = this.containerRef.current;
    if (!canvas || !container) return;

    const canvasRect = canvas.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    this.canvasOffset = {
      x: canvasRect.left - containerRect.left,
      y: canvasRect.top - containerRect.top,
    };

    this.setState({
      containerWidth: containerRect.width,
      containerHeight: containerRect.height,
    });
  }

  // the animation loop is stopped while paused, so hovering has to redraw itself
  renderPausedFrame() {
    if (!this.graph) return;

    this.measureContainer();

    // a frozen frame has to be redrawn at the time it was first drawn at
    const time = this.lastRenderTimeMs ?? this.props.pausedTime;
    this.lastRenderTimeMs = time;

    this.setState({
      graphEmpty: !this.graph.render(time, this.props.scrubMs),
      hover: this.graph.getHover(),
    });
  }

  handleMouseMove(evt) {
    const canvas = this.canvasRef.current;
    if (!this.graph || !canvas) return;

    const canvasRect = canvas.getBoundingClientRect();

    this.graph.setCursor({
      x: evt.clientX - canvasRect.left,
      y: evt.clientY - canvasRect.top,
    });

    if (this.props.paused) {
      this.renderPausedFrame();
    } else {
      this.measureContainer();
    }
  }

  handleMouseLeave() {
    if (!this.graph) return;

    this.graph.setCursor(null);

    if (this.props.paused) {
      this.renderPausedFrame();
    } else {
      this.setState({ hover: null });
    }
  }

  // the animation loop is stopped while paused, so marker edits have to be
  // drawn by hand to show up
  redrawIfPaused() {
    if (this.props.paused) this.renderPausedFrame();
  }

  // the view's shortcuts listen on an ancestor, so focus comes back here
  closeDraft(refocus = true) {
    if (!this.state.markerDraft) return;

    this.setState({ markerDraft: null }, () => {
      if (refocus) this.containerRef.current?.focus({ preventScroll: true });
    });
  }

  canvasCoords(evt) {
    const canvasRect = this.canvasRef.current.getBoundingClientRect();
    return {
      x: evt.clientX - canvasRect.left,
      y: evt.clientY - canvasRect.top,
    };
  }

  handleMouseDown(evt) {
    this.pressedMarker = null;
    this.pressedInDraft =
      this.draftRef.current !== null &&
      this.draftRef.current.contains(evt.target);

    // The view focuses itself on mousedown, which would blur and close the draft.
    if (this.pressedInDraft) evt.stopPropagation();

    if (!this.graph || this.pressedInDraft) return;

    const { x, y } = this.canvasCoords(evt);
    if (!this.graph.isInPlot(x, y)) return;

    this.pressedMarker = this.graph.markerAt(x, MARKER_HIT_RADIUS);
  }

  handleClick(evt) {
    const { pressedMarker, pressedInDraft } = this;
    this.pressedMarker = null;
    this.pressedInDraft = false;

    if (!this.graph || pressedInDraft) return;

    if (pressedMarker !== null) {
      this.graph.removeMarker(pressedMarker);
      this.closeDraft();
      this.redrawIfPaused();
      return;
    }

    const { x, y } = this.canvasCoords(evt);
    if (!this.graph.isInPlot(x, y)) return;

    const marker = this.graph.addMarker(this.graph.timeAtX(x), '');
    if (marker === null) return;

    // the draft input is positioned against the clicked element, and kept
    // inside of it so that it stays on screen near the edges
    const hostRect = evt.currentTarget.getBoundingClientRect();
    this.setState({
      markerDraft: {
        x: clamp(
          evt.clientX - hostRect.left,
          0,
          Math.max(0, hostRect.width - DRAFT_WIDTH),
        ),
        y: clamp(
          evt.clientY - hostRect.top,
          0,
          Math.max(0, hostRect.height - DRAFT_HEIGHT),
        ),
        marker,
        label: '',
      },
    });
    this.redrawIfPaused();
  }

  handleDraftChange(evt) {
    const { markerDraft } = this.state;
    if (!markerDraft) return;

    const label = evt.target.value;
    markerDraft.marker.label = label;

    this.setState({ markerDraft: { ...markerDraft, label } });
    this.redrawIfPaused();
  }

  handleDraftKeydown(evt) {
    // the enclosing view treats space and k as play/pause shortcuts
    evt.stopPropagation();

    const { markerDraft } = this.state;
    if (!markerDraft) return;

    if (evt.key === 'Enter') {
      this.closeDraft();
    } else if (evt.key === 'Escape') {
      this.graph.removeMarker(markerDraft.marker);
      this.closeDraft();
      this.redrawIfPaused();
    }
  }

  // the parent needs the extent of the history to drive the scrub slider
  reportBounds() {
    if (!this.props.onTimeBounds) return;

    const bounds = this.graph.getTimeBounds();
    if (isEqual(bounds, this.reportedBounds)) return;

    this.reportedBounds = bounds;
    this.props.onTimeBounds(bounds);
  }

  cancelPendingFrame() {
    if (this.requestId) {
      cancelAnimationFrame(this.requestId);
      this.requestId = 0;
    }
  }

  renderGraph() {
    this.cancelPendingFrame();

    // a paused plot is redrawn at the time of the frame it froze on
    const time = this.props.paused
      ? this.lastRenderTimeMs ?? this.props.pausedTime
      : Date.now();
    this.lastRenderTimeMs = time;

    this.setState(() => ({
      graphEmpty: !this.graph.render(time, this.props.scrubMs),
      hover: this.graph.getHover(),
    }));

    if (this.props.paused) {
      this.reportShownTime(time);
    } else {
      this.requestId = requestAnimationFrame(this.renderGraph);
    }
  }

  reportShownTime(time) {
    if (!this.props.onShownTime) return;

    const shownMs = this.graph.shownMs(time, this.props.scrubMs);
    if (isNaN(shownMs)) return;

    this.props.onShownTime(shownMs);
  }

  render() {
    const { hover } = this.state;
    const offset = this.canvasOffset ?? { x: 0, y: 0 };

    const { markerDraft } = this.state;

    // the plot is hidden when the graph runs empty, which would drop focus
    return (
      <div
        ref={this.containerRef}
        className="flex-center relative h-full focus:outline-none"
        tabIndex={-1}
      >
        <div
          className={`${
            this.state.graphEmpty ? 'hidden' : ''
          } relative h-full w-full cursor-crosshair`}
          onMouseMove={this.handleMouseMove}
          onMouseLeave={this.handleMouseLeave}
          onClick={this.handleClick}
          onMouseDown={this.handleMouseDown}
        >
          <AutoFitCanvas
            ref={this.canvasRef}
            onResize={() => {
              if (this.props.paused) this.renderPausedFrame();
              else this.measureContainer();
            }}
          />
          {markerDraft && (
            <input
              // remount on a new spot so that autoFocus fires again
              key={`${markerDraft.x},${markerDraft.y}`}
              ref={this.draftRef}
              autoFocus
              className="absolute z-10 w-32 cursor-text rounded border border-gray-300 bg-white px-1 text-sm text-gray-900 shadow dark:border-slate-500 dark:bg-slate-700 dark:text-slate-100"
              style={{ left: markerDraft.x, top: markerDraft.y }}
              value={markerDraft.label}
              placeholder="Marker label"
              onChange={this.handleDraftChange}
              onKeyDown={this.handleDraftKeydown}
              onBlur={(evt) => this.closeDraft(evt.relatedTarget === null)}
            />
          )}
        </div>
        {hover && (
          <GraphTooltip
            hover={{
              ...hover,
              cursorX: hover.cursorX + offset.x,
              cursorY: hover.cursorY + offset.y,
            }}
            width={this.state.containerWidth}
            height={this.state.containerHeight}
          />
        )}
        <div className="flex-center pointer-events-none absolute top-0 left-0 h-full w-full">
          {this.state.graphEmpty && (
            <p className="text-center">No content to graph</p>
          )}
        </div>
      </div>
    );
  }
}

GraphCanvas.defaultProps = {
  markers: [],
  scrubMs: null,
  runId: 0,
};

GraphCanvas.propTypes = {
  showRecorded: PropTypes.bool,
  replayDriven: PropTypes.bool,
  data: PropTypes.arrayOf(PropTypes.any).isRequired,
  markers: PropTypes.arrayOf(PropTypes.any),
  options: PropTypes.object.isRequired,
  paused: PropTypes.bool.isRequired,
  userPaused: PropTypes.bool,
  pausedTime: PropTypes.number.isRequired,
  resetToken: PropTypes.number,
  // telemetry time shown at the right edge, or null to follow live data
  scrubMs: PropTypes.number,
  // changes to reset the recorded history (new op mode run)
  runId: PropTypes.number,
  onTimeBounds: PropTypes.func,
  onShownTime: PropTypes.func,
};

export default GraphCanvas;
