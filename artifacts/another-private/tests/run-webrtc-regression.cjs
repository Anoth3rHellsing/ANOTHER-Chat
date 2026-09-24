#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const chromium = '/repl/tools/bin/chromium';
const htmlPath = path.join(__dirname, 'webrtc-regression.html');
const timeoutMs = 35000;
let browserOutput = '';
let settled = false;
let server;
let browser;
let timer;
let tempProfile;

function cleanup() {
  clearTimeout(timer);
  if (server) server.close();
  const removeProfile = () => {
    if (!tempProfile) return;
    try {
      fs.rmSync(tempProfile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    }
    catch (error) { console.warn(`Could not remove temporary Chromium profile: ${error.message}`); }
  };
  if (browser && browser.exitCode === null) {
    browser.once('close', removeProfile);
    browser.kill('SIGTERM');
  } else {
    removeProfile();
  }
}

function finish(error, payload) {
  if (settled) return;
  settled = true;
  cleanup();
  if (error) {
    console.error(error.message);
    if (browserOutput) console.error(`Chromium output:\n${browserOutput.slice(-6000)}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
  if (payload.status !== 'passed') process.exitCode = 1;
}

if (!fs.existsSync(chromium) || !fs.existsSync(htmlPath)) {
  finish(new Error(`Required Chromium or test page missing: ${chromium}`));
} else {
  server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      fs.createReadStream(htmlPath).pipe(response);
      return;
    }
    if (request.method === 'POST' && request.url === '/report') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => {
        body += chunk;
        if (body.length > 100000) request.destroy();
      });
      request.on('end', () => {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch (error) {
          response.writeHead(400);
          response.end('invalid test report');
          finish(new Error(`Invalid browser test report: ${error.message}`));
          return;
        }
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('ok');
        finish(null, payload);
      });
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });

  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    tempProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'webrtc-regression-chromium-'));
    browser = spawn(chromium, [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-extensions',
      '--disable-default-apps',
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      `--user-data-dir=${tempProfile}`,
      `http://127.0.0.1:${address.port}/`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    browser.stdout.on('data', chunk => { browserOutput += chunk.toString(); });
    browser.stderr.on('data', chunk => { browserOutput += chunk.toString(); });
    browser.on('error', error => finish(new Error(`Could not launch Chromium: ${error.message}`)));
    browser.on('exit', (code, signal) => {
      if (!settled) finish(new Error(`Chromium exited before reporting results (code=${code}, signal=${signal})`));
    });
    timer = setTimeout(() => finish(new Error(`Browser regression timed out after ${timeoutMs}ms`)), timeoutMs);
  });
}