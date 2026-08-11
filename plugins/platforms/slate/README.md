# Slate Hermes platform plugin

This adapter long-polls the Slate backend, sends each ink-screen request into a
single Hermes direct-message session, and posts the final reply back to the
waiting device. When Hermes loads the plugin, it registers both the `slate`
Gateway platform and the namespaced `slate-platform:slate-device` skill.

The platform handles transport. The skill contains device capabilities,
response constraints, configuration guidance, and diagnostics.

Voice requests arrive as base64 PCM16 in the pending payload. The adapter wraps
them as 16 kHz mono WAV, stores the file in Hermes' audio cache, and runs the
Gateway's configured STT path once. The resulting transcript is used for the
agent event and returned to Slate with the reply, so the device can show what
it heard instead of a generic voice placeholder. The event is marked as already
transcribed to avoid a second STT pass. Text requests keep the existing
`MessageType.TEXT` path.

## Install

Install it as a user platform plugin. This does not modify the Hermes Agent
checkout:

```bash
mkdir -p ~/.hermes/plugins/platforms
cp -R plugins/platforms/slate ~/.hermes/plugins/platforms/slate
hermes plugins enable platforms/slate
hermes plugins list
```

Configure both processes with the same random token:

```bash
openssl rand -hex 32

# Slate backend
HERMES_AGENT_TOKEN=<generated-token>

# Hermes Gateway
SLATE_BACKEND=https://your-slate-backend.example.com
SLATE_AGENT_TOKEN=<generated-token>
# Optional; Slate defaults local STT to Chinese. Use `auto` to keep Hermes' provider default.
SLATE_STT_LANGUAGE=zh
```

Restart both the Slate backend and Hermes Gateway after changing the values.
The backend disables the two Agent polling endpoints in production when
`HERMES_AGENT_TOKEN` is missing.

For a Chinese-first Gateway, keep the STT language at `zh` (or set
`stt.language: zh` in Hermes' config). If the device is used bilingually, set
`SLATE_STT_LANGUAGE=auto` and configure the provider's language/auto-detection
policy in Hermes instead.

## Verify

After restarting the Gateway, verify that the plugin list contains
`platforms/slate`, the logs contain `[slate] Connected`, and Hermes can load:

```text
skill_view("slate-platform:slate-device")
```

Set `HERMES_PLUGINS_DEBUG=1` temporarily when plugin discovery needs verbose
diagnostics. Never print the complete shared token in logs or chat.
