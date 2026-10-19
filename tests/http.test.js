// Fence tests for the panel/state API. `isPanelRequest` must keep the API local
// even though a cloudflared forward also arrives from a loopback socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPanelRequest } from '../lib/http.js';

function fakeReq({ remote = '127.0.0.1', headers = {} } = {}) {
  return { socket: { remoteAddress: remote }, headers };
}

test('panel: plain loopback curl passes', () => {
  const req = fakeReq({ headers: { host: '127.0.0.1:43120' } });
  assert.equal(isPanelRequest(req), true);
});

test('panel: localhost host passes', () => {
  const req = fakeReq({ headers: { host: 'localhost:43120' } });
  assert.equal(isPanelRequest(req), true);
});

test('panel: ipv6 loopback host passes', () => {
  const req = fakeReq({ headers: { host: '[::1]:43120' } });
  assert.equal(isPanelRequest(req), true);
});

test('panel: non-loopback socket is refused', () => {
  const req = fakeReq({ remote: '192.168.1.10', headers: { host: '127.0.0.1:43120' } });
  assert.equal(isPanelRequest(req), false);
});

test('panel: non-loopback Host is refused', () => {
  const req = fakeReq({ headers: { host: 'my-tunnel.example.trycloudflare.com' } });
  assert.equal(isPanelRequest(req), false);
});

test('panel: cloudflared forward (cf-connecting-ip + tunnel Host) is refused', () => {
  const req = fakeReq({
    headers: {
      host: 'my-tunnel.example.trycloudflare.com',
      'cf-connecting-ip': '203.0.113.7',
      'cf-ray': '8f1a…-HKG',
    },
  });
  assert.equal(isPanelRequest(req), false);
});

test('panel: x-forwarded-for without tunnel headers still refused on tunnel Host', () => {
  const req = fakeReq({ headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
  assert.equal(isPanelRequest(req), false);
});

test('panel: any tunnel header alone is refused', () => {
  for (const header of ['cf-connecting-ip', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'cf-ray']) {
    const req = fakeReq({ headers: { host: '127.0.0.1:43120', [header]: 'x' } });
    assert.equal(isPanelRequest(req), false, header);
  }
});

test('panel: cross-site sec-fetch-site is refused', () => {
  const req = fakeReq({ headers: { host: '127.0.0.1:43120', 'sec-fetch-site': 'cross-site' } });
  assert.equal(isPanelRequest(req), false);
});

test('panel: same-site sec-fetch-site is refused', () => {
  const req = fakeReq({ headers: { host: '127.0.0.1:43120', 'sec-fetch-site': 'same-site' } });
  assert.equal(isPanelRequest(req), false);
});

test('panel: same-origin sec-fetch-site passes', () => {
  const req = fakeReq({ headers: { host: '127.0.0.1:43120', 'sec-fetch-site': 'same-origin' } });
  assert.equal(isPanelRequest(req), true);
});

test('panel: mismatched Origin is refused (CSRF)', () => {
  const req = fakeReq({ headers: { host: '127.0.0.1:43120', origin: 'https://evil.example' } });
  assert.equal(isPanelRequest(req), false);
});

test('panel: matching same-origin Origin passes', () => {
  const req = fakeReq({ headers: { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120' } });
  assert.equal(isPanelRequest(req), true);
});

test('panel: unparseable Origin is refused', () => {
  const req = fakeReq({ headers: { host: '127.0.0.1:43120', origin: 'not a url' } });
  assert.equal(isPanelRequest(req), false);
});

test('panel: empty Host is refused', () => {
  const req = fakeReq({ headers: {} });
  assert.equal(isPanelRequest(req), false);
});

test('panel: uppercase Host and Origin are normalized', () => {
  const req = fakeReq({ headers: { host: 'LOCALHOST:43120', origin: 'HTTP://LOCALHOST:43120' } });
  assert.equal(isPanelRequest(req), true);
});
