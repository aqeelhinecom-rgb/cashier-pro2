export type ScreenOrientation = 'portrait' | 'landscape';

export interface ViewportTrackerState {
  baselinePortrait: number | null;
  baselineLandscape: number | null;
  lastWidth: number;
  lastHeight: number;
  lastOrientation: ScreenOrientation;
  keyboardOpen: boolean;
}

export interface ViewportEvaluateInput {
  windowWidth: number;
  windowHeight: number;
  visualHeight: number;
  hasFocusedTextControl: boolean;
  isMobileLayout?: boolean;
}

export interface ViewportEvaluateResult {
  nextState: ViewportTrackerState;
  keyboardOpen: boolean;
  orientationChanged: boolean;
}

const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'range',
  'file',
  'color',
  'hidden',
  'image',
]);

export function isEditableTextControl(el: unknown): boolean {
  if (!el || typeof el !== 'object') return false;
  const candidate = el as {
    tagName?: unknown;
    type?: unknown;
    isContentEditable?: unknown;
    readOnly?: unknown;
    disabled?: unknown;
  };
  if (candidate.disabled) return false;
  if (candidate.isContentEditable === true) return true;
  const tag = typeof candidate.tagName === 'string' ? candidate.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') {
    return !candidate.readOnly;
  }
  if (tag === 'INPUT') {
    const inputType = typeof candidate.type === 'string' ? candidate.type.toLowerCase() : 'text';
    if (NON_TEXT_INPUT_TYPES.has(inputType)) return false;
    return !candidate.readOnly;
  }
  return false;
}

export function getScreenOrientation(width: number, height: number): ScreenOrientation {
  return width > height ? 'landscape' : 'portrait';
}

export function createViewportTrackerState(width: number, height: number): ViewportTrackerState {
  const orientation = getScreenOrientation(width, height);
  return {
    baselinePortrait: orientation === 'portrait' ? height : null,
    baselineLandscape: orientation === 'landscape' ? height : null,
    lastWidth: width,
    lastHeight: height,
    lastOrientation: orientation,
    keyboardOpen: false,
  };
}

export function evaluateKeyboardViewport(
  prevState: ViewportTrackerState,
  input: ViewportEvaluateInput
): ViewportEvaluateResult {
  const isMobile = input.isMobileLayout ?? input.windowWidth < 1024;
  const nextOrientation = getScreenOrientation(input.windowWidth, input.windowHeight);
  const widthJump = Math.abs(input.windowWidth - prevState.lastWidth) > 80;
  const orientationChanged = nextOrientation !== prevState.lastOrientation || widthJump;

  let baselinePortrait = prevState.baselinePortrait;
  let baselineLandscape = prevState.baselineLandscape;

  const currentMaxHeight = Math.max(input.windowHeight, input.visualHeight);

  if (nextOrientation === 'portrait') {
    if (baselinePortrait === null || orientationChanged) {
      baselinePortrait = currentMaxHeight;
    } else if (!input.hasFocusedTextControl || currentMaxHeight > baselinePortrait) {
      baselinePortrait = currentMaxHeight;
    }
  } else {
    if (baselineLandscape === null || orientationChanged) {
      baselineLandscape = currentMaxHeight;
    } else if (!input.hasFocusedTextControl || currentMaxHeight > baselineLandscape) {
      baselineLandscape = currentMaxHeight;
    }
  }

  if (!isMobile) {
    return {
      orientationChanged,
      keyboardOpen: false,
      nextState: {
        baselinePortrait,
        baselineLandscape,
        lastWidth: input.windowWidth,
        lastHeight: input.windowHeight,
        lastOrientation: nextOrientation,
        keyboardOpen: false,
      },
    };
  }

  const activeBaseline =
    (nextOrientation === 'landscape' ? baselineLandscape : baselinePortrait) ?? currentMaxHeight;

  const shrunkFromBaseline = activeBaseline - input.visualHeight;
  const shrunkFromWindow = input.windowHeight - input.visualHeight;

  let keyboardOpen = false;
  if (input.hasFocusedTextControl) {
    if (orientationChanged) {
      // On orientation change, never assume stale baseline shrink means keyboard open;
      // only stay open if visualViewport is genuinely compressed inside the new window height.
      keyboardOpen = shrunkFromWindow > 130;
    } else {
      keyboardOpen = shrunkFromBaseline > 130 || shrunkFromWindow > 130;
    }
  }

  return {
    orientationChanged,
    keyboardOpen,
    nextState: {
      baselinePortrait,
      baselineLandscape,
      lastWidth: input.windowWidth,
      lastHeight: input.windowHeight,
      lastOrientation: nextOrientation,
      keyboardOpen,
    },
  };
}

export function shouldScrollFocusedElement(
  rect: { top: number; bottom: number },
  visualHeight: number,
  headerSafeTop = 76,
  bottomMargin = 16
): boolean {
  if (visualHeight <= 0) return false;
  return rect.bottom > visualHeight - bottomMargin || rect.top < headerSafeTop;
}
