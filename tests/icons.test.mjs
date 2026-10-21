import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PACKAGE_FILES} from '../scripts/package.mjs';

test('extension icons are packaged PNGs at each declared size', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.template.json', import.meta.url)));
  for (const size of [16, 32, 48, 128]) {
    const file = `icons/icon-${size}.png`;
    assert.equal(manifest.icons?.[size], file);
    assert.ok(PACKAGE_FILES.includes(file), `${file} packaged`);
    const png = fs.readFileSync(new URL(`../${file}`, import.meta.url));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});
