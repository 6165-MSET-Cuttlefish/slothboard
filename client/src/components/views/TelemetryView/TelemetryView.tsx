import { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { Transition } from '@headlessui/react';
import clsx from 'clsx';

import BaseView, {
  BaseViewHeading,
  BaseViewBody,
  BaseViewProps,
  BaseViewHeadingProps,
} from '@/components/views/BaseView';
import sanitizeTelemetryHtml from '@/components/views/TelemetryView/sanitizeTelemetryHtml';
import { RootState } from '@/store/reducers';
import { Telemetry, TelemetryDisplayFormat } from '@/store/types/telemetry';
import buildFrame, {
  DisplayedLine,
  Frame,
} from '@/components/views/TelemetryView/buildFrame';
import useOnClickOutside from '@/hooks/useOnClickOutside';

import { ReactComponent as MoreVertSVG } from '@/assets/icons/more_vert.svg';

type TelemetryViewProps = BaseViewProps & BaseViewHeadingProps;

// Matches the sanitizer's own limit.
const MAX_VALUE_LENGTH = 16384;

const HOLD_TIMEOUT = 10000;

// `null` follows each packet's own format; the others override every line.
type FormatOverride = TelemetryDisplayFormat | null;

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

  const { entries, log } = useMemo(() => {
    // An empty batch is the clear signal and is honoured even while held.
    if (packets.length === 0) {
      heldBatches.current = [];
      lastFrame.current = EMPTY_FRAME;
      return lastFrame.current;
    }

    const held = heldBatches.current;
    if (held[held.length - 1] !== packets) held.push(packets);

    if (isHeld) return lastFrame.current;

    heldBatches.current = [];

    const frame = buildFrame(held.flat());
    if (frame !== null) lastFrame.current = frame;
    return lastFrame.current;
  }, [packets, isHeld]);

  const query = filter.trim().toLowerCase();
  // A captioned item is matched on its caption, as in the keyed view; a bare
  // line and a log entry have only their text.
  const matches = ({ caption, value }: DisplayedLine) =>
    query === '' || (caption ?? value).toLowerCase().includes(query);

  const [formatOverride, setFormatOverride] = useState<FormatOverride>(null);
  const [isMenuVisible, setIsMenuVisible] = useState(false);

  const menuRef = useRef(null);
  const menuButtonRef = useRef(null);

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

    // The same bound the sanitizer applies, so a runaway value cannot bloat the DOM.
    const renderText = (text: string) =>
      displayFormat === 'HTML'
        ? sanitizeTelemetryHtml(text)
        : text.length > MAX_VALUE_LENGTH
        ? `${text.slice(0, MAX_VALUE_LENGTH)}…`
        : text;

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
          ' '
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
            <span className="text-neutral-gray-400 ml-2 align-middle text-sm font-normal">
              {formatOverride.toLowerCase()}
            </span>
          )}
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
          <div className="relative inline-block" style={{ zIndex: 99 }}>
            <button
              ref={menuButtonRef}
              className="icon-btn h-8 w-8"
              onClick={() => setIsMenuVisible(!isMenuVisible)}
            >
              <MoreVertSVG className="h-6 w-6" />
            </button>
            <Transition
              show={isMenuVisible}
              enter="transition ease-out duration-100"
              enterFrom="transform opacity-0 scale-95"
              enterTo="transform opacity-100 scale-100"
              leave="transition ease-in duration-75"
              leaveFrom="transform opacity-100 scale-100"
              leaveTo="transform opacity-0 scale-95"
            >
              <div
                ref={menuRef}
                className="absolute right-0 mt-2 origin-top-right rounded-md border border-gray-200 bg-white py-2 shadow-lg outline-none dark:bg-slate-700"
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
              </div>
            </Transition>
          </div>
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
