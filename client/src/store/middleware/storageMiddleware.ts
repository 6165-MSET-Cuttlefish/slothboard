import { Middleware } from 'redux';
import { v4 as uuidv4 } from 'uuid';

import LayoutPreset, { LayoutPresetType } from '@/enums/LayoutPreset';
import {
  SavedLayout,
  DELETE_SAVED_LAYOUT,
  GET_LAYOUT_PRESET,
  GET_SAVED_LAYOUTS,
  LOAD_SAVED_LAYOUT,
  SAVE_LAYOUT,
  SAVE_LAYOUT_PRESET,
} from '@/store/types';
import {
  GET_MAX_LOG_ENTRIES,
  SET_MAX_LOG_ENTRIES,
} from '@/store/types/logRecorder';
import {
  receiveLayoutPreset,
  receiveLayoutToLoad,
  receiveSavedLayouts,
} from '@/store/actions/settings';
import { setMaxLogEntries } from '@/store/actions/logRecorder';
import { RootState } from '@/store/reducers';

const LAYOUT_PRESET_KEY = 'layoutPreset';
const MAX_LOG_ENTRIES_KEY = 'maxRecordedLogEntries';

export const SAVED_LAYOUTS_KEY = 'savedLayouts';
// Written by the custom layout together with its grid.
export const ACTIVE_SAVED_LAYOUT_KEY = 'activeSavedLayoutId';

const isSavedLayout = (value: unknown): value is SavedLayout =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as SavedLayout).id === 'string' &&
  typeof (value as SavedLayout).name === 'string' &&
  typeof (value as SavedLayout).code === 'string';

function readSavedLayouts(): SavedLayout[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_LAYOUTS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isSavedLayout) : [];
  } catch {
    return [];
  }
}

// Throws when storage is full.
function writeSavedLayouts(layouts: SavedLayout[]) {
  localStorage.setItem(SAVED_LAYOUTS_KEY, JSON.stringify(layouts));
}

const sameName = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

const keepIfPresent = (layouts: SavedLayout[], id: string | null) =>
  id !== null && layouts.some((l) => l.id === id) ? id : null;

const storageMiddleware: Middleware<Record<string, unknown>, RootState> =
  (store) => (next) => (action) => {
    switch (action.type) {
      case GET_LAYOUT_PRESET: {
        const preset =
          localStorage.getItem(LAYOUT_PRESET_KEY) || LayoutPreset.DEFAULT;

        store.dispatch(receiveLayoutPreset(preset as LayoutPresetType));

        break;
      }
      case SAVE_LAYOUT_PRESET: {
        localStorage.setItem(LAYOUT_PRESET_KEY, action.preset);

        store.dispatch(receiveLayoutPreset(action.preset));

        // Choosing the plain custom layout detaches it from a saved one.
        if (
          action.preset === LayoutPreset.CONFIGURABLE &&
          store.getState().settings.activeSavedLayout !== null
        ) {
          store.dispatch(receiveSavedLayouts(readSavedLayouts(), null));
        }

        break;
      }
      case GET_SAVED_LAYOUTS: {
        const layouts = readSavedLayouts();
        // The stored id is whichever tab wrote last, so another tab's change
        // keeps this tab's own.
        const activeId = keepIfPresent(
          layouts,
          action.fromOtherTab
            ? store.getState().settings.activeSavedLayout?.id ?? null
            : localStorage.getItem(ACTIVE_SAVED_LAYOUT_KEY),
        );

        store.dispatch(receiveSavedLayouts(layouts, activeId));

        break;
      }
      case SAVE_LAYOUT: {
        const name = action.name.trim();
        const layouts = readSavedLayouts();
        const existing = layouts.find((l) => sameName(l.name, name));
        const saved: SavedLayout = existing
          ? { ...existing, name, code: action.code }
          : { id: uuidv4(), name, code: action.code };
        const updated = existing
          ? layouts.map((l) => (l.id === saved.id ? saved : l))
          : [...layouts, saved];

        writeSavedLayouts(updated);
        store.dispatch(receiveSavedLayouts(updated, saved.id));

        break;
      }
      case DELETE_SAVED_LAYOUT: {
        const layouts = readSavedLayouts().filter((l) => l.id !== action.id);
        const active = store.getState().settings.activeSavedLayout;
        // Another tab may have removed the active layout in the meantime.
        const activeId = keepIfPresent(layouts, active?.id ?? null);

        writeSavedLayouts(layouts);
        store.dispatch(receiveSavedLayouts(layouts, activeId));

        break;
      }
      case LOAD_SAVED_LAYOUT: {
        const layouts = readSavedLayouts();
        const layout = layouts.find((l) => l.id === action.id);
        const { activeSavedLayout: active, layoutPreset } =
          store.getState().settings;

        if (layout === undefined) {
          // Gone from another tab: refresh the list instead of doing nothing.
          const activeId = keepIfPresent(layouts, active?.id ?? null);
          store.dispatch(receiveSavedLayouts(layouts, activeId));
          break;
        }

        // Coming back to the layout that is already loaded keeps any edits
        // unless the caller asked for a reload. A hidden custom layout shows
        // the stored grid, which another tab may have replaced. A queued load
        // replaces any stale one. The preset is set directly: going through
        // SAVE_LAYOUT_PRESET would detach the layout being loaded.
        const shownId =
          layoutPreset === LayoutPreset.CONFIGURABLE
            ? active?.id
            : localStorage.getItem(ACTIVE_SAVED_LAYOUT_KEY);
        const alreadyActive = shownId === layout.id;
        localStorage.setItem(LAYOUT_PRESET_KEY, LayoutPreset.CONFIGURABLE);
        store.dispatch(receiveLayoutPreset(LayoutPreset.CONFIGURABLE));
        if (action.force || !alreadyActive) {
          store.dispatch(receiveLayoutToLoad(layout.name, layout.code));
        }
        store.dispatch(receiveSavedLayouts(layouts, layout.id));

        break;
      }
      case GET_MAX_LOG_ENTRIES: {
        try {
          const stored = parseInt(
            localStorage.getItem(MAX_LOG_ENTRIES_KEY) ?? '',
            10,
          );

          if (!isNaN(stored)) {
            store.dispatch(setMaxLogEntries(stored));
          }
        } catch {
          // an unavailable localStorage leaves the default limit in place
        }

        break;
      }
      case SET_MAX_LOG_ENTRIES: {
        next(action);

        try {
          // the reducer holds the only range rule, so store what it settled on
          localStorage.setItem(
            MAX_LOG_ENTRIES_KEY,
            String(store.getState().logRecorder.maxEntries),
          );
        } catch {
          // the limit still applies for this session
        }

        break;
      }
      default:
        next(action);

        break;
    }
  };

export default storageMiddleware;
