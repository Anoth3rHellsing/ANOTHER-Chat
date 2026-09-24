import assert from "node:assert/strict";
import test from "node:test";
import {
  WatchSessionStore,
  advanceWatchCursor,
  canControlWatchAction,
  createWatchItem,
  getExpectedWatchPosition,
  isActiveWatchCallParticipant,
  normalizeWatchLink,
} from "./watch-sessions.ts";

test("normalizes supported YouTube and SoundCloud track links without retaining tracking", () => {
  assert.deepEqual(normalizeWatchLink("https://youtu.be/dQw4w9WgXcQ?t=12"), {
    platform: "youtube",
    contentId: "dQw4w9WgXcQ",
    canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Vídeo de YouTube dQw4w9WgXcQ",
  });
  assert.equal(normalizeWatchLink("http://m.youtube.com/shorts/dQw4w9WgXcQ").contentId, "dQw4w9WgXcQ");
  assert.equal(
    normalizeWatchLink("https://www.soundcloud.com/Artist/Track?utm_source=copy").canonicalUrl,
    "https://soundcloud.com/Artist/Track",
  );
  assert.equal(
    normalizeWatchLink("https://m.soundcloud.com/art%C3%ADst/tr%C3%A4ck?si=tracking").canonicalUrl,
    "https://soundcloud.com/art%C3%ADst/tr%C3%A4ck",
  );
});

test("rejects non-platform origins, lookalike hosts, credentials and invalid content IDs", () => {
  for (const url of [
    "https://open.spotify.com/track/123",
    "https://youtube.com.evil.invalid/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/short",
    "https://user@youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch/?v=dQw4w9WgXcQ",
    "https://youtube.com/watch/v/dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ&v=abcdefghijk",
    "https://soundcloud.com/artist",
    "https://soundcloud.com/artist/sets/mix-1",
    "https://soundcloud.com/artist//track",
    "https://soundcloud.com/artist%2Fescape/track",
    "https://on.soundcloud.com/share-code",
    "javascript:alert(1)",
  ]) {
    assert.throws(() => normalizeWatchLink(url), undefined, url);
  }
});

test("localizes control-only actions to the controller even when everyone can play", () => {
  const session = {
    controllerUserId: 12,
    allowEveryone: true,
    current: null,
    queue: [],
    playing: true,
    positionMs: 0,
    updatedAtMs: 0,
    revision: 1,
  };
  for (const action of ["metadata", "everyone", "transfer", "end"]) {
    assert.equal(canControlWatchAction(session, 27, action), false, action);
    assert.equal(canControlWatchAction(session, 12, action), true, action);
  }
  assert.equal(canControlWatchAction(session, 27, "play"), true);
  session.allowEveryone = false;
  assert.equal(canControlWatchAction(session, 27, "play"), false);
});

test("recognizes either active DM endpoint as a transfer target, but never an outsider", () => {
  const call = {
    active: true,
    callerUserId: 12,
    recipientUserId: 27,
  };
  assert.equal(isActiveWatchCallParticipant(call, 27, 12, 27), true);
  assert.equal(isActiveWatchCallParticipant(call, 12, 12, 27), true);
  assert.equal(isActiveWatchCallParticipant(call, 99, 12, 27), false);
  assert.equal(isActiveWatchCallParticipant({ ...call, active: false }, 27, 12, 27), false);
  assert.equal(isActiveWatchCallParticipant(call, 27, 12, 99), false);
});

test("keeps call sessions in memory and computes an authoritative clock-based position", () => {
  const store = new WatchSessionStore();
  const item = createWatchItem(
    normalizeWatchLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    12,
    "Alice",
  );
  store.start("voice", 55, 12, item, 1_000);
  assert.equal(getExpectedWatchPosition(store.get("voice", 55), 3_250), 2_250);
  const snapshot = store.snapshot("voice", 55, 3_250);
  assert.equal(snapshot.positionMs, 2_250);
  assert.equal(snapshot.updatedAtMs, 3_250);
  assert.equal(snapshot.serverNowMs, 3_250);
  assert.equal(store.get("voice", 55).current.addedByName, "Alice");
  const changed = store.get("voice", 55);
  advanceWatchCursor(changed, 3_250);
  changed.allowEveryone = true;
  store.save("voice", 55, changed);
  const afterNonPlaybackMutation = store.get("voice", 55);
  assert.equal(afterNonPlaybackMutation.positionMs, 2_250);
  assert.equal(afterNonPlaybackMutation.updatedAtMs, 3_250);
  assert.equal(getExpectedWatchPosition(afterNonPlaybackMutation, 3_500), 2_500);
  assert.equal(store.end("voice", 55), true);
  assert.equal(store.snapshot("voice", 55, 4_000), null);
});

