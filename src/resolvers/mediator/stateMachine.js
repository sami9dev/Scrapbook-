import { logger } from '../../logging/logger.js';

/**
 * Standard state definitions for the Mediator resolution lifecycle.
 * Strictly adheres to Section 7 & 16 of the specification.
 */
export const STATES = {
  INIT: 'INIT',
  MEDIATOR_OPEN: 'MEDIATOR_OPEN',
  WAITING: 'WAITING',
  COUNTDOWN: 'COUNTDOWN',
  LINK_READY: 'LINK_READY',
  GET_LINK_ACTION: 'GET_LINK_ACTION',
  NAVIGATING: 'NAVIGATING',
  HUBCLOUD_DETECTED: 'HUBCLOUD_DETECTED',

  // Failure & Pause states
  CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED',
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  INVALID_MEDIATOR: 'INVALID_MEDIATOR',
  HUBCLOUD_DESTINATION_NOT_FOUND: 'HUBCLOUD_DESTINATION_NOT_FOUND',
};

export class MediatorStateMachine {
  /**
   * @param {object} meta Context metadata for logging (sourceUrl, mediatorUrl, title, quality, provider)
   */
  constructor(meta = {}) {
    this.meta = {
      sourceUrl: meta.sourceUrl || '',
      mediatorUrl: meta.mediatorUrl || '',
      title: meta.title || '',
      quality: meta.quality || '',
      provider: meta.provider || 'HubCloud',
    };
    this.startTime = Date.now();
    this.state = STATES.INIT;
    this.history = [];
    this.destination = null;
    this.error = null;
  }

  /**
   * Transition to a new state and record telemetry.
   * 
   * @param {string} nextState
   * @param {object} [details]
   */
  transition(nextState, details = {}) {
    const now = Date.now();
    const elapsedMs = now - this.startTime;
    const timeFormatted = new Date(now).toTimeString().split(' ')[0];

    const transitionRecord = {
      from: this.state,
      to: nextState,
      timestamp: timeFormatted,
      elapsedMs,
      details,
    };

    this.history.push(transitionRecord);
    this.state = nextState;

    if (details.destination) {
      this.destination = details.destination;
    }
    if (details.error) {
      this.error = details.error;
    }

    // Format log as specified in Section 16
    const logDetails = details.info ? ` - ${details.info}` : '';
    logger.log('MEDIATOR_STATE', `[${timeFormatted}] ${nextState} (elapsed: ${elapsedMs}ms)${logDetails}`, {
      title: this.meta.title,
      quality: this.meta.quality,
      mediatorUrl: this.meta.mediatorUrl,
      ...details,
    });
  }

  isTerminal() {
    return [
      STATES.HUBCLOUD_DETECTED,
      STATES.CAPTCHA_REQUIRED,
      STATES.TIMEOUT,
      STATES.NETWORK_ERROR,
      STATES.INVALID_MEDIATOR,
      STATES.HUBCLOUD_DESTINATION_NOT_FOUND,
    ].includes(this.state);
  }

  isSuccess() {
    return this.state === STATES.HUBCLOUD_DETECTED && Boolean(this.destination);
  }

  getSummary() {
    return {
      success: this.isSuccess(),
      state: this.state,
      destination: this.destination,
      error: this.error,
      elapsedMs: Date.now() - this.startTime,
      meta: this.meta,
      history: this.history,
    };
  }
}

export default {
  STATES,
  MediatorStateMachine,
};
