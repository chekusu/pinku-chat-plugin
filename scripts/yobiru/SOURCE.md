# Bundled Yobiru Friends client

These files are the unmodified Friends client of [Yobiru](https://github.com/chekusu/yobiru) (MIT, see LICENSE),
copied from `public_bots/` at commit 95fc55e (branch claude/project-thread-2xud09, after 0.7.3:
partner email attestations and follow permits). Pinku.chat runs `bot_client.py` as a subprocess for direct
messages (`plugins/shared/friends.mjs`); it needs only Python 3.8+ and its standard library.

Update them by copying the same four files from a newer Yobiru release; never edit them here.
