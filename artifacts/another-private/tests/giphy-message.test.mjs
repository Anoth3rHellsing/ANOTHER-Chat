import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GIPHY_MESSAGE_PREFIX,
  isTrustedGiphyMediaUrl,
  parseGiphyMessage,
  serializeGiphyMessage,
} from "../src/lib/giphy.ts";

test("serializes only HTTPS GIPHY media URLs as a typed message sentinel", () => {
  const url = "https://media1.giphy.com/media/abc/giphy.gif";
  const content = serializeGiphyMessage(url);
  assert.equal(content, `${GIPHY_MESSAGE_PREFIX}${url}`);
  assert.equal(parseGiphyMessage(content), url);
});

test("ordinary message text remains ordinary and invalid sentinel payloads never render as images", () => {
  assert.equal(parseGiphyMessage("Hello https://media.giphy.com/x.gif"), null);
  assert.equal(parseGiphyMessage(`${GIPHY_MESSAGE_PREFIX}https://evil.example/a.gif`), null);
  assert.equal(parseGiphyMessage(`${GIPHY_MESSAGE_PREFIX}http://media.giphy.com/a.gif`), null);
});

test("the renderer URL allowlist blocks lookalike hostnames, credentials, and arbitrary ports", () => {
  assert.equal(isTrustedGiphyMediaUrl("https://media.giphy.com/a.gif"), true);
  assert.equal(isTrustedGiphyMediaUrl("https://images.giphy.com/a.gif"), true);
  assert.equal(isTrustedGiphyMediaUrl("https://media.giphy.com.attacker.test/a.gif"), false);
  assert.equal(isTrustedGiphyMediaUrl("https://user@media.giphy.com/a.gif"), false);
  assert.equal(isTrustedGiphyMediaUrl("https://media.giphy.com:8443/a.gif"), false);
  assert.equal(isTrustedGiphyMediaUrl("data:image/gif;base64,AAAA"), false);
});