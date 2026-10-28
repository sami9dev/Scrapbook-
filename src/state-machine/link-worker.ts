import {
  LinkState,
  LinkStateMachine,
  type PageSnapshot,
  type StateMachineOptions,
} from "./link-state-machine.js";

export interface ProcessLinkOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  fetcher?: (url: string) => Promise<PageSnapshot>;
  onStateChange?: StateMachineOptions["onStateChange"];
  onChallenge?: StateMachineOptions["onChallenge"];
  onDestination?: StateMachineOptions["onDestination"];
  onError?: StateMachineOptions["onError"];
}

/**
 * Worker implementation to process a link through the State Machine.
 * Strictly adheres to Sections 15, 16, 20.
 */
export async function processLink(
  sourceUrl: string,
  options: ProcessLinkOptions = {},
): Promise<string> {
  const machine = new LinkStateMachine(
    sourceUrl,
    {
      timeoutMs: options.timeoutMs ?? 60_000,
      maxAttempts: options.maxAttempts ?? 3,

      onStateChange: (context, from, to, reason) => {
        if (options.onStateChange) {
          options.onStateChange(context, from, to, reason);
        } else {
          console.log(`[${context.jobId}] ${from} → ${to}: ${reason}`);
        }
      },

      onChallenge: (context) => {
        if (options.onChallenge) {
          options.onChallenge(context);
        } else {
          console.warn(`[${context.jobId}] Verification required`);
        }
      },

      onDestination: (destination, context) => {
        if (options.onDestination) {
          options.onDestination(destination, context);
        } else {
          console.log(`[${context.jobId}] Destination: ${destination}`);
        }
      },

      onError: options.onError,
    },
  );

  machine.transition(
    LinkState.FETCH_PAGE,
    "Starting request",
  );

  // Obtain page snapshot via provided fetcher or HTTP fetch
  let snapshot: PageSnapshot;
  if (options.fetcher) {
    snapshot = await options.fetcher(sourceUrl);
  } else {
    try {
      const res = await fetch(sourceUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
      });
      const html = await res.text();
      snapshot = {
        url: sourceUrl,
        status: res.status,
        html,
        timestamp: Date.now(),
      };
    } catch (err: any) {
      snapshot = {
        url: sourceUrl,
        status: 0,
        html: '',
        timestamp: Date.now(),
      };
    }
  }

  const result = machine.processPage(snapshot);

  if (result.state === LinkState.CHALLENGE_REQUIRED) {
    throw new Error(
      "Verification required; manual/authorized browser flow needed",
    );
  }

  if (result.state === LinkState.DESTINATION_FOUND) {
    machine.markSuccess();
    return result.destination;
  }

  throw new Error(
    `Unable to resolve link: ${result.reason}`,
  );
}

export default { processLink };
