# Picoclaw

Community Cloud comes with Picoclaw to enable an AI chatbot interface. It can use MCP servers: Twenty's is configured, switched off, and is turned on from the console. Discovering servers by itself is off too.

We're currently working towards full cluster control via Chatbot. In particular, understanding issues at the cluster level and being able to correlate various types of data.

# Setup

Install the `picoclaw` package, or the bundle of the same name:

```
community-cloud run-bundle picoclaw server-1 cc.config.json
```

Its console is on `values.domain.agent`, behind Authentik: the package puts an oauth2-proxy gate in front of it. Once through, the console asks for its own token, which is the `password` in the `picoclaw-launcher` Secret.

`Picoclaw.config.yaml` is the configuration it starts with, the first time only. After that it's whatever the console last saved, on its volume. `config.json` here is the same configuration, for reading.
