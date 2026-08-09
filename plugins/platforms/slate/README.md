# Slate Hermes platform plugin

This adapter long-polls the Slate backend, sends each ink-screen request into a
single Hermes direct-message session, and posts the final reply back to the
waiting device.

## Install

Copy this directory into the Hermes Agent checkout:

```bash
cp -R plugins/platforms/slate ~/.hermes/hermes-agent/plugins/platforms/
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
