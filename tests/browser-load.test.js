/**
 * Browser-load regression test.
 *
 * The other suites `require()` each module, giving every file its own scope —
 * which structurally CANNOT catch the bug where two classic <script> files
 * declare the same top-level `const`/`let`/`class` and collide in the shared
 * global lexical scope. This test loads the real files exactly as the browser
 * does (one shared global, no `require`/`module`, stubbed DOM/WebSocket/Audio)
 * and asserts the app constructs and opens its socket.  node --test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadInBrowserLikeContext } = require('./helpers/browser-context.js');

test('all front-end scripts load together without identifier collisions', () => {
    assert.doesNotThrow(loadInBrowserLikeContext);
});

test('shared globals are exported after load', () => {
    // These three are deliberately published onto window for cross-script use.
    // (DialupEmulator is not — only window.emulator is, via DOMContentLoaded.)
    const { sandbox } = loadInBrowserLikeContext();
    assert.equal(typeof sandbox.FEC, 'object');
    assert.equal(typeof sandbox.Bell202Demodulator, 'function');
    assert.equal(typeof sandbox.Bell202Modem, 'function');
});

test('app constructs on DOMContentLoaded and opens the WebSocket', () => {
    const { sandbox, handlers, openedSocket } = loadInBrowserLikeContext();
    assert.ok(handlers.DOMContentLoaded, 'app should register DOMContentLoaded');
    assert.doesNotThrow(() => handlers.DOMContentLoaded());
    assert.equal(typeof sandbox.emulator, 'object');
    assert.ok(openedSocket(), 'connectWebSocket() should have run');
});
