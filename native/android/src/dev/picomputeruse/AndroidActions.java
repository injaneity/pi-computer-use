package dev.picomputeruse;

import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.concurrent.*;
import org.json.JSONArray;
import org.json.JSONObject;

/** One device lane executes these operations. Unknown delivery is never retried here. */
final class AndroidActions {
    private final ComputerUseService service;
    AndroidActions(ComputerUseService service) { this.service = service; }

    JSONObject act(JSONObject args, BridgeServer.Guard guard) throws Exception {
        return batch(new JSONObject().put("actions", new JSONArray().put(args)), guard).getJSONArray("steps").getJSONObject(0);
    }

    JSONObject batch(JSONObject args, BridgeServer.Guard guard) throws Exception {
        JSONArray actions = args.getJSONArray("actions");
        if (actions.length() < 1 || actions.length() > 20) throw new IllegalArgumentException("invalid_request: expected 1 to 20 actions");
        String lookId = actions.getJSONObject(0).getString("lookId");
        ComputerUseService.Observation observation = service.observation(lookId, true);
        for (int i = 0; i < actions.length(); i++) {
            JSONObject action = actions.getJSONObject(i);
            if (!lookId.equals(action.getString("lookId"))) throw new IllegalArgumentException("invalid_request: batch must share one lookId");
            validate(action, observation);
        }
        UiSnapshot current = service.snapshot(observation.snapshot.rootRef);
        requireUnchanged(observation.snapshot, current);
        guard.check();
        service.invalidateWrites();
        JSONArray steps = new JSONArray();
        String outcome = "worked";
        int stoppedAt = -1;
        for (int i = 0; i < actions.length(); i++) {
            JSONObject result;
            try {
                guard.check();
                UiSnapshot before = service.snapshot(observation.snapshot.rootRef);
                requireUnchanged(current, before);
                result = execute(actions.getJSONObject(i), observation, before, guard);
                current = service.snapshot(observation.snapshot.rootRef);
            } catch (Exception error) {
                // An exception can occur after dispatch. Do not invent a delivery class or claim no delivery.
                result = new JSONObject().put("outcome", "unknown")
                    .put("evidence", new JSONObject().put("reason", "Execution stopped: " + error.getMessage()));
                String message = error.getMessage() == null ? "Native failure" : error.getMessage();
                String code = message.contains(":") ? message.substring(0, message.indexOf(':')) : "execution_unknown";
                result.put("error", new JSONObject().put("code", code).put("message", message));
            }
            steps.put(result);
            outcome = result.getString("outcome");
            if (!outcome.equals("worked")) { stoppedAt = i; break; }
        }
        JSONObject result = new JSONObject().put("outcome", outcome).put("steps", steps)
            .put("performed", new JSONObject().put("transaction", true).put("actionCount", steps.length()));
        if (stoppedAt >= 0) result.put("stoppedAt", stoppedAt);
        return result;
    }

