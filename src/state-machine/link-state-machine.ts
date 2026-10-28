import crypto from 'node:crypto';

/**
 * High-performance, strongly typed state machine for link resolution.
 * Strictly adheres to specifications in Sections 1-28.
 */

export enum LinkState {
  START = "START",
  FETCH_PAGE = "FETCH_PAGE",
  MEDIATOR = "MEDIATOR",
  WAITING = "WAITING",
  CHALLENGE_REQUIRED = "CHALLENGE_REQUIRED",
  CHECK_PAGE_AGAIN = "CHECK_PAGE_AGAIN",
  DESTINATION_FOUND = "DESTINATION_FOUND",
  SUCCESS = "SUCCESS",
  TIMEOUT = "TIMEOUT",
  ERROR = "ERROR",
}

export interface StateTransition {
  from: LinkState;
  to: LinkState;
  timestamp: number;
  reason: string;
}

export type DetectionResult =
  | {
      state: LinkState.CHALLENGE_REQUIRED;
      reason: string;
    }
  | {
      state: LinkState.MEDIATOR;
      reason: string;
    }
  | {
      state: LinkState.DESTINATION_FOUND;
      destination: string;
      reason: string;
    }
  | {
      state: LinkState.WAITING;
      remainingMs?: number;
      reason: string;
    }
  | {
      state: LinkState.ERROR;
      reason: string;
    }
  | {
      state: LinkState.FETCH_PAGE;
      reason: string;
    };

export interface PageSnapshot {
  url: string;
  status: number;
  html: string;
  timestamp: number;
}

export interface MachineContext {
  jobId: string;

  sourceUrl: string;
  currentUrl: string;

  startedAt: number;
  lastTransitionAt: number;

  attempts: number;
  maxAttempts: number;

  state: LinkState;

  destination?: string;

  countdownStartedAt?: number;
  countdownDurationMs?: number;

  challengeDetectedAt?: number;

  error?: string;

  history: StateTransition[];
}

export interface LinkResult {
  jobId: string;
  success: boolean;
  state: LinkState;
  sourceUrl: string;
  destination?: string;
  error?: string;
  durationMs: number;
  attempts: number;
  history: StateTransition[];
}

export interface StateMachineOptions {
  maxAttempts?: number;
  timeoutMs?: number;

  onStateChange?: (
    context: Readonly<MachineContext>,
    from: LinkState,
    to: LinkState,
    reason: string,
  ) => void;

  onDestination?: (
    destination: string,
    context: Readonly<MachineContext>,
  ) => void;

  onChallenge?: (
    context: Readonly<MachineContext>,
  ) => void;

  onError?: (
    error: Error,
    context: Readonly<MachineContext>,
  ) => void;
}

export const HUBCLOUD_PATTERN =
  /https?:\/\/hubcloud\.ist\/drive\/[a-z0-9_-]+/gi;

export const CLOUDFLARE_PATTERNS = [
  /just a moment/i,
  /enable javascript and cookies to continue/i,
  /challenges\.cloudflare\.com/i,
  /turnstile/i,
  /cf-chl-/i,
  /cloudflare challenge/i,
];

export const MEDIATOR_PATTERNS = [
  /get\s*link/i,
  /continue\s+to\s+step\s*2/i,
  /please\s+wait/i,
];

export const COUNTDOWN_PATTERNS = [
  /\b\d+\s*(?:seconds?|sec)\b/i,
  /\bcountdown\b/i,
  /\bwait\s+\d+\b/i,
];

export const ALLOWED_TRANSITIONS: Record<LinkState, readonly LinkState[]> = {
  [LinkState.START]: [
    LinkState.FETCH_PAGE,
    LinkState.ERROR,
    LinkState.TIMEOUT,
  ],

  [LinkState.FETCH_PAGE]: [
    LinkState.FETCH_PAGE,
    LinkState.MEDIATOR,
    LinkState.WAITING,
    LinkState.DESTINATION_FOUND,
    LinkState.CHALLENGE_REQUIRED,
    LinkState.ERROR,
    LinkState.TIMEOUT,
  ],

  [LinkState.MEDIATOR]: [
    LinkState.WAITING,
    LinkState.DESTINATION_FOUND,
    LinkState.CHALLENGE_REQUIRED,
    LinkState.ERROR,
    LinkState.TIMEOUT,
  ],

  [LinkState.WAITING]: [
    LinkState.MEDIATOR,
    LinkState.DESTINATION_FOUND,
    LinkState.CHALLENGE_REQUIRED,
    LinkState.TIMEOUT,
    LinkState.ERROR,
  ],

  [LinkState.CHALLENGE_REQUIRED]: [
    LinkState.CHECK_PAGE_AGAIN,
    LinkState.ERROR,
    LinkState.TIMEOUT,
  ],

  [LinkState.CHECK_PAGE_AGAIN]: [
    LinkState.FETCH_PAGE,
    LinkState.DESTINATION_FOUND,
    LinkState.CHALLENGE_REQUIRED,
    LinkState.ERROR,
    LinkState.TIMEOUT,
  ],

  [LinkState.DESTINATION_FOUND]: [
    LinkState.SUCCESS,
    LinkState.ERROR,
  ],

  [LinkState.SUCCESS]: [],

  [LinkState.TIMEOUT]: [],

  [LinkState.ERROR]: [
    LinkState.FETCH_PAGE,
  ],
};

