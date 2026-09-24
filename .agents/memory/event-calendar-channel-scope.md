---
name: Event calendar channel scope
description: Why the event calendar is offered in text channels rather than file-only media channels
---

The discoverable event-calendar entry belongs in text channels. A created event also writes a channel message; the media channel is a file-only surface, not a message stream.

**Why:** Offering event creation in a file-only channel would create a valid message announcement that members cannot see there. An icon-only entry in the text-channel header had also made the feature difficult to discover.

**How to apply:** Keep the calendar entry visibly labeled in text-channel headers, and ensure new event announcements remain visible alongside messages. If media-channel events are later added, give media channels a deliberate announcement surface and test it, rather than only exposing the same action there.