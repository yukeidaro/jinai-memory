export function createEventHub() {
  const subscribers = new Set();

  function remove(client) {
    clearInterval(client.timer);
    subscribers.delete(client);
    client.res.off("close", client.cleanup);
    client.res.off("error", client.cleanup);
  }

  function send(client, data) {
    if (client.res.write(data) === false) {
      // Flush the accepted event before closing a slow reader.
      remove(client);
      client.res.end();
    }
  }

  return {
    publish(event) {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      for (const client of subscribers) {
        if (client.user === event.user) send(client, data);
      }
    },

    subscribe(res, { user }) {
      if (subscribers.size >= 50) {
        res.writeHead(503, {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        });
        res.end("Too many event subscribers.");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });
      const client = { res, user };
      client.cleanup = () => remove(client);
      client.timer = setInterval(() => send(client, ": ping\n\n"), 15_000);
      client.timer.unref();
      res.on("close", client.cleanup);
      res.on("error", client.cleanup);
      subscribers.add(client);
      send(client, ": connected\n\n");
    },

    size() {
      return subscribers.size;
    },
  };
}
