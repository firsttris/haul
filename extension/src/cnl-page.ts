/**
 * Runs in the page's own world (content script with `world: MAIN`) before the page's scripts.
 *
 * Click'n'Load buttons send the links to `http://127.0.0.1:9666/flash/add` or
 * `/flash/addcrypted2`, where JDownloader used to listen. Nothing listens there when Haul runs
 * on a server, and Chrome would ask for access to the local network first. So the requests are
 * taken over here, before the browser sends them: `fetch`, `XMLHttpRequest` and forms (submitted
 * by a click or by `form.submit()`). Their form body goes to the relay (cnl-relay.ts), which
 * passes it to Haul; the page gets the "success" JDownloader would answer.
 *
 * `jdownloader` is what `http://127.0.0.1:9666/jdcheck.js` sets; pages look at it to see whether
 * Click'n'Load is available.
 *
 * With Click'n'Load turned off in the extension, everything goes out unchanged.
 */
import { cnlAction } from './links';

type Action = 'add' | 'addcrypted2';

const TAG = '__haulCnl';

let enabled: boolean | undefined;
const waiting: Array<(on: boolean) => void> = [];
const pending = new Map<number, (ok: boolean) => void>();
let nextId = 1;

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || typeof e.data !== 'object' || e.data[TAG] === undefined) return;
  const msg = e.data as { [TAG]: string; enabled?: boolean; id?: number; ok?: boolean };
  if (msg[TAG] === 'config') {
    enabled = !!msg.enabled;
    for (const w of waiting.splice(0)) w(enabled);
  } else if (msg[TAG] === 'result' && msg.id !== undefined) {
    pending.get(msg.id)?.(!!msg.ok);
    pending.delete(msg.id);
  }
});
window.postMessage({ [TAG]: 'hello' }, '*');

/** Whether Click'n'Load is on; waits for the relay's answer on the first request. */
function isOn(): Promise<boolean> {
  if (enabled !== undefined) return Promise.resolve(enabled);
  return new Promise((resolve) => {
    waiting.push(resolve);
    // No relay (the extension was updated or removed): leave the page alone.
    setTimeout(() => resolve(enabled ?? false), 3000);
  });
}

function forward(action: Action, body: string): Promise<boolean> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    window.postMessage({ [TAG]: 'request', id, action, body, page: location.href }, '*');
  });
}

/** A form body as text, whatever the page passed. */
function bodyText(body: unknown): string {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof FormData) {
    const p = new URLSearchParams();
    for (const [k, v] of body) if (typeof v === 'string') p.append(k, v);
    return p.toString();
  }
  return String(body);
}

const answer = (ok: boolean) => (ok ? 'success\r\n' : 'failed\r\n');

// JDownloader's presence check. Real JDownloader's jdcheck.js may still set it.
let jdReal: unknown;
try {
  Object.defineProperty(window, 'jdownloader', {
    configurable: true,
    get: () => (enabled === true ? true : jdReal),
    set: (v) => {
      jdReal = v;
    },
  });
} catch {
  // A page that defined it itself keeps it.
}

// fetch
const realFetch = window.fetch;
window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  const action = cnlAction(new URL(url, location.href).href);
  if (!action || !(await isOn())) return realFetch.call(this, input, init);
  const body = init?.body !== undefined ? bodyText(init.body) : input instanceof Request ? await input.clone().text() : '';
  const ok = await forward(action, body);
  return new Response(answer(ok), { status: ok ? 200 : 502, headers: { 'Content-Type': 'text/plain' } });
};

// XMLHttpRequest
const realOpen = XMLHttpRequest.prototype.open;
const realSend = XMLHttpRequest.prototype.send;
const cnlOf = new WeakMap<XMLHttpRequest, Action>();
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  const action = cnlAction(new URL(String(url), location.href).href);
  if (action) cnlOf.set(this, action);
  else cnlOf.delete(this);
  return (realOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
} as typeof XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
  const action = cnlOf.get(this);
  if (!action) return realSend.call(this, body);
  const xhr = this;
  void isOn().then(async (on) => {
    if (!on) return realSend.call(xhr, body);
    const ok = await forward(action, bodyText(body));
    const text = answer(ok);
    for (const [k, v] of Object.entries({ readyState: 4, status: ok ? 200 : 502, statusText: ok ? 'OK' : 'Bad Gateway', responseText: text, response: text, responseURL: '' })) {
      Object.defineProperty(xhr, k, { configurable: true, value: v });
    }
    for (const type of ['readystatechange', 'load', 'loadend']) xhr.dispatchEvent(new ProgressEvent(type));
  });
};

// Forms: a click on the button (submit event) and form.submit() (no event).
function formBody(form: HTMLFormElement, submitter?: HTMLElement | null): string {
  let data: FormData;
  try {
    data = new FormData(form, submitter ?? undefined);
  } catch {
    data = new FormData(form);
  }
  return bodyText(data);
}

document.addEventListener(
  'submit',
  (e) => {
    const form = e.target as HTMLFormElement;
    const action = cnlAction(form.action);
    if (!action || enabled === false) return;
    e.preventDefault();
    const body = formBody(form, (e as SubmitEvent).submitter);
    void isOn().then((on) => {
      if (on) void forward(action, body);
      else realSubmit.call(form);
    });
  },
  true,
);
const realSubmit = HTMLFormElement.prototype.submit;
HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
  const action = cnlAction(this.action);
  if (!action || enabled === false) return realSubmit.call(this);
  const form = this;
  const body = formBody(form);
  void isOn().then((on) => {
    if (on) void forward(action, body);
    else realSubmit.call(form);
  });
};