test("watching is opt-in, late joiners get an ordered seat, and the controller hands off or ends cleanly", () => {
  const store = new WatchSessionStore();
  const item = createWatchItem(
    normalizeWatchLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    12,
    "Alice",
  );
  store.start("voice", 55, 12, item, 1_000);
  assert.deepEqual(store.snapshot("voice", 55, 5_000).watchingUserIds, [12]);
  assert.equal(store.isWatching("voice", 55, 27), false);

  store.join("voice", 55, 27);
  assert.deepEqual(store.snapshot("voice", 55, 5_000).watchingUserIds, [12, 27]);
  const handedOff = store.leave("voice", 55, 12);
  assert.equal(handedOff.controllerUserId, 27);
  assert.deepEqual(store.snapshot("voice", 55, 5_000).watchingUserIds, [27]);

  store.join("voice", 55, 12);
  assert.deepEqual(store.snapshot("voice", 55, 5_000).watchingUserIds, [27, 12]);
  assert.equal(store.leave("voice", 55, 12).controllerUserId, 27);
  assert.equal(store.leave("voice", 55, 27), null);
  assert.equal(store.snapshot("voice", 55, 5_000), null);
});

test("normalizes both direct-call perspectives to the same ephemeral session", () => {
  const store = new WatchSessionStore();
  const item = createWatchItem(
    normalizeWatchLink("https://soundcloud.com/artist/track"),
    12,
    "Alice",
  );
  store.start("dm", 27, 12, item, 10_000, 12);
  assert.equal(store.get("dm", 12, 27).current.id, item.id);
  assert.equal(store.snapshot("dm", 12, 10_100, 27).controllerUserId, 12);
});

test("rechecks membership after profile lookup before committing a start", async () => {
  const store = new WatchSessionStore();
  let connected = true;
  let releaseLookup;
  const profileLookup = new Promise(resolve => {
    releaseLookup = resolve;
  });
  const startAfterLookup = async () => {
    const displayName = await profileLookup;
    if (!connected) return false;
    if (store.has("voice", 55)) return false;
    store.start(
      "voice",
      55,
      12,
      createWatchItem(
        normalizeWatchLink("https://youtu.be/dQw4w9WgXcQ"),
        12,
        displayName,
      ),
      1_000,
    );
    return true;
  };

  const pendingStart = startAfterLookup();
  connected = false;
  releaseLookup("Alice");
  assert.equal(await pendingStart, false);
  assert.equal(store.has("voice", 55), false);
});

test("only one concurrent async start can establish the session", async () => {
  const store = new WatchSessionStore();
  let releaseLookup;
  const profileLookup = new Promise(resolve => {
    releaseLookup = resolve;
  });
  const startAfterLookup = async (userId, displayName) => {
    await profileLookup;
    if (store.has("voice", 55)) return false;
    store.start(
      "voice",
      55,
      userId,
      createWatchItem(
        normalizeWatchLink("https://youtu.be/dQw4w9WgXcQ"),
        userId,
        displayName,
      ),
      1_000,
    );
    return true;
  };

  const first = startAfterLookup(12, "Alice");
  const second = startAfterLookup(27, "Bob");
  releaseLookup();
  assert.deepEqual(await Promise.all([first, second]), [true, false]);
  assert.equal(store.get("voice", 55).controllerUserId, 12);
});

test("concurrent async queue requests reload the latest session before appending", async () => {
  const store = new WatchSessionStore();
  store.start(
    "voice",
    55,
    12,
    createWatchItem(
      normalizeWatchLink("https://youtu.be/dQw4w9WgXcQ"),
      12,
      "Alice",
    ),
    1_000,
  );
  let releaseLookup;
  const profileLookup = new Promise(resolve => {
    releaseLookup = resolve;
  });
  const appendAfterLookup = async (slug, displayName) => {
    await profileLookup;
    const current = store.get("voice", 55);
    current.queue.push(createWatchItem(
      normalizeWatchLink(`https://soundcloud.com/artist/${slug}`),
      12,
      displayName,
    ));
    store.save("voice", 55, current);
  };

  const first = appendAfterLookup("one", "Alice");
  const second = appendAfterLookup("two", "Bob");
  releaseLookup();
  await Promise.all([first, second]);
  assert.deepEqual(store.get("voice", 55).queue.map(item => item.contentId), [
    "artist/one",
    "artist/two",
  ]);
});