export function assertTransition(
  from: LinkState,
  to: LinkState,
): void {
  const allowed = ALLOWED_TRANSITIONS[from];

  if (!allowed || !allowed.includes(to)) {
    throw new Error(`Invalid transition: ${from} → ${to}`);
  }
}

export function containsAny(
  value: string,
  patterns: RegExp[],
): boolean {
  if (!value || typeof value !== 'string') return false;
  return patterns.some((pattern) => pattern.test(value));
}

export function extractHubCloudUrl(html: string): string | null {
  if (!html || typeof html !== 'string') return null;
  // Reset regex index for global pattern
  HUBCLOUD_PATTERN.lastIndex = 0;
  const matches = html.match(HUBCLOUD_PATTERN);

  if (!matches || matches.length === 0) {
    return null;
  }

  return matches[0];
}

export function extractCountdown(html: string): number | null {
  if (!html || typeof html !== 'string') return null;

  const patterns = [
    /(?:wait|countdown)[^0-9]{0,30}(\d{1,4})\s*(?:seconds?|sec)?/i,
    /(\d{1,4})\s*(?:seconds?|sec)\b/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match?.[1]) {
      const seconds = Number.parseInt(match[1], 10);

      if (
        Number.isFinite(seconds) &&
        seconds >= 0 &&
        seconds <= 3600
      ) {
        return seconds * 1000;
      }
    }
  }

  return null;
}

export function detectPage(
  snapshot: PageSnapshot,
): DetectionResult {
  const { html } = snapshot;

  if (!html || typeof html !== 'string') {
    return {
      state: LinkState.ERROR,
      reason: "Empty or invalid page content",
    };
  }

  // 1. Security/challenge detection comes first.
  if (containsAny(html, CLOUDFLARE_PATTERNS)) {
    return {
      state: LinkState.CHALLENGE_REQUIRED,
      reason: "Cloudflare/Turnstile challenge detected",
    };
  }

  // 2. Destination detection.
  const destination = extractHubCloudUrl(html);

  if (destination) {
    return {
      state: LinkState.DESTINATION_FOUND,
      destination,
      reason: "HubCloud destination detected",
    };
  }

  // 3. Mediator / Countdown detection.
  if (containsAny(html, MEDIATOR_PATTERNS)) {
    const countdownMs = extractCountdown(html);

    if (countdownMs !== null) {
      return {
        state: LinkState.WAITING,
        remainingMs: countdownMs,
        reason: `Countdown detected: ${countdownMs}ms`,
      };
    }

    return {
      state: LinkState.MEDIATOR,
      reason: "Mediator page detected",
    };
  }

  // Check standalone countdown condition
  const countdownMs = extractCountdown(html);
  if (countdownMs !== null) {
    return {
      state: LinkState.WAITING,
      remainingMs: countdownMs,
      reason: `Countdown detected: ${countdownMs}ms`,
    };
  }

  // 4. Unknown page.
  return {
    state: LinkState.ERROR,
    reason: "Unable to identify page state",
  };
}

export class LinkStateMachine {
  private readonly context: MachineContext;

  private readonly timeoutMs: number;

  private readonly onStateChange?: StateMachineOptions["onStateChange"];

  private readonly onDestination?: StateMachineOptions["onDestination"];

  private readonly onChallenge?: StateMachineOptions["onChallenge"];

  private readonly onError?: StateMachineOptions["onError"];

  constructor(
    sourceUrl: string,
    options: StateMachineOptions = {},
  ) {
    const now = Date.now();

    this.timeoutMs = options.timeoutMs ?? 60_000;

    this.onStateChange = options.onStateChange;
    this.onDestination = options.onDestination;
    this.onChallenge = options.onChallenge;
    this.onError = options.onError;

    this.context = {
      jobId: crypto.randomUUID(),

      sourceUrl,
      currentUrl: sourceUrl,

      startedAt: now,
      lastTransitionAt: now,

      attempts: 0,
      maxAttempts: options.maxAttempts ?? 3,

      state: LinkState.START,

      history: [],
    };
  }

  getContext(): Readonly<MachineContext> {
    return this.context;
  }

