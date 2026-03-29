'use strict';

/**
 * Thrown when an external API (GitHub or WebSim) signals a rate limit.
 * The pipeline catches this and retries after the appropriate backoff.
 */
class RateLimitError extends Error {
  /**
   * @param {'GitHub'|'WebSim'} source   Which service rate-limited us
   * @param {number|null}       retryAfterMs  How long to wait (null = use backoff table)
   */
  constructor(source, retryAfterMs = null) {
    super(`Rate limited by ${source}`);
    this.name = 'RateLimitError';
    this.isRateLimit = true;
    this.source = source;
    this.retryAfterMs = retryAfterMs;
  }
}

module.exports = { RateLimitError };