    private void validate(JSONObject action, ComputerUseService.Observation observation) throws Exception {
        String name = action.getString("action");
        JSONObject params = action.optJSONObject("params");
        if (params == null) params = new JSONObject();
        String policy = action.optString("policy", "default");
        if (!(policy.equals("foreground") || policy.equals("default") || policy.equals("background") || policy.equals("ax_only")))
            throw new IllegalArgumentException("invalid_request: invalid delivery policy");
        JSONObject target = action.getJSONObject("target");
        boolean physical = !target.has("ref") || name.equals("drag");
        if (policy.equals("background") || policy.equals("ax_only"))
            throw new IllegalStateException("foreground_required: Android preview does not guarantee focus-preserving background actions");
        if (physical && !name.equals("click") && !name.equals("press") && !name.equals("drag"))
            throw new IllegalArgumentException("unsupported_operation: use a scrollable ref for scroll, or drag.path for a swipe");
        if (observation.snapshot.truncated) throw new IllegalStateException("incomplete_observation: act only from a complete UI observation");
        if (!name.equals("press") && !name.equals("click") && !name.equals("setText") && !name.equals("scroll") && !name.equals("drag"))
            throw new IllegalArgumentException("unsupported_operation: " + name + " is not available in the initial Android preview");
        if (!params.optString("button", "left").equals("left") || params.optInt("clickCount", 1) != 1)
            throw new IllegalArgumentException("unsupported_operation: only a single primary click is supported");
        if (name.equals("setText") && (!target.has("ref") || !params.has("text") || params.getString("text").length() > 8192))
            throw new IllegalArgumentException("invalid_request: setText needs a ref and at most 8192 characters");
        if (target.has("ref") && !observation.snapshot.nodes.containsKey(target.getString("ref")))
            throw new IllegalArgumentException("stale_element: ref does not belong to this observation");
        if (physical && !observation.image) throw new IllegalStateException("image_required: coordinate input requires an image-bearing observation");
        if (name.equals("drag")) {
            JSONArray path = params.getJSONArray("path");
            if (path.length() < 2 || path.length() > 100) throw new IllegalArgumentException("invalid_request: drag path needs 2 to 100 points");
            for (int i = 0; i < path.length(); i++) point(path.getJSONObject(i), observation);
        } else if (!target.has("ref")) point(target.has("focus") ? target.getJSONObject("focus") : target, observation);
    }

