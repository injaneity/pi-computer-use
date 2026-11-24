package dev.picomputeruse;

import android.accessibilityservice.AccessibilityService;
import android.app.KeyguardManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.SystemClock;
import android.util.Base64;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.ByteArrayOutputStream;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONObject;

/** Android owns this service's lifecycle. Enabling it requires the user's system-settings action. */
public final class ComputerUseService extends AccessibilityService {
    private static volatile ComputerUseService instance;
    private static volatile String status = "";
    private BridgeServer server;
    // Shared across service reconnections and re-pairing, including cancelled in-flight requests.
    private static final ExecutorService DEVICE = Executors.newSingleThreadExecutor();
    private final SnapshotStore<Observation> observations = new SnapshotStore<>(8, 300000, SystemClock::elapsedRealtime);
    private final String generation = UUID.randomUUID().toString();
    // Keyed by window id plus owner identity: a recycled id for a different window still gets a new number.
    private final ConcurrentHashMap<String, Long> windowGenerations = new ConcurrentHashMap<>();
    private final AtomicLong nextWindow = new AtomicLong();
    final AtomicLong eventSequence = new AtomicLong();
    private final AndroidActions actions = new AndroidActions(this);

    static final class Observation {
        final UiSnapshot snapshot;
        final int width, height;
        final boolean image;
        Observation(UiSnapshot snapshot, int width, int height, boolean image) {
            this.snapshot = snapshot; this.width = width; this.height = height; this.image = image;
        }
    }

