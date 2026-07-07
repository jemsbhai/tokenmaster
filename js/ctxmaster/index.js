'use strict';

/**
 * ctxmaster: visualization layer for tokenmaster.
 *
 * Placeholder release (0.0.1) reserving the package name while the core API
 * is designed. Do not build against this version.
 */

const tokenmaster = require('tokenmaster');

const version = '0.0.1';

function about() {
  return {
    name: 'ctxmaster',
    version,
    summary:
      'Visualization layer for tokenmaster: CLI, terminal gauge, and dashboard renderers.',
    core: `tokenmaster ${tokenmaster.version}`,
    repository: 'https://github.com/jemsbhai/tokenmaster',
    status: 'placeholder',
  };
}

module.exports = { version, about };
