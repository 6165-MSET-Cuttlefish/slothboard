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
  }

  componentWillUnmount() {
    if (this.requestId) {
      cancelAnimationFrame(this.requestId);
    }
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

    if (prevProps.paused && !this.props.paused) {
      this.graph.reset();
    }

    if (!this.props.paused && !isEqual(this.props.data, prevProps.data)) {
      this.graph.add(Date.now(), this.props.data, this.props.markers);
    }

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

    // rendering prunes samples that have fallen out of the window, so a frozen
    // frame has to be redrawn at the time it was first drawn at
    const time = this.lastRenderTimeMs ?? this.props.pausedTime;
    this.lastRenderTimeMs = time;

    this.setState({
      graphEmpty: !this.graph.render(time),
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

  renderGraph() {
    // Option changes call this while a frame is already queued; without the
    // cancel each one would leave another loop running.
    if (this.requestId) cancelAnimationFrame(this.requestId);

    if (this.props.paused) {
      // Option changes made while paused are visible without resuming.
      this.graph.render(this.props.pausedTime);
      this.requestId = 0;
    } else {
      const time = Date.now();
      this.lastRenderTimeMs = time;

      this.setState(() => ({
        graphEmpty: !this.graph.render(time),
        hover: this.graph.getHover(),
      }));

      this.requestId = requestAnimationFrame(this.renderGraph);
    }
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
};

GraphCanvas.propTypes = {
  data: PropTypes.arrayOf(PropTypes.any).isRequired,
  markers: PropTypes.arrayOf(PropTypes.any),
  options: PropTypes.object.isRequired,
  paused: PropTypes.bool.isRequired,
  pausedTime: PropTypes.number.isRequired,
};

export default GraphCanvas;