    public static boolean connected() { return instance != null; }
    public static String status() { return status; }
    public static void reload() { ComputerUseService service = instance; if (service != null) service.configure(); }
    @Override protected void onServiceConnected() { instance = this; configure(); }
    private synchronized void configure() {
        if (server != null) { server.close(); server = null; }
        observations.clear();
        String secret = getSharedPreferences("bridge", MODE_PRIVATE).getString("secret", "");
        if (!getSharedPreferences("bridge", MODE_PRIVATE).getBoolean("enabled", false) || !Auth.validSecret(secret)) { status = "等待用户配对并启用"; return; }
        try { server = new BridgeServer(secret, this::handle, DEVICE); status = "本机连接已就绪"; }
        catch (Exception error) { status = "无法监听本机端口，请检查端口占用"; }
    }
    @Override public void onDestroy() {
        if (server != null) server.close(); observations.clear(); instance = null; status = "服务已关闭"; super.onDestroy();
    }
    @Override public void onInterrupt() { /* Feedback interruption is not an authorization grant. */ }
    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        eventSequence.incrementAndGet();
        if (event.getEventType() == AccessibilityEvent.TYPE_WINDOWS_CHANGED && (event.getWindowChanges() & AccessibilityEvent.WINDOWS_CHANGE_REMOVED) != 0) {
            String prefix = event.getWindowId() + "|";
            windowGenerations.keySet().removeIf(key -> key.startsWith(prefix));
        }
    }

    private JSONObject handle(String command, JSONObject args, BridgeServer.Guard transportGuard) throws Exception {
        BridgeServer.Guard guard = () -> {
            transportGuard.check();
            if (instance != this || !getSharedPreferences("bridge", MODE_PRIVATE).getBoolean("enabled", false))
                throw new IllegalStateException("service_disabled: control is paused");
            KeyguardManager keyguard = (KeyguardManager)getSystemService(KEYGUARD_SERVICE);
            if (keyguard.isKeyguardLocked()) throw new IllegalStateException("device_locked: unlock manually before using computer use");
        };
        guard.check();
        if (command.equals("diagnostics")) return diagnostics();
        switch (command) {
            case "listRoots": return new JSONObject().put("roots", roots());
            case "look": return look(args, guard);
            case "readText": return readText(args);
            case "waitFor": return waitFor(args, guard);
            case "act": return actions.act(args, guard);
            case "actBatch": return actions.batch(args, guard);
            default: throw new IllegalArgumentException("unsupported_operation: " + command);
        }
    }

    private JSONObject diagnostics() throws Exception {
        return new JSONObject().put("protocolVersion", 1).put("architectureVersion", 1)
            .put("invariants", new JSONArray(Arrays.asList("state-scoped-observations", "bounded-observation-history", "multi-root-forest",
                "progressive-disclosure", "atomic-physical-input", "concurrent-requests", "transactional-batching")))
            .put("pid", android.os.Process.myPid()).put("os", "android").put("sdk", Build.VERSION.SDK_INT)
            .put("arch", Build.SUPPORTED_ABIS[0]).put("sessionId", generation).put("accessibility", true)
            .put("screenRecording", true).put("preview", true)
            .put("capabilities", new JSONArray(Arrays.asList("roots", "outline", "windowScreenshot", "readText", "waitFor", "setText", "press", "scroll", "drag")));
    }

    String rootRef(AccessibilityWindowInfo window, AccessibilityNodeInfo root) {
        if (windowGenerations.size() > 512) windowGenerations.clear();
        String key = window.getId() + "|" + (root == null ? "" : UiSnapshot.string(root.getPackageName()))
            + "|" + UiSnapshot.string(window.getTitle());
        long number = windowGenerations.computeIfAbsent(key, ignored -> nextWindow.incrementAndGet());
        return "android:" + generation + ":" + number + ":" + window.getId();
    }

    String rootRef(AccessibilityWindowInfo window) { return rootRef(window, window.getRoot()); }

    List<AccessibilityWindowInfo> windows() {
        List<AccessibilityWindowInfo> windows = new ArrayList<>(getWindows());
        windows.removeIf(window -> window.getDisplayId() != Display.DEFAULT_DISPLAY);
        if (windows.size() > 256) throw new IllegalStateException("window_limit: too many interactive windows");
        return windows;
    }

    JSONArray roots() throws Exception {
        JSONArray roots = new JSONArray();
        for (AccessibilityWindowInfo window : windows()) {
            AccessibilityNodeInfo root = window.getRoot();
            if (root == null || (MainActivity.isVisible() && getPackageName().contentEquals(UiSnapshot.string(root.getPackageName())))) continue;
            Rect frame = new Rect(); window.getBoundsInScreen(frame);
            String packageName = UiSnapshot.string(root.getPackageName());
            String title = UiSnapshot.string(window.getTitle());
            String kind = window.getType() == AccessibilityWindowInfo.TYPE_APPLICATION ? "window" : "popover";
            String ref = rootRef(window, root);
            roots.put(new JSONObject().put("kind", kind).put("rootRef", ref).put("windowRef", ref)
                .put("windowId", window.getId()).put("appName", packageName).put("bundleId", packageName)
                .put("title", title.isEmpty() ? packageName : title).put("zOrder", -window.getLayer())
                .put("framePoints", UiSnapshot.rect(frame)).put("scaleFactor", 1).put("isOnscreen", true)
                .put("isFocused", window.isFocused()).put("isMain", window.isActive()).put("isMinimized", false).put("isModal", false)
                .put("metadata", new JSONObject().put("displayId", window.getDisplayId()).put("androidWindowType", window.getType())
                    .put("active", window.isActive()).put("sessionId", generation)));
        }
        return roots;
    }

    AccessibilityWindowInfo window(String rootRef) {
        if (rootRef == null || rootRef.isEmpty()) throw new IllegalArgumentException("invalid_target: rootRef required");
        for (AccessibilityWindowInfo window : windows()) if (rootRef(window).equals(rootRef)) return window;
        throw new IllegalStateException("stale_root: window is no longer available");
    }

    UiSnapshot snapshot(String rootRef) throws Exception {
        AccessibilityWindowInfo window = window(rootRef);
        Display display = ((DisplayManager)getSystemService(Context.DISPLAY_SERVICE)).getDisplay(window.getDisplayId());
        if (display == null) throw new IllegalStateException("display_unavailable: display disappeared");
        UiSnapshot snapshot = new UiSnapshot(window, rootRef, display.getRotation());
        if (MainActivity.isVisible() && getPackageName().equals(snapshot.packageName))
            throw new IllegalStateException("protected_window: pairing and authorization UI cannot be automated");
        return snapshot;
    }

    private JSONObject look(JSONObject args, BridgeServer.Guard guard) throws Exception {
        String root = args.optString("rootRef", args.optString("windowRef"));
        if (!args.optString("scopeRef").isEmpty()) throw new IllegalArgumentException("unsupported_operation: scoped refresh is not implemented in this preview");
        UiSnapshot snapshot = snapshot(root);
        JSONObject image = null;
        String imageError = null;
        if (args.optBoolean("includeImage", true)) {
            try { image = capture(snapshot.windowId, Math.max(256, Math.min(2048, args.optInt("maxDimension", 1280))), guard); }
            catch (ScreenshotFailure error) { imageError = error.getMessage(); }
        }
        UiSnapshot after = snapshot(root);
        if (!after.fingerprint.equals(snapshot.fingerprint) || after.rotation != snapshot.rotation || !after.bounds.equals(snapshot.bounds))
            throw new IllegalStateException("observation_changed: window changed during capture; observe again");
        guard.check();
        int width = image == null ? snapshot.bounds.width() : image.getInt("width");
        int height = image == null ? snapshot.bounds.height() : image.getInt("height");
        if (width <= 0 || height <= 0) throw new IllegalStateException("window_unavailable: empty window bounds");
        Observation observation = new Observation(snapshot, width, height, image != null);
        String lookId = observations.put(observation);
        JSONObject metadata = new JSONObject().put("displayId", snapshot.displayId).put("rotation", snapshot.rotation)
            .put("sessionId", generation).put("truncated", snapshot.truncated);
        if (imageError != null) metadata.put("captureError", imageError);
        JSONObject result = new JSONObject().put("lookId", lookId).put("capturedAt", System.currentTimeMillis() / 1000.0)
            .put("window", new JSONObject().put("windowId", snapshot.windowId).put("rootRef", root)
                .put("kind", "window").put("framePoints", UiSnapshot.rect(snapshot.bounds)).put("scaleFactor", 1)
                .put("isModal", false).put("role", "AXWindow").put("subrole", "").put("metadata", metadata))
            .put("outline", snapshot.outline((double)width / snapshot.bounds.width(), (double)height / snapshot.bounds.height()))
            .put("timings", new JSONObject()).put("readText", new JSONObject().put("requested", args.optString("readText", "auto")).put("executed", false));
        if (image != null) result.put("image", image);
        return result;
    }

    private static final class ScreenshotFailure extends Exception {
        ScreenshotFailure(int code) { super("screenshot_unavailable:" + code); }
    }
    private JSONObject capture(int windowId, int maxDimension, BridgeServer.Guard guard) throws Exception {
        CompletableFuture<ScreenshotResult> future = new CompletableFuture<>();
        takeScreenshotOfWindow(windowId, getMainExecutor(), new TakeScreenshotCallback() {
            @Override public void onSuccess(ScreenshotResult result) { if (!future.complete(result)) result.getHardwareBuffer().close(); }
            @Override public void onFailure(int errorCode) { future.completeExceptionally(new ScreenshotFailure(errorCode)); }
        });
        ScreenshotResult result;
        try { result = future.get(5, TimeUnit.SECONDS); }
        catch (ExecutionException error) {
            if (error.getCause() instanceof ScreenshotFailure) throw (ScreenshotFailure)error.getCause();
            throw error;
        } catch (Exception error) { future.cancel(false); throw error; }
        try (HardwareBuffer buffer = result.getHardwareBuffer()) {
            guard.check();
            Bitmap bitmap = Bitmap.wrapHardwareBuffer(buffer, result.getColorSpace());
            if (bitmap == null) throw new ScreenshotFailure(ERROR_TAKE_SCREENSHOT_INTERNAL_ERROR);
            Bitmap software = null, scaled = null;
            try {
                software = bitmap.copy(Bitmap.Config.ARGB_8888, false);
                double scale = Math.min(1, (double)maxDimension / Math.max(software.getWidth(), software.getHeight()));
                int width = Math.max(1, (int)Math.round(software.getWidth() * scale));
                int height = Math.max(1, (int)Math.round(software.getHeight() * scale));
                scaled = Bitmap.createScaledBitmap(software, width, height, true);
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                if (!scaled.compress(Bitmap.CompressFormat.JPEG, 80, bytes)) throw new ScreenshotFailure(ERROR_TAKE_SCREENSHOT_INTERNAL_ERROR);
                return new JSONObject().put("jpegBase64", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
                    .put("mimeType", "image/jpeg").put("width", width).put("height", height);
            } finally {
                if (scaled != null && scaled != software) scaled.recycle();
                if (software != null) software.recycle(); bitmap.recycle();
            }
        }
    }

    Observation observation(String lookId, boolean writable) { return writable ? observations.requireWritable(lookId) : observations.get(lookId); }
    void invalidateWrites() { observations.invalidateWrites(); }

    private JSONObject readText(JSONObject args) throws Exception {
        Observation observation = observation(args.getString("lookId"), false);
        UiSnapshot.Node node = observation.snapshot.nodes.get(args.getString("elementRef"));
        if (node == null) throw new IllegalArgumentException("stale_element: ref does not belong to the observation");
        String text = node.text.isEmpty() ? node.description : node.text;
        int offset = Math.max(0, Math.min(text.length(), args.optInt("offset", 0)));
        int limit = Math.max(1, Math.min(8000, args.optInt("limit", 4000)));
        int end = Math.min(text.length(), offset + limit);
        return new JSONObject().put("text", text.substring(offset, end)).put("offset", offset).put("limit", limit)
            .put("totalChars", text.length()).put("hasMore", end < text.length());
    }

    private JSONObject waitFor(JSONObject args, BridgeServer.Guard guard) throws Exception {
        String rootRef = args.optString("rootRef", args.optString("windowRef"));
        if (rootRef.isEmpty() && args.has("lookId")) rootRef = observation(args.getString("lookId"), false).snapshot.rootRef;
        String scope = args.optString("scopeRef");
        Observation base = args.has("lookId") ? observation(args.getString("lookId"), false) : null;
        if (base != null && !rootRef.equals(base.snapshot.rootRef)) throw new IllegalArgumentException("stale_state: root does not own this lookId");
        if (!scope.isEmpty() && (base == null || !base.snapshot.nodes.containsKey(scope))) throw new IllegalArgumentException("stale_element: unknown scope");
        String scopePath = scope.isEmpty() ? "" : base.snapshot.nodes.get(scope).path;
        long until = SystemClock.elapsedRealtime() + Math.max(0, Math.min(25000, args.optInt("timeoutMs", 3000)));
        int nodeCount = 0;
        do {
            guard.check();
            UiSnapshot current = snapshot(rootRef);
            if (!scope.isEmpty()) base.snapshot.resolve(window(rootRef), scope);
            nodeCount = current.nodes.size();
            boolean present = false;
            for (UiSnapshot.Node node : current.nodes.values()) {
                if (!scopePath.isEmpty() && !node.path.equals(scopePath) && (args.optBoolean("scopeExact") || !node.path.startsWith(scopePath + "."))) continue;
                String haystack = node.text + " " + node.description;
                if (args.has("text") && !haystack.toLowerCase(Locale.ROOT).contains(args.getString("text").toLowerCase(Locale.ROOT))) continue;
                if (args.has("role") && !node.role.equalsIgnoreCase(args.getString("role"))) continue;
                if (args.has("value") && !node.text.equals(args.getString("value"))) continue;
                present = true; break;
            }
            if (present != args.optBoolean("gone") && (present || !current.truncated))
                return new JSONObject().put("found", true).put("gone", !present).put("nodeCount", nodeCount);
            if (SystemClock.elapsedRealtime() >= until) break;
            Thread.sleep(100);
        } while (true);
        return new JSONObject().put("found", false).put("timedOut", true).put("nodeCount", nodeCount);
    }
}
