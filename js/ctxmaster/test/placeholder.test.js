'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ctxmaster = require('..');
const tokenmaster = require('tokenmaster');

test('version matches placeholder', () => {
  assert.equal(ctxmaster.version, '0.0.1');
});

test('about reports core version', () => {
  const info = ctxmaster.about();
  assert.equal(info.name, 'ctxmaster');
  assert.ok(info.core.includes(tokenmaster.version));
  assert.equal(info.status, 'placeholder');
});
