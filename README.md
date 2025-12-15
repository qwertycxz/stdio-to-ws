# stdio-to-ws

Redirect stdio to WebSocket.

## Usage

```bash
npx stdio-to-ws "stdio command" --port 3000
```

Example:

```bash
npx stdio-to-ws "npx @google/gemini-cli --experimental-acp" --port 3000
```

### Options

```
-p, --port <port>         Port to listen on (default: 3000)
--persist                 Keep child process alive during disconnections
-g, --grace-period <ms>   Time before killing disconnected process (default: 30000)
-q, --quiet               Suppress logging output
-h, --help                Show help message
```

### Persistence Mode

Use `--persist` to keep the child process alive during brief disconnections (e.g., iOS app backgrounding):

```bash
npx stdio-to-ws --persist "python my-script.py"
```

When enabled:

- Server sends `{"type": "connected", "clientId": "..."}` on new connection
- Client saves the `clientId` and sends it via `X-Client-Id` header on reconnect
- Messages are buffered during disconnection and replayed on reconnect

## License

Apache 2.0
