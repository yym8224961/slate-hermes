# Slate Hermes platform plugin

This adapter long-polls the Slate backend, sends each ink-screen device into its
own Hermes direct-message session, and posts the final reply back to the
waiting device. When Hermes loads the plugin, it registers both the `slate`
Gateway platform and the namespaced `slate-platform:slate-device` skill.

The platform handles transport. The skill contains device capabilities,
response constraints, configuration guidance, and diagnostics.

Voice requests arrive as base64 PCM16 in the pending payload. The adapter wraps
them as 16 kHz mono WAV and stores the file in Hermes' audio cache. Hermes'
normal Gateway pipeline performs STT once in its background session; the final
delivery reads that same event transcript and returns it to Slate, so the device
shows what Hermes actually heard instead of a generic voice placeholder. Stream
previews and busy/interim messages never resolve the one-shot device request.
Text requests keep the existing `MessageType.TEXT` path.

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
```

Restart both the Slate backend and Hermes Gateway after changing the values.
The backend disables the two Agent polling endpoints in production when
`HERMES_AGENT_TOKEN` is missing.

For a Chinese-first Gateway, set both the global and selected-provider language
to `zh` in Hermes' STT configuration. Language selection belongs to Hermes'
normal STT pipeline; the Slate adapter does not mutate process-global STT
environment variables.

## Verify

After restarting the Gateway, verify that the plugin list contains
`platforms/slate`, the logs contain `[slate] Polling`, Slate's Web status changes
to connected after an authenticated poll, and Hermes can load:

```text
skill_view("slate-platform:slate-device")
```

Set `HERMES_PLUGINS_DEBUG=1` temporarily when plugin discovery needs verbose
diagnostics. Never print the complete shared token in logs or chat.
