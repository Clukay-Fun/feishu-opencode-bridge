# Feishu OpenCode Bridge

Feishu OpenCode Bridge is a standalone TypeScript service that connects Feishu chat messages to the local OpenCode Server API.

It listens to Feishu message events over WebSocket, maps each conversation to an OpenCode session, forwards prompts to `opencode serve`, receives assistant output from the OpenCode SSE event stream, and posts the result back to Feishu.

## Features

- Supports Feishu `p2p`, `group`, and `topic_group` chats
- Uses per-window session registries with configurable `single` or `multi` mode
- Uses thread-aware isolation for group chats
- Supports OpenCode `prompt_async`, command routing, abort, status, models, permissions, and session switching
- Supports optional long-term memory recall, embedding-based retrieval, and Obsidian profile sync
- Streams progress into a Feishu interactive card and updates the same message in place
- Supports strict or relaxed group mention matching through config
- Supports multiple bot identities and separate self-bot identities
- Deduplicates repeated Feishu message deliveries by `message_id`
- Persists Feishu conversation to OpenCode session bindings with LRU trimming
- Supports OpenCode Basic Auth through `OPENCODE_SERVER_PASSWORD`

## Architecture

The main runtime flow is:

1. Feishu sends `im.message.receive_v1` events over WebSocket.
2. The bridge normalizes the incoming message, applies group mention rules, and derives a `conversationKey`.
3. The runtime resolves or creates an OpenCode session for that conversation.
4. The bridge sends the prompt through `POST /session/:id/prompt_async`.
5. The OpenCode SSE stream (`/event`, fallback `/global/event`) delivers assistant updates.
6. The bridge updates a Feishu reply card until the turn is complete.

Key modules:

- `src/feishu/`
  Feishu API client, formatter, and inbound WS normalization
- `src/opencode/`
  OpenCode HTTP client and SSE event stream
- `src/runtime/`
  Main orchestration, queueing, cards, session binding, and event handling
- `src/store/`
  JSON-backed persistent stores
- `src/bridge/`
  Queueing, routing, pending interactions, and watchdog logic

## Requirements

- Node.js 20+
- A Feishu app with bot capability enabled
- A running local OpenCode server:

```bash
opencode serve
```

## Install

```bash
npm install
```

## Configuration

Copy the example config and fill in your real values:

```json
{
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "botOpenId": "ou_xxx",
    "botOpenIds": ["ou_xxx", "ou_yyy"],
    "botMentionNames": ["opencode", "open code"],
    "selfBotOpenId": "ou_xxx",
    "selfBotOpenIds": ["ou_xxx"],
    "wsUrl": "wss://open.feishu.cn/open-apis/ws/v2",
    "allowedOpenIds": [],
    "behavior": {
      "enableP2p": true,
      "enableGroup": true,
      "requireBotMentionInGroup": true,
      "strictBotMention": true,
      "ignoreNonUserSenders": true,
      "replyInThread": true
    }
  },
  "opencode": {
    "baseUrl": "http://127.0.0.1:4096/",
    "directory": "/absolute/path/to/project"
  },
  "storage": {
    "dataDir": "./data",
    "mappingsFile": "mappings.json"
  },
  "bridge": {
    "queueLimit": 3,
    "sessions": {
      "p2pMode": "multi",
      "groupMode": "single",
      "topicGroupMode": "single",
      "maxSessionsPerWindow": 20,
      "listLimit": 10,
      "injectSystemState": true
    },
    "timeouts": {
      "firstEvent": 30000,
      "eventInterval": 120000,
      "totalTurn": 300000
    }
  },
  "memory": {
    "enabled": false,
    "dbPath": "./data/memory.db",
    "maxMemoriesPerUser": 500,
    "searchLimit": 5,
    "extractQueueLimit": 100,
    "sourcePreviewLength": 50,
    "shutdownDrainTimeoutMs": 5000,
    "retriever": "recent",
    "embeddingSimilarityThreshold": 0.75,
    "embeddingProvider": {
      "baseUrl": "https://api.openai.com/v1/",
      "apiKey": "sk-xxx",
      "model": "text-embedding-3-small"
    },
    "obsidian": {
      "enabled": false,
      "vaultPath": "/absolute/path/to/vault",
      "syncCron": "0 2 * * *",
      "enableWikiLinks": false
    }
  },
  "logging": {
    "dir": "./logs",
    "level": "info",
    "enableTranscript": true,
    "enableConsole": true,
    "enableColor": true,
    "rotateDaily": true
  }
}
```

