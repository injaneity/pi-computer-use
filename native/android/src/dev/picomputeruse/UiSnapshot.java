package dev.picomputeruse;

import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.json.JSONArray;
import org.json.JSONObject;

/** Detached observation. Live node handles never enter the snapshot store. */
public final class UiSnapshot {
    public static final int MAX_NODES = 2000;
    private static final int MAX_DEPTH = 40;
    public static final class Node {
        final String path, identity, text, description, role;
        final Rect bounds;
        final boolean password, editable, checked;
        Node(String path, AccessibilityNodeInfo node, JSONObject json) {
            this.path = path; this.identity = identity(node); this.password = node.isPassword();
            this.text = json.optString("value"); this.description = json.optString("title");
            this.editable = node.isEditable(); this.checked = node.isChecked();
            this.bounds = new Rect(); node.getBoundsInScreen(bounds);
            this.role = role(node);
        }
    }
    final String rootRef, packageName, treeJson, fingerprint;
    final int windowId, displayId, rotation;
    final Rect bounds;
    final Map<String, Node> nodes;
    final boolean truncated;
    final String refPrefix = UUID.randomUUID().toString() + ":";
    private final long deadline = System.nanoTime() + 4000000000L;
    private int childVisits;
    private int textBudget = 256 * 1024;
    private boolean cut;
    private final LinkedHashMap<String, Node> building = new LinkedHashMap<>();

    public UiSnapshot(AccessibilityWindowInfo window, String rootRef, int rotation) throws Exception {
        AccessibilityNodeInfo root = window.getRoot();
        if (root == null) throw new IllegalStateException("window_unavailable: no accessible root");
        this.rootRef = rootRef; windowId = window.getId(); displayId = window.getDisplayId(); this.rotation = rotation;
        packageName = string(root.getPackageName()); bounds = new Rect(); window.getBoundsInScreen(bounds);
        JSONObject tree = visit(root, "0", 0);
        treeJson = tree.toString(); fingerprint = digest(treeJson);
        nodes = Collections.unmodifiableMap(new LinkedHashMap<>(building)); truncated = cut;
    }

