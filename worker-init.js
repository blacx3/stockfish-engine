// session key passed via URL hash from content.js
// message property names are random — not static strings
const SK = window.location.hash.slice(1) || 'fallback';
const IN  = SK + 'i'; // content→worker key
const OUT = SK + 'o'; // worker→content key
const ERR = SK + 'e';
const RDY = SK + 'r';

let engine = null;
try {
    const base = window.location.href.substring(0, window.location.href.lastIndexOf('/') + 1);
    engine = new Worker(base + 'analysis.js');

    engine.onmessage = function(ev) {
        const msg = {};
        msg[OUT] = ev.data;
        window.parent.postMessage(msg, '*');
    };
    engine.onerror = function(ev) {
        const msg = {};
        msg[ERR] = ev.message || 'error';
        window.parent.postMessage(msg, '*');
    };

    const rdyMsg = {};
    rdyMsg[RDY] = 1;
    window.parent.postMessage(rdyMsg, '*');

    window.addEventListener('message', function(ev) {
        const cmd = ev.data && ev.data[IN];
        if (cmd && engine) engine.postMessage(cmd);
    });
} catch(e) {
    const msg = {};
    msg[ERR] = e.toString();
    window.parent.postMessage(msg, '*');
}