  getState(): LinkState {
    return this.context.state;
  }

  transition(
    nextState: LinkState,
    reason: string,
  ): void {
    const previousState = this.context.state;

    if (previousState === nextState) {
      return;
    }

    assertTransition(previousState, nextState);

    const now = Date.now();

    this.context.state = nextState;
    this.context.lastTransitionAt = now;

    this.context.history.push({
      from: previousState,
      to: nextState,
      timestamp: now,
      reason,
    });

    this.onStateChange?.(
      this.context,
      previousState,
      nextState,
      reason,
    );
  }

  setCurrentUrl(url: string): void {
    this.context.currentUrl = url;
  }

  processPage(snapshot: PageSnapshot): DetectionResult {
    if (Date.now() - this.context.startedAt > this.timeoutMs) {
      this.transition(
        LinkState.TIMEOUT,
        "Overall state-machine timeout exceeded",
      );

      return {
        state: LinkState.ERROR,
        reason: "Overall timeout exceeded",
      };
    }

    // Auto-transition from START to FETCH_PAGE if not already done
    if (this.context.state === LinkState.START) {
      this.transition(LinkState.FETCH_PAGE, "Processing page snapshot");
    }

    this.context.attempts += 1;
    this.context.currentUrl = snapshot.url;

    const result = detectPage(snapshot);

    switch (result.state) {
      case LinkState.CHALLENGE_REQUIRED:
        this.context.challengeDetectedAt = Date.now();

        this.transition(
          LinkState.CHALLENGE_REQUIRED,
          result.reason,
        );

        this.onChallenge?.(this.context);

        break;

      case LinkState.WAITING:
        this.context.countdownStartedAt ??= Date.now();
        this.context.countdownDurationMs ??= result.remainingMs;

        this.transition(
          LinkState.WAITING,
          result.reason,
        );

        break;

      case LinkState.MEDIATOR:
        this.transition(
          LinkState.MEDIATOR,
          result.reason,
        );

        break;

      case LinkState.DESTINATION_FOUND:
        this.context.destination = result.destination;

        this.transition(
          LinkState.DESTINATION_FOUND,
          result.reason,
        );

        this.onDestination?.(
          result.destination,
          this.context,
        );

        break;

      case LinkState.ERROR:
        this.context.error = result.reason;

        this.transition(
          LinkState.ERROR,
          result.reason,
        );

        this.onError?.(
          new Error(result.reason),
          this.context,
        );

        break;

      default:
        this.transition(
          LinkState.FETCH_PAGE,
          result.reason,
        );
    }

    return result;
  }

  markVerificationCompleted(): void {
    if (
      this.context.state !== LinkState.CHALLENGE_REQUIRED
    ) {
      throw new Error(
        "Cannot resume verification because the state is not CHALLENGE_REQUIRED",
      );
    }

    this.transition(
      LinkState.CHECK_PAGE_AGAIN,
      "Authorized verification completed",
    );
  }

  markCountdownCompleted(): void {
    if (this.context.state !== LinkState.WAITING) {
      throw new Error(
        "Cannot complete countdown from current state",
      );
    }

    this.transition(
      LinkState.MEDIATOR,
      "Countdown completed",
    );
  }

  markSuccess(): void {
    if (
      this.context.state !== LinkState.DESTINATION_FOUND
    ) {
      throw new Error(
        "Cannot mark success before destination is found",
      );
    }

    this.transition(
      LinkState.SUCCESS,
      "Destination validated",
    );
  }

  markError(reason: string): void {
    this.context.error = reason;

    this.transition(
      LinkState.ERROR,
      reason,
    );
  }

  canRetry(): boolean {
    return (
      this.context.attempts <
      this.context.maxAttempts
    );
  }

  retry(): void {
    if (!this.canRetry()) {
      const reason = "Maximum retry attempts exceeded";
      this.context.error = reason;
      this.transition(
        LinkState.ERROR,
        reason,
      );

      return;
    }

    this.transition(
      LinkState.FETCH_PAGE,
      `Retry ${this.context.attempts + 1}/${this.context.maxAttempts}`,
    );
  }

  isTerminal(): boolean {
    return [
      LinkState.SUCCESS,
      LinkState.TIMEOUT,
      LinkState.ERROR,
    ].includes(this.context.state);
  }

  getResult(): LinkResult {
    const now = Date.now();
    return {
      jobId: this.context.jobId,
      success: this.context.state === LinkState.SUCCESS,
      state: this.context.state,
      sourceUrl: this.context.sourceUrl,
      destination: this.context.destination,
      error: this.context.error,
      durationMs: now - this.context.startedAt,
      attempts: this.context.attempts,
      history: [...this.context.history],
    };
  }
}
