```
npm install
npm run dev
```

Open a door:

```
curl -H "Authorization: $AUTH_KEY" "http://localhost:8787/open?action=both"
```

This starts a Cloudflare Workflow and returns an `instanceId`. Check progress:

```
curl -H "Authorization: $AUTH_KEY" "http://localhost:8787/open/<instanceId>"
```

```
npm run deploy
```
