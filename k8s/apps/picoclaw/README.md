# Picoclaw

Community Cloud comes with Picoclaw to enable an AI chatbot interace. This is designed to integrate automatically with available MCP servers.

We're currently working towards full cluster control via Chatbot. In particular, understanding issues at the cluster level and being able to correlate various types of data.

# Setup


```
kubectl apply -f ./Picoclaw.storage.yaml
kubectl apply -f ./Picoclaw.config.yaml
kubectl apply -f ./Picoclaw.deployment.yaml
kubectl apply -f ./Picoclaw.route.yaml
```