### Feishu config notes

- `botOpenId`
  Legacy single identity setting. Still supported.
- `botOpenIds`
  All bot identities that should trigger this bridge in group chats.
- `botMentionNames`
  Extra display-name fallbacks used only when mention IDs are unreliable.
- `selfBotOpenId` and `selfBotOpenIds`
  Identities that belong to this bridge itself. These are ignored when Feishu re-delivers bot-originated messages, which helps prevent reply loops.
- `allowedOpenIds`
  Optional sender whitelist. When non-empty, only these users can talk to the bridge.

### Group mention behavior

When `requireBotMentionInGroup=true`, group messages are handled only when they match your configured bot identity rules.

When `strictBotMention=true`, the bridge only accepts messages that explicitly mention one of the configured bot identities.

### Session modes

- `p2pMode`, `groupMode`, and `topicGroupMode` control whether a window behaves as `single` or `multi` session mode.
- `single` keeps exactly one active session in the window. `/new` replaces it. `/switch` and `/sessions <index>` are rejected.
- `multi` keeps multiple sessions per window, shows them through `/sessions`, and allows switching with `/switch <index>` or `/sessions <index>`.
- `injectSystemState=true` adds bridge-owned window and session state into the OpenCode `system` field without polluting the user message text.

### Memory

- `memory.enabled=true` turns on long-term user memory keyed by `senderOpenId`.
- `retriever="recent"` always recalls the user's most recently accessed facts.
- `retriever="embedding"` uses the configured OpenAI-compatible embeddings API and falls back to recent recall when no vector match is found.
- `obsidian.enabled=true` writes `${vaultPath}/memory/<userId>/profile.md` on the configured cron schedule and also runs a startup catch-up sync when needed.

## OpenCode auth

If your OpenCode server is protected, set:

```bash
export OPENCODE_SERVER_PASSWORD=your-password
export OPENCODE_SERVER_USERNAME=opencode
```

## Development

Start OpenCode first:

```bash
opencode serve
```

Then start the bridge:

```bash
npm run dev
```

Useful scripts:

```bash
npm run typecheck
npm test
npm run lint
npm run dev:once
```

## Commands

Supported slash commands:

- `/new`
- `/status`
- `/abort`
- `/models`
- `/sessions`
- `/switch <index>`
- `/sessions <index>`
- `/allow once`
- `/allow always`
- `/deny`
- any other slash command is forwarded to the OpenCode command endpoint

## Logging and troubleshooting

Logs are written to `logs/`.

Useful log patterns:

- `feishu/ws message received`
  The bridge accepted and normalized a Feishu message
- `feishu/ws message skipped`
  The bridge saw the event but filtered it
- `feishu/ws duplicate message skipped`
  Feishu re-delivered the same `message_id`
- `opencode/events event stream connected`
  OpenCode SSE is healthy
- `bridge/queue turn started`
  A prompt is being processed

If a group message does not trigger:

1. Check whether the message shows up in `feishu/ws message skipped`.
2. Compare `mentionIds` in the log with your configured `botOpenIds`.
3. Confirm that the bot is actually in the group and the Feishu app has the required message permissions.

## Current limitations

- The bridge depends on a locally running `opencode serve` process.
- Feishu may re-deliver the same `message_id`; the bridge deduplicates these in memory, not across restarts.
- Robot-to-robot behavior depends on what Feishu delivers to the app. Some robot-to-robot scenarios may not be supported by Feishu itself.

## License

This repository currently has no explicit license file.
