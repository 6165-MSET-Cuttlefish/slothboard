import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSelector } from 'react-redux';
import { Transition } from '@headlessui/react';
import clsx from 'clsx';

import BaseView, {
  BaseViewHeading,
  BaseViewBody,
  BaseViewProps,
  BaseViewHeadingProps,
} from '@/components/views/BaseView';
import ReplayBadge from '@/components/views/ReplayBadge';
import sanitizeTelemetryHtml, {
  truncateTelemetry,
} from '@/components/views/TelemetryView/sanitizeTelemetryHtml';
import { RootState } from '@/store/reducers';
import { TELEMETRY_WINDOW_MS } from '@/store/middleware/playbackMiddleware';
import { Telemetry, TelemetryDisplayFormat } from '@/store/types/telemetry';
import buildFrame, {
  DisplayedLine,
  Frame,
  telemetryContributes,
} from '@/components/views/TelemetryView/buildFrame';
import useOnClickOutside from '@/hooks/useOnClickOutside';

import { ReactComponent as MoreVertSVG } from '@/assets/icons/more_vert.svg';

type TelemetryViewProps = BaseViewProps & BaseViewHeadingProps;

// `null` follows each packet's own format; the others override every line.
type FormatOverride = TelemetryDisplayFormat | null;

const MENU_GAP = 8;

const HOLD_TIMEOUT = 10000;

const FORMAT_OPTIONS: { label: string; value: FormatOverride }[] = [
  { label: 'Auto', value: null },
  { label: 'Classic', value: 'CLASSIC' },
  { label: 'Monospace', value: 'MONOSPACE' },
  { label: 'HTML', value: 'HTML' },
];

const EMPTY_FRAME: Frame = { entries: [], log: [] };

// Incoming packets rewrite the rendered lines several times a second, which
// clears any selection sitting inside them. Updates are held while the user has
// one anchored in the view so that ordinary copy and paste works. A range only
// containing the view, as a select-all does, is not anchored in it.
function hasSelectionIn(node: HTMLElement | null) {
  if (node === null) return false;

  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed) return false;

  return (
    node.contains(selection.anchorNode) || node.contains(selection.focusNode)
  );
}

