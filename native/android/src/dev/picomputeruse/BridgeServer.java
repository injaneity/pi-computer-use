package dev.picomputeruse;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

/** Bounded, loopback-only transport. No action retry, no credential logging. */
public final class BridgeServer implements AutoCloseable {
    public interface Handler { JSONObject handle(String command, JSONObject args, Guard guard) throws Exception; }
    public interface Guard { void check() throws Exception; }
    public static final int PORT = 39871;
    private static final int MAX_REQUEST_BYTES = 256 * 1024;
    private final ServerSocket listener;
    private final String secret;
    private final Handler handler;
    private final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
    private final AtomicInteger connections = new AtomicInteger();
    private final ExecutorService clients = Executors.newFixedThreadPool(4);
    private final ExecutorService device;
    private volatile boolean closed;

    public BridgeServer(String secret, Handler handler, ExecutorService device) throws IOException {
        if (!Auth.validSecret(secret)) throw new IllegalArgumentException("Pairing required");
        this.secret = secret;
        this.handler = handler;
        this.device = device;
        listener = new ServerSocket();
        listener.setReuseAddress(true);
        listener.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 4);
        Thread thread = new Thread(this::accept, "pi-cu-listener");
        thread.setDaemon(true);
        thread.start();
    }

    private void accept() {
        while (!closed) {
            try {
                Socket socket = listener.accept();
                if (!socket.getInetAddress().isLoopbackAddress()) { socket.close(); continue; }
                if (connections.incrementAndGet() > 4) {
                    connections.decrementAndGet(); socket.close(); continue;
                }
                sockets.add(socket);
                try { clients.execute(() -> serve(socket)); }
                catch (RejectedExecutionException error) { sockets.remove(socket); connections.decrementAndGet(); socket.close(); }
            } catch (IOException error) { if (closed) return; }
        }
    }

    private void serve(Socket socket) {
        try (Socket ignored = socket) {
            socket.setSoTimeout(5000);
            InputStream input = new BufferedInputStream(socket.getInputStream());
            OutputStream output = new BufferedOutputStream(socket.getOutputStream());
            JSONObject hello = read(input, 2048);
            if (hello.optInt("protocolVersion") != 1 || !Auth.validSecret(hello.optString("nonce"))) return;
            String serverNonce = Auth.randomHex();
            send(output, new JSONObject().put("protocolVersion", 1).put("nonce", serverNonce)
                .put("proof", Auth.proof(secret, "server", hello.getString("nonce"))));
            JSONObject auth = read(input, 2048);
            if (!Auth.verify(secret, "client", serverNonce, auth.optString("proof"))) return;
            send(output, new JSONObject().put("authenticated", true));
            socket.setSoTimeout(120000);
            long lastId = 0;
            while (!closed) {
                JSONObject request = read(input, MAX_REQUEST_BYTES);
                long id = request.optLong("id", -1);
                if (id <= lastId || request.optInt("protocolVersion") != 1) return;
                lastId = id;
                String command = request.getString("cmd");
                JSONObject args = request.optJSONObject("args");
                if (args == null) args = new JSONObject();
                final JSONObject commandArgs = args;
                long timeout = Math.min(30000, Math.max(100, request.optLong("timeoutMs", 10000)));
                long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeout);
                Guard guard = () -> {
                    if (closed || socket.isClosed() || Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline)
                        throw new IllegalStateException("request_expired: no further actions allowed");
                };
                Future<JSONObject> future = device.submit(() -> { guard.check(); return handler.handle(command, commandArgs, guard); });
                // One command per connection. EOF, extra input or disconnect cancels queued work.
                Thread cancellation = new Thread(() -> {
                    try { input.read(); } catch (IOException ignoredRead) {}
                    future.cancel(true);
                    try { socket.close(); } catch (IOException ignoredClose) {}
                }, "pi-cu-cancel");
                cancellation.setDaemon(true);
                cancellation.start();
                JSONObject response = new JSONObject().put("protocolVersion", 1).put("id", id);
                try {
                    response.put("ok", true).put("result", future.get(timeout, TimeUnit.MILLISECONDS));
                } catch (TimeoutException error) {
                    future.cancel(true);
                    response.put("ok", false).put("error", error("execution_unknown", "Request timed out. Observe again; never replay an action."));
                } catch (ExecutionException error) {
                    Throwable cause = error.getCause();
                    String message = cause.getMessage() == null ? "Native request failed" : cause.getMessage();
                    String code = message.contains(":") ? message.substring(0, message.indexOf(':')) : "native_error";
                    if (!code.matches("[a-z_]+")) code = "native_error";
                    response.put("ok", false).put("error", error(code, message));
                }
                send(output, response);
                return;
            }
        } catch (Exception ignored) {
            // An unauthenticated peer receives no diagnostics or UI content.
        } finally {
            sockets.remove(socket); connections.decrementAndGet();
        }
    }

    private static JSONObject error(String code, String message) throws Exception {
        return new JSONObject().put("code", code).put("message", message);
    }

    private static JSONObject read(InputStream input, int limit) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (int value; (value = input.read()) != -1;) {
            if (value == '\n') return new JSONObject(bytes.toString("UTF-8"));
            if (bytes.size() >= limit) throw new IOException("Request too large");
            bytes.write(value);
        }
        throw new EOFException();
    }

    private static void send(OutputStream output, JSONObject value) throws IOException {
        output.write((value.toString() + "\n").getBytes(StandardCharsets.UTF_8)); output.flush();
    }

    @Override public void close() {
        closed = true;
        try { listener.close(); } catch (IOException ignored) {}
        for (Socket socket : sockets) { try { socket.close(); } catch (IOException ignored) {} }
        clients.shutdownNow();
        // The service owns the device lane so re-pairing cannot create a concurrent writer.
    }
}
