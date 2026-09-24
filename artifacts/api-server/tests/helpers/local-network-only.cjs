// Injected into regression Node processes. Local API/PostgreSQL are allowed;
// accidental calls to provider hosts or workspace services fail immediately.
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");

function local(host) {
  return host === undefined || host === "localhost" || host === "127.0.0.1" ||
    host === "::1" || host === "[::1]";
}

function hostOf(first) {
  if (first instanceof URL) return first.hostname;
  if (typeof first === "string") {
    if (/^https?:\/\//i.test(first)) return new URL(first).hostname;
    return undefined; // Unix socket, or relative local path.
  }
  return first?.hostname ?? first?.host;
}

function guardHost(host) {
  if (!local(host)) throw new Error(`Regression suite blocked an external network connection to ${host}`);
}

const fetchOriginal = globalThis.fetch;
globalThis.fetch = function (input, ...args) {
  guardHost(hostOf(input instanceof Request ? input.url : input));
  return fetchOriginal.call(this, input, ...args);
};

for (const transport of [http, https]) {
  const request = transport.request;
  transport.request = function (input, ...args) {
    guardHost(hostOf(input));
    if (args[0] && typeof args[0] === "object") guardHost(hostOf(args[0]));
    return request.call(this, input, ...args);
  };
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  if (typeof first === "object" && first !== null) guardHost(hostOf(first));
  else if (typeof first === "number") guardHost(args[1]);
  return connect.apply(this, args);
};