const TelemetryView = ({
  isDraggable = false,
  isUnlocked = false,
}: TelemetryViewProps) => {
  const packets = useSelector((state: RootState) => state.telemetry);
  const isReplay = useSelector(
    (state: RootState) => state.playback.mode === 'playback',
  );
  // Both tokens reset the frame. Logging and the Graph keep history, so they
  // honour only foldToken: a replayed clear must not wipe what live runs keep.
  const foldToken = useSelector((state: RootState) => state.playback.foldToken);
  const clearToken = useSelector(
    (state: RootState) => state.playback.clearToken,
  );

  const [filter, setFilter] = useState('');
  const [isHeld, setIsHeld] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let copyTimer: ReturnType<typeof setTimeout> | null = null;

    const onSelectionChange = () => setIsHeld(hasSelectionIn(bodyRef.current));

    // The browser reads the selection into the clipboard once this event has
    // been dispatched, so the lines may only be rewritten after that.
    const onCopy = () => {
      copyTimer = setTimeout(() => setIsHeld(false), 0);
    };

    const onBlur = () => setIsHeld(false);

    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('copy', onCopy);
    window.addEventListener('blur', onBlur);

    return () => {
      if (copyTimer !== null) clearTimeout(copyTimer);

      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('copy', onCopy);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useEffect(() => {
    if (!isHeld) return;

    const timer = setTimeout(() => setIsHeld(false), HOLD_TIMEOUT);
    return () => clearTimeout(timer);
  }, [isHeld]);

  // A drawing-only batch leaves the last real frame in place.
  const lastFrame = useRef<Frame>(EMPTY_FRAME);
  const heldBatches = useRef<Telemetry[]>([]);
  // Replay batches by 25 ms tick, so its frame is rebuilt from a trailing window.
  const replayTail = useRef<Telemetry>([]);
  const seenPackets = useRef<Telemetry | null>(null);
  const seenToken = useRef(`${foldToken}:${clearToken}`);

  const { entries, log } = useMemo(() => {
    // The tokens, not packets.length: a seek sends no empty batch.
    const token = `${foldToken}:${clearToken}`;
    if (seenToken.current !== token) {
      seenToken.current = token;
      heldBatches.current = [];
      replayTail.current = [];
      lastFrame.current = EMPTY_FRAME;
    }

    // Each batch is taken once, so a hold or token change never replays one.
    if (seenPackets.current !== packets) {
      seenPackets.current = packets;

      // An empty batch is the clear signal and is honoured even while held.
      if (packets.length === 0) {
        heldBatches.current = [];
        replayTail.current = [];
        lastFrame.current = EMPTY_FRAME;
        return lastFrame.current;
      }

      heldBatches.current.push(packets);
    }

    if (isHeld || heldBatches.current.length === 0) return lastFrame.current;

    // Each batch replaces the frame, so held ones apply in order as unheld ones
    // would; merging them would union shapes that never coexisted.
    for (const batch of heldBatches.current) {
      const seed = batch.find((packet) => packet.seed === true);
      let source = batch;
      if (seed !== undefined) {
        replayTail.current = seed.telemetryTick ?? [];
        source = replayTail.current;
      } else if (batch[0].recordedMs !== undefined) {
        // Only telemetry moves the window: a drawing-only tick leaves the frame
        // alone, as a drawing-only live batch does.
        const fresh = batch.filter(telemetryContributes);
        if (fresh.length === 0) continue;
        const newestMs = fresh[fresh.length - 1].recordedMs ?? 0;
        replayTail.current = [...replayTail.current, ...fresh].filter(
          (packet) => (packet.recordedMs ?? 0) > newestMs - TELEMETRY_WINDOW_MS,
        );
        source = replayTail.current;
      }

      const frame = buildFrame(source);
      if (frame !== null) lastFrame.current = frame;
    }
    heldBatches.current = [];
    return lastFrame.current;
  }, [packets, isHeld, foldToken, clearToken]);

  const query = filter.trim().toLowerCase();
  // A captioned item is matched on its caption, as in the keyed view; a bare
  // line and a log entry have only their text.
  const matches = ({ caption, value }: DisplayedLine) =>
    query === '' || (caption ?? value).toLowerCase().includes(query);

  const [formatOverride, setFormatOverride] = useState<FormatOverride>(null);
  const [isMenuVisible, setIsMenuVisible] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, right: 0 });

  // Portalled with fixed coordinates, so a small tile can neither clip the menu nor leave the edit
  // button over it. It opens above the button when the viewport has no room below.
  const placeMenu = useCallback(() => {
    const button = menuButtonRef.current?.getBoundingClientRect();
    if (!button) return;

    const height = menuRef.current?.offsetHeight ?? 0;
    const { clientWidth, clientHeight } = document.documentElement;
    const below = button.bottom + MENU_GAP;

    setMenuPosition({
      top:
        below + height <= clientHeight
          ? below
          : Math.max(0, button.top - MENU_GAP - height),
      right: clientWidth - button.right,
    });
  }, []);

  useEffect(() => {
    if (!isMenuVisible) return undefined;

    window.addEventListener('resize', placeMenu);
    window.addEventListener('scroll', placeMenu, true);
    return () => {
      window.removeEventListener('resize', placeMenu);
      window.removeEventListener('scroll', placeMenu, true);
    };
  }, [isMenuVisible, placeMenu]);

  useOnClickOutside(
    menuRef,
    () => {
      if (isMenuVisible) setIsMenuVisible(false);
    },
    [menuButtonRef],
  );

  // Per line, not per container: lines from different sources can be in different formats.
  const renderLine = (key: string, line: DisplayedLine) => {
    const { caption, value, separator } = line;
    const displayFormat = formatOverride ?? line.displayFormat;

    const renderText = (text: string) =>
      displayFormat === 'HTML'
        ? sanitizeTelemetryHtml(text)
        : truncateTelemetry(text);

    return (
      <div
        key={key}
        className={clsx(
          'break-words',
          displayFormat === 'MONOSPACE' && 'font-mono',
          displayFormat === 'HTML' ? 'telemetry-html' : 'whitespace-pre-wrap',
        )}
      >
        {/* An empty div collapses to nothing, so a blank line gets a non-breaking space to keep
            the height the Driver Station gives it. */}
        {caption == null &&
        (displayFormat === 'HTML' ? value.trim() === '' : value === '') ? (
          ' '
        ) : (
          <>
            {caption != null && (
              <>
                {renderText(caption)}
                {separator}
              </>
            )}
            {renderText(value)}
          </>
        )}
      </div>
    );
  };

  return (
    <BaseView isUnlocked={isUnlocked}>
      <div className="flex-center">
        <BaseViewHeading
          className="min-w-0 flex-1 basis-24 truncate"
          isDraggable={isDraggable}
        >
          Telemetry
          {/* An override is easy to set and forget, so say so rather than leaving someone to
              wonder why their telemetry renders differently here than anywhere else. */}
          {formatOverride !== null && (
            <span className="ml-2 align-middle text-sm font-normal text-gray-500 dark:text-gray-400">
              {formatOverride.toLowerCase()}
            </span>
          )}
          {isReplay && <ReplayBadge source="replacing" />}
        </BaseViewHeading>
        {isHeld && (
          <span
            className="mr-2 truncate text-xs text-gray-500 dark:text-slate-400"
            title="Updates paused while text is selected"
          >
            paused
          </span>
        )}
        <input
          className="mr-2 w-20 min-w-[4rem] rounded border border-gray-500 bg-gray-100 px-2 py-0.5 text-sm transition-all placeholder:text-gray-600 focus:w-32 focus:ring-1 focus:ring-primary-500 dark:border-slate-500 dark:bg-slate-800 dark:text-slate-200 dark:placeholder:text-slate-400"
          type="text"
          placeholder="Filter"
          aria-label="Filter telemetry"
          value={filter}
          onChange={(evt) => setFilter(evt.target.value)}
          onKeyDown={(evt) => {
            if (evt.key === 'Escape') setFilter('');
          }}
        />
        <div className="mr-3 flex items-center space-x-1">
          <button
            ref={menuButtonRef}
            className="icon-btn h-8 w-8"
            onClick={() => setIsMenuVisible(!isMenuVisible)}
          >
            <MoreVertSVG className="h-6 w-6" />
          </button>
          {createPortal(
            <Transition
              ref={menuRef}
              show={isMenuVisible}
              beforeEnter={placeMenu}
              className="fixed z-50 origin-top-right rounded-md border border-gray-200 bg-white py-2 text-black shadow-lg outline-none dark:bg-slate-700 dark:text-white"
              style={menuPosition}
              enter="transition ease-out duration-100"
              enterFrom="transform opacity-0 scale-95"
              enterTo="transform opacity-100 scale-100"
              leave="transition ease-in duration-75"
              leaveFrom="transform opacity-100 scale-100"
              leaveTo="transform opacity-0 scale-95"
            >
              <p className="mb-1 whitespace-nowrap border-b border-gray-100 pb-1 pl-3 pr-3 text-sm leading-5">
                Display Format
              </p>
              {FORMAT_OPTIONS.map(({ label, value }) => (
                <button
                  key={label}
                  className={clsx(
                    'block w-full whitespace-nowrap px-3 py-1 text-left text-sm hover:bg-gray-100 dark:hover:bg-slate-600',
                    formatOverride === value && 'font-medium',
                  )}
                  onClick={() => {
                    setFormatOverride(value);
                    setIsMenuVisible(false);
                  }}
                >
                  <span className="inline-block w-4">
                    {formatOverride === value ? '✓' : ''}
                  </span>
                  {label}
                </button>
              ))}
            </Transition>,
            document.body,
          )}
        </div>
      </div>
      <BaseViewBody>
        <div ref={bodyRef}>
          {entries.map((entry, i) =>
            matches(entry) ? renderLine(`item-${i}`, entry) : null,
          )}
          {/* The log always sits below the telemetry items, matching the Driver Station. */}
          {log.map((line, i) =>
            matches(line) ? renderLine(`log-${i}`, line) : null,
          )}
        </div>
      </BaseViewBody>
    </BaseView>
  );
};

export default TelemetryView;
