'use strict';

/**
 * tokenmaster: core context-budget metering and decision engine for LLM
 * applications.
 *
 * Placeholder release (0.0.1) reserving the package name while the core API
 * is designed. Do not build against this version.
 */

const version = '0.0.1';

function about() {
  return {
    name: 'tokenmaster',
    version,
    summary:
      'Core context-budget metering and decision engine for LLM applications.',
    companion: 'ctxmaster (visualization layer)',
    repository: 'https://github.com/jemsbhai/tokenmaster',
    status: 'placeholder',
  };
}

module.exports = { version, about };