    private JSONObject visit(AccessibilityNodeInfo node, String path, int depth) throws Exception {
        if (System.nanoTime() >= deadline || Thread.currentThread().isInterrupted()) throw new IllegalStateException("observation_timeout: UI tree traversal exceeded its budget");
        Rect rect = new Rect(); node.getBoundsInScreen(rect);
        if (!rect.intersect(bounds)) rect.set(bounds.left, bounds.top, bounds.left, bounds.top);
        boolean hidden = node.isPassword();
        boolean press = has(node, AccessibilityNodeInfo.ACTION_CLICK);
        boolean set = has(node, AccessibilityNodeInfo.ACTION_SET_TEXT) && !hidden;
        JSONObject json = new JSONObject().put("ref", path).put("role", role(node)).put("subrole", bounded(node.getClassName()))
            .put("nativeIdentity", identity(node))
            .put("identifier", bounded(node.getViewIdResourceName())).put("title", hidden ? "" : bounded(node.getContentDescription()))
            .put("description", hidden ? "Protected input" : bounded(node.getHintText()))
            .put("value", hidden ? "" : bounded(node.getText())).put("canPress", press && node.isEnabled() && !hidden)
            .put("canFocus", node.isFocusable() && !hidden).put("canSetValue", set && node.isEnabled())
            .put("canScroll", node.isScrollable()).put("isTextInput", node.isEditable() && !hidden)
            .put("focused", node.isFocused()).put("offscreen", !node.isVisibleToUser()).put("checked", node.isChecked())
            .put("enabled", node.isEnabled()).put("password", hidden)
            .put("rect", rect(rect.left - bounds.left, rect.top - bounds.top, rect.width(), rect.height()))
            .put("actions", new JSONArray());
        if (press && !hidden) json.getJSONArray("actions").put("press");
        if (set) json.getJSONArray("actions").put("setText");
        if (node.isScrollable()) json.getJSONArray("actions").put("scroll");
        building.put(refPrefix + path, new Node(path, node, json));
        JSONArray children = new JSONArray();
        int childCount = node.getChildCount();
        boolean truncatedHere = false;
        for (int i = 0; i < childCount; i++) {
            if (building.size() >= MAX_NODES || ++childVisits > MAX_NODES * 2 || depth >= MAX_DEPTH || textBudget <= 0) { cut = true; truncatedHere = true; break; }
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) children.put(visit(child, path + "." + i, depth + 1));
        }
        json.put("truncated", truncatedHere).put("children", children);
        return json;
    }

    private String bounded(CharSequence raw) {
        String text = string(raw);
        int length = Math.min(text.length(), Math.min(8192, Math.max(0, textBudget)));
        if (length < text.length()) cut = true;
        textBudget -= length;
        return text.substring(0, length);
    }

    public JSONObject outline(double scaleX, double scaleY) throws Exception {
        JSONObject tree = new JSONObject(treeJson);
        scale(tree, scaleX, scaleY, refPrefix);
        return tree;
    }

    private static void scale(JSONObject node, double sx, double sy, String prefix) throws Exception {
        node.put("ref", prefix + node.getString("ref"));
        node.remove("nativeIdentity");
        JSONObject r = node.getJSONObject("rect");
        r.put("x", r.getDouble("x") * sx).put("y", r.getDouble("y") * sy)
            .put("w", r.getDouble("w") * sx).put("h", r.getDouble("h") * sy);
        JSONArray children = node.getJSONArray("children");
        for (int i = 0; i < children.length(); i++) scale(children.getJSONObject(i), sx, sy, prefix);
    }

    public AccessibilityNodeInfo resolve(AccessibilityWindowInfo window, String ref) {
        Node expected = nodes.get(ref);
        if (expected == null) throw new IllegalStateException("stale_element: ref does not belong to this observation");
        AccessibilityNodeInfo node = window.getRoot();
        String[] path = expected.path.split("\\.");
        for (int i = 1; i < path.length && node != null; i++) node = node.getChild(Integer.parseInt(path[i]));
        if (node == null || !node.refresh() || !expected.identity.equals(identity(node)))
            throw new IllegalStateException("stale_element: target identity changed");
        if (!expected.editable && (!expected.text.equals(string(node.getText())) || !expected.description.equals(string(node.getContentDescription()))))
            throw new IllegalStateException("stale_element: target label changed");
        if (node.isPassword()) throw new IllegalStateException("protected_input: password fields are not supported");
        if (!node.isEnabled() || !node.isVisibleToUser()) throw new IllegalStateException("target_unavailable: target is not visible and enabled");
        return node;
    }

    static boolean has(AccessibilityNodeInfo node, int action) {
        for (AccessibilityNodeInfo.AccessibilityAction item : node.getActionList()) if (item.getId() == action) return true;
        return false;
    }
    static String identity(AccessibilityNodeInfo node) {
        return shortString(node.getPackageName()) + "|" + shortString(node.getClassName()) + "|" + shortString(node.getViewIdResourceName()) + "|" + shortString(node.getUniqueId());
    }
    static String role(AccessibilityNodeInfo node) {
        if (node.isEditable()) return "AXTextField";
        if (node.isCheckable()) return "AXCheckBox";
        if (node.isClickable()) return "AXButton";
        if (node.isScrollable()) return "AXScrollArea";
        if (node.getText() != null) return "AXStaticText";
        return "AXGroup";
    }
    static String string(CharSequence value) { return value == null ? "" : value.toString(); }
    private static String shortString(CharSequence value) { String text = string(value); return text.substring(0, Math.min(1024, text.length())); }
    static JSONObject rect(double x, double y, double width, double height) throws Exception {
        return new JSONObject().put("x", x).put("y", y).put("w", Math.max(0, width)).put("h", Math.max(0, height));
    }
    static JSONObject rect(Rect rect) throws Exception { return rect(rect.left, rect.top, rect.width(), rect.height()); }
    private static String digest(String value) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        return java.util.Base64.getEncoder().encodeToString(bytes);
    }
}