    private JSONObject execute(JSONObject action, ComputerUseService.Observation observation, UiSnapshot before, BridgeServer.Guard guard) throws Exception {
        String name = action.getString("action");
        JSONObject target = action.getJSONObject("target");
        JSONObject params = action.optJSONObject("params"); if (params == null) params = new JSONObject();
        AccessibilityWindowInfo window = service.window(before.rootRef);
        if (!window.isActive() && !window.isFocused()) throw new IllegalStateException("foreground_required: open the target app manually before acting");
        if (!target.has("ref") || name.equals("drag")) return gesture(action, observation, before, guard);
        AccessibilityNodeInfo node = observation.snapshot.resolve(window, target.getString("ref"));
        int nativeAction;
        Bundle arguments = null;
        switch (name) {
            case "setText":
                nativeAction = AccessibilityNodeInfo.ACTION_SET_TEXT;
                arguments = new Bundle(); arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, params.getString("text"));
                break;
            case "press": case "click": nativeAction = AccessibilityNodeInfo.ACTION_CLICK; break;
            case "scroll":
                double x = params.optDouble("scrollX", 0), y = params.optDouble("scrollY", 0);
                if (x != 0 || y == 0 || !Double.isFinite(y)) throw new IllegalArgumentException("unsupported_operation: initial semantic scroll supports vertical direction only");
                nativeAction = y > 0 ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD;
                break;
            default: throw new IllegalArgumentException("unsupported_operation: " + name);
        }
        if (!UiSnapshot.has(node, nativeAction)) throw new IllegalArgumentException("unsupported_operation: target does not advertise this action");
        guard.check();
        boolean delivered = node.performAction(nativeAction, arguments);
        if (!delivered) return result("unknown", false, "Accessibility action returned false; side effects are not ruled out.");
        Thread.sleep(150); guard.check();
        if (name.equals("setText")) {
            AccessibilityNodeInfo after = observation.snapshot.resolve(service.window(before.rootRef), target.getString("ref"));
            return result(params.getString("text").equals(UiSnapshot.string(after.getText())) ? "worked" : "unknown", true, "Compared the target's text after delivery.");
        }
        UiSnapshot after = service.snapshot(before.rootRef);
        // State change is evidence, not proof of an arbitrary button's application-level meaning.
        return result("unknown", true, before.fingerprint.equals(after.fingerprint)
            ? "Action accepted; no verified result. Use an explicit postcondition."
            : "UI changed after delivery; use an explicit postcondition to confirm the requested result.");
    }

    private JSONObject gesture(JSONObject action, ComputerUseService.Observation observation, UiSnapshot before, BridgeServer.Guard guard) throws Exception {
        AccessibilityWindowInfo window = service.window(before.rootRef);
        if (!window.isActive()) throw new IllegalStateException("foreground_required: target window is not active");
        Path path = new Path();
        JSONArray points = action.getString("action").equals("drag") ? action.getJSONObject("params").getJSONArray("path")
            : new JSONArray().put(action.getJSONObject("target").has("focus") ? action.getJSONObject("target").getJSONObject("focus") : action.getJSONObject("target"));
        float[][] screenPoints = new float[points.length()][];
        for (int i = 0; i < points.length(); i++) {
            float[] xy = point(points.getJSONObject(i), observation);
            screenPoints[i] = xy;
            if (i == 0) path.moveTo(xy[0], xy[1]); else path.lineTo(xy[0], xy[1]);
        }
        // Check every segment, including overlay crossings between two unobscured endpoints.
        // Status bars, the keyboard and floating windows still block any intersecting touch path.
        for (AccessibilityWindowInfo other : service.windows()) {
            if (other.getId() == window.getId() || other.getLayer() <= window.getLayer()) continue;
            Rect bounds = new Rect(); other.getBoundsInScreen(bounds);
            if (TouchGeometry.intersects(screenPoints, bounds.left, bounds.top, bounds.right, bounds.bottom))
                throw new IllegalStateException("target_occluded: another window overlaps the touch path");
        }
        GestureDescription gesture = new GestureDescription.Builder().setDisplayId(before.displayId)
            .addStroke(new GestureDescription.StrokeDescription(path, 0, points.length() == 1 ? 80 : 400)).build();
        CompletableFuture<Boolean> completion = new CompletableFuture<>();
        guard.check();
        boolean dispatched = service.dispatchGesture(gesture, new android.accessibilityservice.AccessibilityService.GestureResultCallback() {
            @Override public void onCompleted(GestureDescription gesture) { completion.complete(true); }
            @Override public void onCancelled(GestureDescription gesture) { completion.complete(false); }
        }, null);
        boolean completed = false;
        if (dispatched) {
            // Retain the device lane until this physical gesture has settled, even after cancellation.
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
            boolean interrupted = false;
            try {
                while (true) {
                    try { completed = completion.get(Math.max(1, deadline - System.nanoTime()), TimeUnit.NANOSECONDS); break; }
                    catch (InterruptedException error) { interrupted = true; }
                }
            } finally { if (interrupted) Thread.currentThread().interrupt(); }
        }
        JSONObject result = result("unknown", completed, "Gesture delivery is not proof of application success. Observe and check the postcondition.");
        result.getJSONObject("performed").put("delivery", "hid").put("grounding", "coordinates");
        return result;
    }

    private static float[] point(JSONObject point, ComputerUseService.Observation observation) throws Exception {
        double x = point.getDouble("x"), y = point.getDouble("y");
        if (!Double.isFinite(x) || !Double.isFinite(y) || x < 0 || y < 0 || x >= observation.width || y >= observation.height)
            throw new IllegalArgumentException("invalid_coordinates: point outside observation image");
        return new float[] {(float)(observation.snapshot.bounds.left + x * observation.snapshot.bounds.width() / observation.width),
            (float)(observation.snapshot.bounds.top + y * observation.snapshot.bounds.height() / observation.height)};
    }
    private static void requireUnchanged(UiSnapshot expected, UiSnapshot current) {
        if (!current.rootRef.equals(expected.rootRef) || !current.packageName.equals(expected.packageName)
            || !current.fingerprint.equals(expected.fingerprint) || current.rotation != expected.rotation || !current.bounds.equals(expected.bounds))
            throw new IllegalStateException("stale_state: UI changed; observe again before acting");
    }
    private static JSONObject result(String outcome, boolean delivered, String reason) throws Exception {
        return new JSONObject().put("outcome", outcome).put("performed", new JSONObject().put("delivery", "ax").put("grounding", "description"))
            .put("evidence", new JSONObject().put("delivered", delivered).put("reason", reason));
    }
}
