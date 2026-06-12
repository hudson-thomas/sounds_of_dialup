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
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const STATIC = path.join(__dirname, '..', 'static');
// Same order as index.html.
const SCRIPTS = ['fec.js', 'demod.js', 'bell202.js', 'app.js'];

function makeElementStub(id) {
    return {
        id, value: '0', checked: true, textContent: '', innerHTML: '',
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        style: {}, scrollTop: 0, scrollHeight: 0,
        addEventListener() {}, insertBefore() {}, appendChild() {},
        querySelector() { return makeElementStub('cursor'); }
    };
}

function loadInBrowserLikeContext() {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext('var window = globalThis;', sandbox);

    Object.assign(sandbox, {
        console, Math, JSON, Float32Array, Uint8Array, Array, Object, String, Date,
        setTimeout, clearTimeout,
        requestAnimationFrame: (fn) => setTimeout(fn, 16),
        cancelAnimationFrame: clearTimeout,
        addEventListener() {}, removeEventListener() {},  // window.* event API
        navigator: { userAgent: 'node-test' },
        location: { protocol: 'http:', host: '127.0.0.1:8000' }
    });

    const handlers = {};
    let socketOpened = false;
    sandbox.document = {
        getElementById: (id) => makeElementStub(id),
        addEventListener: (ev, fn) => { handlers[ev] = fn; },
        createElement: () => makeElementStub('new'),
        createTextNode: () => ({})
    };
    sandbox.WebSocket = class { constructor(url) { this.url = url; socketOpened = true; } send() {} close() {} };
    sandbox.AudioContext = class { constructor() { this.state = 'running'; this.destination = {}; } };

    for (const file of SCRIPTS) {
        const src = fs.readFileSync(path.join(STATIC, file), 'utf8');
        vm.runInContext(src, sandbox, { filename: file });
    }
    return { sandbox, handlers, openedSocket: () => socketOpened };
}

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
