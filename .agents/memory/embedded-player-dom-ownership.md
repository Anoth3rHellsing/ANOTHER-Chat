---
name: Embedded player DOM ownership
description: Prevent reconciliation crashes when official YouTube and SoundCloud players replace their mount nodes
---

Give a third-party player exclusive ownership of the DOM descendants of an empty React host. Use a distinct keyed player instance for each session, platform, and item. Clean up in a layout-effect teardown before React removes the host; catch SDK cleanup errors so one failed destroy does not crash the app.

**Why:** The YouTube API replaces the element it receives, so a React-owned element can disappear before React reconciles the next queued item, causing a removeChild/not-a-child exception. SoundCloud's official widget API exposes pause and event unbinding but does not guarantee a destroy method; those commands must precede imperative removal of its iframe. Simulated SDK replacements and real SDK cross-platform transitions showed that owning only the host prevents the crash.

**How to apply:** When changing a media integration or queue transition, keep the SDK's mount and frame out of React's rendered children; don't pass a React-owned node to an SDK that may replace it. Stop/unbind (and call destroy where supported), then clear the host during layout cleanup. Test both end-of-media events and manual cross-platform transitions in an isolated browser.