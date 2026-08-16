/**
 * Loads the front-end scripts exactly as the browser does: one shared global
 * lexical scope, no require/module, stubbed DOM + WebSocket + AudioContext.
 *
 * Not a test file (node --test only collects *.test.js here) — it's the shared
 * harness for browser-load.test.js and queue.test.js.
 */

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const STATIC = path.join(__dirname, '..', '..', 'static');
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
        TextEncoder, TextDecoder,   // present in every browser; not in a bare vm context
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

module.exports = { loadInBrowserLikeContext, makeElementStub, SCRIPTS, STATIC };
