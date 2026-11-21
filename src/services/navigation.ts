import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';

interface BackEntry {
  id: number;
  onBack: () => void;
}

let nextEntryId = 1;
const backStack: BackEntry[] = [];
let listenerInitialized = false;

function pushHistoryGuard() {
  if (typeof window === 'undefined') return;
  try {
    window.history.pushState({ cashierGuard: Date.now() }, '');
  } catch {
    // Ignore history state errors in restricted contexts
  }
}

let lastRootBackPress = 0;
const EXIT_DOUBLE_TAP_MS = 2000;
type RootExitPromptListener = () => void;
const rootExitListeners = new Set<RootExitPromptListener>();

export function onRootExitPrompt(listener: RootExitPromptListener) {
  ensurePopstateListener();
  rootExitListeners.add(listener);
  return () => {
    rootExitListeners.delete(listener);
  };
}

function handleHardwareOrHistoryBack(isNativeBackEvent: boolean) {
  const topEntry = backStack.pop();

  if (topEntry) {
    lastRootBackPress = 0;
    if (!isNativeBackEvent) {
      pushHistoryGuard();
    }
    topEntry.onBack();
    return;
  }

  // At root screen (Home) with no active modals/screens in backStack:
  // Require 2 taps within 2 seconds to exit the app
  const now = Date.now();
  if (now - lastRootBackPress < EXIT_DOUBLE_TAP_MS) {
    lastRootBackPress = 0;
    if (isNativeBackEvent) {
      CapacitorApp.exitApp().catch(() => {});
    } else {
      try {
        window.history.back();
      } catch {
        // Ignore
      }
    }
    return;
  }

  lastRootBackPress = now;
  if (!isNativeBackEvent) {
    pushHistoryGuard();
  }
  rootExitListeners.forEach((cb) => {
    try {
      cb();
    } catch {
      // Ignore
    }
  });
}

function ensurePopstateListener() {
  if (listenerInitialized || typeof window === 'undefined') return;
  listenerInitialized = true;

  if (Capacitor.isNativePlatform()) {
    CapacitorApp.addListener('backButton', () => {
      handleHardwareOrHistoryBack(true);
    }).catch(() => {
      // Fallback safely to popstate if listener registration fails
    });
  }

  try {
    window.history.replaceState({ cashierBase: true }, '');
    pushHistoryGuard();
  } catch {
    // Ignore
  }

  window.addEventListener('popstate', () => {
    handleHardwareOrHistoryBack(false);
  });
}

export function pushBackEntry(onBack: () => void): BackEntry {
  ensurePopstateListener();
  const entry: BackEntry = {
    id: nextEntryId++,
    onBack,
  };
  backStack.push(entry);
  pushHistoryGuard();
  return entry;
}

export function removeBackEntry(entry: BackEntry) {
  const idx = backStack.findIndex((e) => e.id === entry.id);
  if (idx !== -1) {
    backStack.splice(idx, 1);
  }
}

export function triggerStepBack(): boolean {
  ensurePopstateListener();
  if (backStack.length > 0) {
    const topEntry = backStack.pop();
    if (topEntry) {
      lastRootBackPress = 0;
      topEntry.onBack();
      return true;
    }
  }
  return false;
}

/**
 * React hook that registers a step in the browser/phone back stack
 * whenever `isActive` is true. Pressing the phone's Back button
 * will invoke `onBack` to close only the current step/modal/subview.
 */
export function useBackHandler(isActive: boolean, onBack: () => void) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    ensurePopstateListener();
  }, []);

  useEffect(() => {
    if (!isActive) return;

    const entry = pushBackEntry(() => {
      onBackRef.current();
    });

    return () => {
      removeBackEntry(entry);
    };
  }, [isActive]);
}
