'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const tokenmaster = require('..');

test('version matches placeholder', () => {
  assert.equal(tokenmaster.version, '0.0.1');
});

test('about returns expected metadata', () => {
  const info = tokenmaster.about();
  assert.equal(info.name, 'tokenmaster');
  assert.equal(info.version, tokenmaster.version);
  assert.equal(info.status, 'placeholder');
  assert.ok(info.companion.includes('ctxmaster'));
});
