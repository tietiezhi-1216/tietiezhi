# Codex Remote Control And Realtime

R35 implements the pinned Codex Remote Control and thread-scoped Realtime
lifecycles in source. It does not invoke or bundle the upstream Codex binary.

## Remote Control

`crates/agent-remote` owns the durable control-plane state:

- installation and environment identities;
- expiring opaque and manual pairing codes;
- paired-client metadata and revocation;
- exact client-to-Thread grants;
- bounded, durable request-result idempotency;
- disabled, connecting, connected, and errored status projection.

The App Server methods are:

- `remoteControl/enable`
- `remoteControl/disable`
- `remoteControl/status/read`
- `remoteControl/pairing/start`
- `remoteControl/pairing/status`
- `remoteControl/clients/list`
- `remoteControl/clients/revoke`

The pinned Codex service claims pairing codes outside App Server. Tietiezhi maps
that service-owned operation to an authenticated Device Fabric message named
`codex.remote.pair`. The pairing code is generated and shown only by the local
desktop UI. Pairing does not grant access to any Thread.

The local user grants and revokes each Thread independently. A remote request
must pass all of these checks:

1. Remote Control is enabled.
2. The Device Fabric identity is paired and has not been revoked.
3. The exact Thread is present in that client's grant set.
4. The request method is in the remote control allowlist.
5. The JSON-RPC `params.threadId` matches the authorized outer scope.
6. The remote request id is new or resolves to the same cached scope.

After authorization, the remote connection resumes the Thread under a
`remote:<clientId>` App Server connection. Model notifications and reverse
approval requests are routed back through Device Fabric. A remote approval is
accepted only when `ServerRequestBroker` confirms that the pending request
belongs to a Thread granted to that client.

## Realtime

`crates/agent-realtime` implements:

- `thread/realtime/start`
- `thread/realtime/appendAudio`
- `thread/realtime/appendText`
- `thread/realtime/appendSpeech`
- `thread/realtime/stop`
- `thread/realtime/listVoices`
- WebSocket V1/V2 and Frameless V3 URL/session shaping;
- WebRTC SDP call creation and sideband attachment;
- PCM16 Base64 validation with sample/channel consistency;
- bounded initial-item and text input validation;
- input request-id deduplication;
- reconnect with `x-session-id` and no input replay;
- output audio, transcript, item, SDP, error, started, and closed V2
  notifications.

The desktop panel captures 24 kHz mono PCM16, sends bounded frames, plays
interleaved PCM output, and renders input/output transcripts from strong-typed
notifications. Closing a Thread stops its Realtime session.

## Failure And Recovery

- Disconnects retain the active input channel and reconnect the same session.
- Sent audio/text is never replayed after reconnect.
- Duplicate App Server request ids are acknowledged without a second provider
  write.
- A terminal transport failure emits `thread/realtime/error` followed by
  `thread/realtime/closed`.
- Pairing, grants, revocation, and completed remote request results survive an
  application restart.
- Active audio capture and provider sockets are process-local and are closed on
  Thread close or application shutdown.

## Verification

- `cargo test --manifest-path crates/agent-remote/Cargo.toml`
- `cargo test --manifest-path crates/agent-realtime/Cargo.toml`
- `cargo test --manifest-path crates/agent-approval/Cargo.toml`
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml`
- `pnpm test:codex-remote-realtime-ui`
- `pnpm typecheck`
- `pnpm build`
